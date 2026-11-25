import Foundation

/// The device key's state on this iPhone.
public enum KeyState: String, Codable, Sendable {
  /// Enrolled, waiting for the user to confirm on the consent screen. No
  /// Health data is read or sent in this state.
  case consentPending
  /// Confirmed: sync runs.
  case active
}

public struct DeviceCredential: Codable, Sendable, Equatable {
  public var key: String
  public var userId: String
  public var email: String
  public var apiOrigin: String
  public var accountTimezone: String
  public var state: KeyState
  /// The enrollment sequence of the attempt that issued this key.
  public var sequence: Int
}

/// A key waiting to be revoked, with the origin it was issued by.
public struct PendingRevocation: Codable, Sendable, Equatable {
  public var key: String
  public var userId: String
  public var apiOrigin: String
}

/// The one credentials item: the current key, keys still to revoke, and the
/// installation's enrollment sequence. Every change replaces the whole item,
/// so a key is never lost between moving it and deleting it, and a sequence
/// is stored before it is sent.
public struct CredentialDocument: Codable, Sendable, Equatable {
  public var active: DeviceCredential?
  public var pending: [PendingRevocation] = []
  /// The highest enrollment sequence this installation has sent.
  public var sequence = 0
  /// Fitness reported the stored key invalid and it was cleared: the app
  /// asks to connect again.
  public var keyInvalid = false

  public init(
    active: DeviceCredential? = nil, pending: [PendingRevocation] = [], sequence: Int = 0, keyInvalid: Bool = false
  ) {
    self.active = active
    self.pending = pending
    self.sequence = sequence
    self.keyInvalid = keyInvalid
  }

  /// Moves the current key to the revocation list.
  mutating func retireActive() {
    guard let active else { return }
    pending.append(PendingRevocation(key: active.key, userId: active.userId, apiOrigin: active.apiOrigin))
    self.active = nil
  }

  private enum CodingKeys: String, CodingKey { case active, pending, sequence, keyInvalid }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    active = try container.decodeIfPresent(DeviceCredential.self, forKey: .active)
    pending = try container.decodeIfPresent([PendingRevocation].self, forKey: .pending) ?? []
    sequence = try container.decodeIfPresent(Int.self, forKey: .sequence) ?? 0
    keyInvalid = try container.decodeIfPresent(Bool.self, forKey: .keyInvalid) ?? false
  }

  mutating func revokeLater(_ credential: DeviceCredential) {
    pending.append(PendingRevocation(key: credential.key, userId: credential.userId, apiOrigin: credential.apiOrigin))
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
  /// A disconnect, a declined consent or a key with a higher enrollment
  /// sequence replaced this attempt; its key is being revoked.
  case superseded
  case failed(EnrollAction)
}

/// Connects, confirms, disconnects and revokes. Disconnecting, declining and
/// changing account bump the generation, and every step that waited
/// rechecks it before it writes. Enrollment attempts are ordered by their
/// sequence instead: of the successful replies, the one with the highest
/// sequence is kept, and a lower one never replaces it.
public actor DeviceLifecycle {
  private let credentials: CredentialStore
  private let states: StateDirectory
  private let origin: URL
  private let makeAPI: @Sendable (URL) -> FitnessAPI?
  private let deviceName: @Sendable () async -> String
  private var generation = 0

  public init(
    credentials: CredentialStore, states: StateDirectory, origin: URL,
    deviceName: @escaping @Sendable () async -> String,
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

  /// Exchanges a one-time OAuth token for a device key. Each attempt sends
  /// the next enrollment sequence, stored before the request goes out. The
  /// key starts in `consentPending`: nothing is read or sent until `confirm`.
  public func enroll(token: String, revokeLater: Bool) async throws -> EnrollOutcome {
    let remaining = await revokePending()
    if remaining > 0 && !revokeLater { return .pendingRevocations(remaining) }
    let attempt = generation
    guard let api = makeAPI(origin) else { return .failed(.bug("The Fitness origin is not valid.")) }
    let name = DeviceName.clean(await deviceName())
    let sequence = try nextSequence()
    let action = await api.enroll(
      token: token, installationId: try credentials.installationId(), deviceName: name, sequence: sequence)
    // A failed attempt leaves the stored key as it is.
    guard case let .enrolled(response) = action else { return .failed(action) }
    var document = try credentials.load()
    let credential = DeviceCredential(
      key: response.secret, userId: response.userId, email: response.email,
      apiOrigin: origin.absoluteString, accountTimezone: response.accountTimezone, state: .consentPending,
      sequence: sequence)
    // A disconnect, a declined consent or an account change while this
    // attempt ran, or a stored key from a higher sequence, wins: this key
    // is revoked, never stored.
    let outranked = document.active.map { $0.sequence > sequence } ?? false
    guard attempt == generation, !outranked else {
      document.revokeLater(credential)
      try credentials.save(document)
      _ = await revokePending()
      return .superseded
    }
    document.retireActive()
    document.active = credential
    document.keyInvalid = false
    try credentials.save(document)
    generation += 1
    try states.clear(keeping: nil)
    return .consentPending(email: response.email, accountTimezone: response.accountTimezone)
  }

  /// The next enrollment sequence, stored before it is used.
  private func nextSequence() throws -> Int {
    var document = try credentials.load()
    document.sequence += 1
    try credentials.save(document)
    return document.sequence
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

  /// Fitness reported this key invalid during an upload. If it is still the
  /// stored key, it is cleared, and the app asks to connect again, which
  /// sends a higher sequence. This also recovers when a higher sequence's
  /// key replaced it on the server and that reply was lost.
  public func markInvalid(_ session: SyncSession) throws {
    var document = try credentials.load()
    guard document.active?.key == session.key else { return }
    document.active = nil
    document.keyInvalid = true
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
