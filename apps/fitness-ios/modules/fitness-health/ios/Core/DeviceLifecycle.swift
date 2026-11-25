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
  /// An opaque ID for this enrollment. Consent and decline name it, so they
  /// act only on the key whose account the consent screen showed.
  public var enrollmentId: String
}

/// A key waiting to be revoked, with the origin it was issued by.
public struct PendingRevocation: Codable, Sendable, Equatable {
  public var key: String
  public var userId: String
  public var apiOrigin: String
  /// Not before this time, when Fitness asked the app to wait.
  public var retryAt: Date?

  public init(key: String, userId: String, apiOrigin: String, retryAt: Date? = nil) {
    self.key = key
    self.userId = userId
    self.apiOrigin = apiOrigin
    self.retryAt = retryAt
  }
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
  /// The highest sequence whose successful reply was kept. A success from
  /// this sequence or a lower one is revoked instead of stored.
  public var acceptedSequence = 0
  /// Fitness reported the stored key invalid and it was cleared: the app
  /// asks to connect again.
  public var keyInvalid = false
  /// Keys Fitness refused to revoke from the iPhone because they are not
  /// device keys. The user revokes them under Manage account → API keys.
  public var manualRevocations = 0

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
    revokeLater(active)
    self.active = nil
  }

  mutating func revokeLater(_ credential: DeviceCredential) {
    pending.append(PendingRevocation(key: credential.key, userId: credential.userId, apiOrigin: credential.apiOrigin))
  }

  private enum CodingKeys: String, CodingKey {
    case active, pending, sequence, acceptedSequence, keyInvalid, manualRevocations
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    active = try container.decodeIfPresent(DeviceCredential.self, forKey: .active)
    pending = try container.decodeIfPresent([PendingRevocation].self, forKey: .pending) ?? []
    sequence = try container.decodeIfPresent(Int.self, forKey: .sequence) ?? 0
    acceptedSequence = try container.decodeIfPresent(Int.self, forKey: .acceptedSequence) ?? 0
    keyInvalid = try container.decodeIfPresent(Bool.self, forKey: .keyInvalid) ?? false
    manualRevocations = try container.decodeIfPresent(Int.self, forKey: .manualRevocations) ?? 0
  }
}

/// The Keychain in the app, memory in tests. Reads and writes throw
/// `HealthAccessError.protectedDataUnavailable` while the device is locked
/// before its first unlock, which is not the same as having no credential.
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

public enum LifecycleError: Error, Equatable {
  /// Consent or decline named an enrollment that is no longer pending.
  case enrollmentChanged
}

