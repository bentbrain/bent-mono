import Foundation

/// The device key's state on this iPhone.
public enum KeyState: String, Codable, Sendable {
  /// Enrolled, waiting for the user to confirm on the consent screen. No
  /// Health data is read or sent in this state.
  case consentPending
  /// Confirmed: sync runs.
  case active
  /// Fitness reported the key invalid. The user reconnects to replace it.
  case invalid
}

public struct DeviceCredential: Codable, Sendable, Equatable {
  public var key: String
  public var userId: String
  public var email: String
  public var apiOrigin: String
  public var accountTimezone: String
  public var state: KeyState
}

/// A key waiting to be revoked, with the origin it was issued by.
public struct PendingRevocation: Codable, Sendable, Equatable {
  public var key: String
  public var userId: String
  public var apiOrigin: String
}

/// The one credentials item: the current key and keys still to revoke.
/// Every change replaces the whole item, so a key is never lost between
/// moving it and deleting it.
public struct CredentialDocument: Codable, Sendable, Equatable {
  public var active: DeviceCredential?
  public var pending: [PendingRevocation] = []

  public init(active: DeviceCredential? = nil, pending: [PendingRevocation] = []) {
    self.active = active
    self.pending = pending
  }

  /// Moves the current key to the revocation list.
  mutating func retireActive() {
    guard let active else { return }
    if active.state != .invalid {
      pending.append(PendingRevocation(key: active.key, userId: active.userId, apiOrigin: active.apiOrigin))
    }
    self.active = nil
  }
}

/// The Keychain in the app, memory in tests.
public protocol CredentialStore: Sendable {
  func installationId() throws -> UUID
  func load() throws -> CredentialDocument
  func save(_ document: CredentialDocument) throws
}

/// Where each account's sync state lives.
public protocol StateDirectory: Sendable {
  func storage(for credential: DeviceCredential) -> StateStorage
  /// Removes every account's sync state except the given one's.
  func clear(keeping credential: DeviceCredential?) throws
}

public enum EnrollOutcome: Sendable, Equatable {
  /// Enrolled; the key waits for consent.
  case consentPending(email: String, accountTimezone: String)
  /// Earlier keys still need revoking. Retry, or enroll with `revokeLater`.
  case pendingRevocations(Int)
  /// A newer connect or disconnect replaced this attempt; its key is being revoked.
  case superseded
  case failed(EnrollAction)
}

/// Connects, confirms, disconnects and revokes. Each change bumps the
/// generation, and every step that waited rechecks it before it writes.
public actor DeviceLifecycle {
  private let credentials: CredentialStore
  private let states: StateDirectory
  private let origin: URL
  private let makeAPI: @Sendable (URL) -> FitnessAPI?
  private let deviceName: @Sendable () -> String
  private var generation = 0

  public init(
    credentials: CredentialStore, states: StateDirectory, origin: URL,
    deviceName: @escaping @Sendable () -> String,
    makeAPI: @escaping @Sendable (URL) -> FitnessAPI?
  ) {
    self.credentials = credentials
    self.states = states
    self.origin = origin
    self.deviceName = deviceName
    self.makeAPI = makeAPI
  }

  // MARK: Reading

  public func document() throws -> CredentialDocument { try credentials.load() }

  /// The session sync runs with: an active key for this build's origin.
  public func session() -> SyncSession? {
    guard let active = try? credentials.load().active, active.state == .active,
      active.apiOrigin == origin.absoluteString
    else { return nil }
    return SyncSession(key: active.key, generation: generation)
  }

  public func isCurrent(_ session: SyncSession) -> Bool {
    session.generation == generation && self.session()?.key == session.key
  }

  public func storage() -> StateStorage? {
    guard let active = try? credentials.load().active, active.state == .active else { return nil }
    return states.storage(for: active)
  }

  // MARK: Enrollment

  /// Exchanges a one-time OAuth token for a device key. The key starts in
  /// `consentPending`: nothing is read or sent until `confirm`.
  public func enroll(token: String, revokeLater: Bool) async throws -> EnrollOutcome {
    let remaining = await revokePending()
    if remaining > 0 && !revokeLater { return .pendingRevocations(remaining) }
    generation += 1
    let attempt = generation
    guard let api = makeAPI(origin) else { return .failed(.bug("The Fitness origin is not valid.")) }
    let action = await api.enroll(
      token: token, installationId: try credentials.installationId(), deviceName: DeviceName.clean(deviceName()))
    guard case let .enrolled(response) = action else { return .failed(action) }
    var document = try credentials.load()
    let credential = DeviceCredential(
      key: response.secret, userId: response.userId, email: response.email,
      apiOrigin: origin.absoluteString, accountTimezone: response.accountTimezone, state: .consentPending)
    guard attempt == generation else {
      // A live key for a stale attempt is revoked, never activated.
      document.pending.append(
        PendingRevocation(key: credential.key, userId: credential.userId, apiOrigin: credential.apiOrigin))
      try credentials.save(document)
      _ = await revokePending()
      return .superseded
    }
    document.retireActive()
    document.active = credential
    try credentials.save(document)
    generation += 1
    try states.clear(keeping: nil)
    return .consentPending(email: response.email, accountTimezone: response.accountTimezone)
  }

  /// Confirms consent: the key becomes active with the chosen cutoff.
  public func confirm(cutoff: Date) throws -> DeviceCredential? {
    var document = try credentials.load()
    guard var active = document.active, active.state == .consentPending else { return nil }
    active.state = .active
    let storage = states.storage(for: active)
    var state = (try? storage.load()) ?? SyncState(cutoff: cutoff, accountTimezone: active.accountTimezone)
    state.cutoff = cutoff
    state.earliestCutoff = min(state.earliestCutoff, cutoff)
    try storage.save(state)
    document.active = active
    try credentials.save(document)
    generation += 1
    return active
  }

  /// Declines consent: the key is revoked without reading any Health data.
  public func decline() async throws -> Int {
    try retire()
    return await revokePending()
  }

  /// Disconnects. The key is moved to the revocation list and the sync
  /// state cleared before this returns; revocation is then attempted.
  public func disconnect() async throws -> Int {
    try retire()
    return await revokePending()
  }

  private func retire() throws {
    generation += 1
    var document = try credentials.load()
    document.retireActive()
    try credentials.save(document)
    try states.clear(keeping: nil)
  }

  /// Fitness reported this key invalid: stop using it and ask to reconnect.
  public func markInvalid(_ session: SyncSession) throws {
    var document = try credentials.load()
    guard document.active?.key == session.key else { return }
    document.active?.state = .invalid
    try credentials.save(document)
    generation += 1
  }

  /// Finishes a disconnect interrupted by a crash: sync state for anything
  /// but the current active key is removed.
  public func resumeCleanup() throws {
    let document = try credentials.load()
    try states.clear(keeping: document.active?.state == .active ? document.active : nil)
  }

  /// Tries to revoke each pending key with its own origin. Returns how many
  /// remain.
  @discardableResult
  public func revokePending() async -> Int {
    guard let document = try? credentials.load() else { return 0 }
    var done = Set<String>()
    for pending in document.pending {
      guard let url = URL(string: pending.apiOrigin), let api = makeAPI(url) else {
        done.insert(pending.key)
        continue
      }
      switch await api.revoke(key: pending.key) {
      case .done, .alreadyInvalid, .notDeviceKey: done.insert(pending.key)
      case .retry: break
      }
    }
    guard !done.isEmpty, var latest = try? credentials.load() else { return document.pending.count }
    latest.pending.removeAll { done.contains($0.key) }
    try? credentials.save(latest)
    return latest.pending.count
  }

  /// Resync from the earliest cutoff: a fresh backfill with a new snapshot.
  public func resyncFromEarliest() throws {
    guard let storage = storage(), var state = try storage.load() else { return }
    let accountTimezone = state.accountTimezone
    let earliest = state.earliestCutoff
    let history = state.history
    state = SyncState(cutoff: earliest, accountTimezone: accountTimezone)
    state.history = history
    try storage.save(state)
    generation += 1
  }

  /// Moves the cutoff. An earlier cutoff reruns backfill from it.
  public func setCutoff(_ cutoff: Date) throws {
    guard let storage = storage(), var state = try storage.load() else { return }
    if cutoff < state.cutoff {
      let history = state.history
      let earliest = min(state.earliestCutoff, cutoff)
      state = SyncState(cutoff: cutoff, accountTimezone: state.accountTimezone)
      state.earliestCutoff = earliest
      state.history = history
    } else {
      state.cutoff = cutoff
    }
    try storage.save(state)
    generation += 1
  }
}