/// Connects, confirms, disconnects and revokes.
///
/// Two counters order the work. `cancellation` changes only when the user
/// disconnects or declines; an enrollment that was running then is revoked.
/// Enrollment attempts are ordered by their sequence instead: of the
/// successful replies, the one with the highest sequence is kept, and a
/// lower one never replaces it. `generation` changes whenever the key or the
/// sync state changes, and fences sync runs that started before.
public actor DeviceLifecycle {
  private let credentials: CredentialStore
  private let states: StateDirectory
  private let origin: URL
  private let makeAPI: @Sendable (URL) -> FitnessAPI?
  private let deviceName: @Sendable () async -> String
  private let now: @Sendable () -> Date
  private var generation = 0
  private var cancellation = 0

  public init(
    credentials: CredentialStore, states: StateDirectory, origin: URL,
    deviceName: @escaping @Sendable () async -> String,
    makeAPI: @escaping @Sendable (URL) -> FitnessAPI?,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.credentials = credentials
    self.states = states
    self.origin = origin
    self.deviceName = deviceName
    self.makeAPI = makeAPI
    self.now = now
  }

  // MARK: Reading

  public func document() throws -> CredentialDocument { try credentials.load() }

  /// The session sync runs with: an active key for this build's origin, or
  /// nil without one. Throws while the Keychain is locked, so the caller
  /// keeps its state and retries after the unlock.
  public func currentSession() throws -> SyncSession? {
    guard let active = try credentials.load().active, active.state == .active,
      active.apiOrigin == origin.absoluteString
    else { return nil }
    return SyncSession(key: active.key, generation: generation)
  }

  /// The session, or nil when there is none or the Keychain is locked.
  public func session() -> SyncSession? { try? currentSession() }

  public func isCurrent(_ session: SyncSession) -> Bool {
    session.generation == generation && self.session()?.key == session.key
  }

  /// Runs a sync run's checkpoint write while its session is current. The
  /// check and the write run together on this actor, so a cutoff change, a
  /// disconnect or a new key either happens before and stops the write, or
  /// waits until it ends and then rebuilds or clears what it wrote.
  public func commit(_ session: SyncSession, _ write: @Sendable () throws -> Bool) throws -> Bool {
    guard isCurrent(session) else { return false }
    return try write()
  }

  public func storage() -> StateStorage? {
    guard let active = try? credentials.load().active, active.state == .active else { return nil }
    return states.storage(for: active)
  }

  // MARK: Enrollment

  /// Exchanges a one-time OAuth token for a device key. Each attempt sends
  /// the next enrollment sequence, stored before the request goes out. The
  /// key starts in `consentPending`: nothing is read or sent until `confirm`.
  ///
  /// A disconnect or a declined consent at any point cancels the attempt.
  /// It is checked after each wait, and once more just before the sequence
  /// is taken, so a cancelled attempt never sends a request.
  public func enroll(token: String, revokeLater: Bool) async throws -> EnrollOutcome {
    let started = cancellation
    let remaining = await revokePending()
    guard started == cancellation else { return .superseded }
    if remaining > 0 && !revokeLater { return .pendingRevocations(remaining) }
    guard let api = makeAPI(origin) else { return .failed(.bug("The Fitness origin is not valid.")) }
    let name = DeviceName.clean(await deviceName())
    guard started == cancellation else { return .superseded }
    let sequence = try nextSequence()
    let action = await api.enroll(
      token: token, installationId: try credentials.installationId(), deviceName: name, sequence: sequence)
    // A failed attempt leaves the stored key as it is.
    guard case let .enrolled(response) = action else { return .failed(action) }
    var document = try credentials.load()
    let credential = DeviceCredential(
      key: response.secret, userId: response.userId, email: response.email,
      apiOrigin: origin.absoluteString, accountTimezone: response.accountTimezone, state: .consentPending,
      sequence: sequence, enrollmentId: UUID().uuidString.lowercased())
    // A disconnect or a declined consent while this attempt ran, or a kept
    // success from a higher sequence, wins: this key is revoked, never stored.
    guard started == cancellation, sequence > document.acceptedSequence else {
      document.revokeLater(credential)
      try credentials.save(document)
      _ = await revokePending()
      return .superseded
    }
    document.retireActive()
    document.active = credential
    document.acceptedSequence = sequence
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

  /// Confirms consent for the enrollment the consent screen showed: its key
  /// becomes active with the chosen cutoff. The first sync waits for the
  /// Health step (`startFirstSync`).
  public func confirm(cutoff: Date, enrollmentId: String) throws -> DeviceCredential {
    var document = try credentials.load()
    guard var active = document.active, active.state == .consentPending, active.enrollmentId == enrollmentId
    else { throw LifecycleError.enrollmentChanged }
    active.state = .active
    let storage = states.storage(for: active)
    var state = SyncState(cutoff: cutoff, accountTimezone: active.accountTimezone)
    state.awaitingHealthStep = true
    try storage.save(state)
    document.active = active
    try credentials.save(document)
    generation += 1
    return active
  }

  /// Lets the first sync start, after the Health step asked for access.
  public func startFirstSync() throws {
    guard let storage = storage(), var state = try storage.load(), state.awaitingHealthStep else { return }
    state.awaitingHealthStep = false
    try storage.save(state)
  }

  /// Declines consent for the enrollment the consent screen showed: its key
  /// is revoked without reading any Health data.
  public func decline(enrollmentId: String) async throws -> Int {
    let document = try credentials.load()
    guard let active = document.active, active.state == .consentPending, active.enrollmentId == enrollmentId
    else { throw LifecycleError.enrollmentChanged }
    try deactivate()
    return await revokePending()
  }

  /// Disconnects. The key is moved to the revocation list and the sync
  /// state cleared before this returns; revocation is then attempted.
  public func disconnect() async throws -> Int {
    try deactivate()
    return await revokePending()
  }

  /// Stops using the current key: it moves to the revocation list and the
  /// sync state is cleared, in that order, before anything else stops.
  /// Enrollments running now are revoked when they reply.
  public func deactivate() throws {
    cancellation += 1
    generation += 1
    var document = try credentials.load()
    document.retireActive()
    try credentials.save(document)
    try states.clear(keeping: nil)
  }

  /// Fitness reported this key invalid during an upload. If it is still the
  /// stored key, it is cleared, and the app asks to connect again, which
  /// sends a higher sequence. This also recovers when a higher sequence's
  /// key replaced it on the server and that reply was lost. Returns whether
  /// the stored key was cleared.
  @discardableResult
  public func markInvalid(_ session: SyncSession) throws -> Bool {
    var document = try credentials.load()
    guard document.active?.key == session.key else { return false }
    document.active = nil
    document.keyInvalid = true
    try credentials.save(document)
    generation += 1
    return true
  }

  /// Finishes a disconnect interrupted by a crash: sync state for anything
  /// but the current active key is removed.
  public func resumeCleanup() throws {
    let document = try credentials.load()
    try states.clear(keeping: document.active?.state == .active ? document.active : nil)
  }

  /// Tries to revoke each pending key with its own origin, skipping keys
  /// Fitness asked to wait for. Returns how many remain.
  @discardableResult
  public func revokePending() async -> Int {
    guard let document = try? credentials.load() else { return 0 }
    let time = now()
    var done = Set<String>()
    var refused = Set<String>()
    var waits: [String: Date] = [:]
    for pending in document.pending {
      if let retryAt = pending.retryAt, retryAt > time { continue }
      guard let url = URL(string: pending.apiOrigin), let api = makeAPI(url) else {
        done.insert(pending.key)
        continue
      }
      switch await api.revoke(key: pending.key) {
      case .done, .alreadyInvalid: done.insert(pending.key)
      case .notDeviceKey: refused.insert(pending.key)
      // The wait counts from when the reply arrived.
      case let .retry(after): if let after { waits[pending.key] = now().addingTimeInterval(after) }
      }
    }
    guard !done.isEmpty || !refused.isEmpty || !waits.isEmpty, var latest = try? credentials.load() else {
      return document.pending.count
    }
    latest.pending.removeAll { done.contains($0.key) || refused.contains($0.key) }
    latest.manualRevocations += refused.count
    for index in latest.pending.indices {
      if let retryAt = waits[latest.pending[index].key] { latest.pending[index].retryAt = retryAt }
    }
    try? credentials.save(latest)
    return latest.pending.count
  }

  /// Resync from the earliest cutoff: a fresh backfill with a new snapshot.
  public func resyncFromEarliest() throws {
    guard let storage = storage(), let state = try storage.load() else { return }
    try rebuild(storage, from: state, cutoff: state.earliestCutoff)
  }

  /// Moves the cutoff. The snapshot and anchors are rebuilt from it, which
  /// stops a backfill in progress, so a later cutoff leaves out history the
  /// earlier snapshot covered.
  public func setCutoff(_ cutoff: Date) throws {
    guard let storage = storage(), let state = try storage.load() else { return }
    try rebuild(storage, from: state, cutoff: cutoff)
  }

  private func rebuild(_ storage: StateStorage, from old: SyncState, cutoff: Date) throws {
    var state = SyncState(cutoff: cutoff, accountTimezone: old.accountTimezone)
    state.earliestCutoff = min(old.earliestCutoff, cutoff)
    state.history = old.history
    state.lastSyncAt = old.lastSyncAt
    state.sendRunsWithoutDistance = old.sendRunsWithoutDistance
    try storage.save(state)
    generation += 1
  }

  /// Lets runs that waited for distance access be sent without a distance.
  public func sendRunsWithoutDistance() throws {
    guard let storage = storage(), var state = try storage.load() else { return }
    state.sendRunsWithoutDistance = true
    try storage.save(state)
    generation += 1
  }
}
