import Foundation

/// The key a run sends with, and the generation it belongs to. Connecting,
/// disconnecting or changing account starts a new generation.
public struct SyncSession: Sendable, Equatable {
  public let key: String
  public let generation: Int

  public init(key: String, generation: Int) {
    self.key = key
    self.generation = generation
  }
}

/// Answers whether a session is still the current one, so a run never sends
/// or commits for a key that was replaced or disconnected.
public protocol SessionCheck: Sendable {
  func isCurrent(_ session: SyncSession) async -> Bool
  /// Runs `write` only while the session is current, as one step with that
  /// check: a cutoff change, a disconnect or a new key cannot come between
  /// them. Returns whether `write` ran and reported a write.
  func commit(_ session: SyncSession, _ write: @Sendable () throws -> Bool) async throws -> Bool
}

extension SessionCheck {
  public func commit(_ session: SyncSession, _ write: @Sendable () throws -> Bool) async throws -> Bool {
    guard await isCurrent(session) else { return false }
    return try write()
  }
}

/// Why a run stopped early.
public enum RunStop: Error, Equatable {
  /// The run was cancelled or its session ended. Nothing more is written.
  case fenced
  /// Fitness reported the key invalid.
  case keyInvalid
  /// The account is no longer invited.
  case notInvited(String)
  /// The key lacks access.
  case reconnect(String)
  /// Health data is locked until the device is unlocked.
  case locked
  /// A retryable failure; the cursor holds.
  case retry(after: TimeInterval?, reason: String)
}

public enum RunMode: Sendable {
  /// The app is open: backfill may run.
  case foreground
  /// iOS woke the app: incremental sync only.
  case background
}

/// The limits a run works within.
public struct SyncLimits: Sendable {
  /// Samples per incremental page and per backfill request.
  public var pageSize = 200
  /// Samples Fitness accepts in one request.
  public var serverSamples = 2000
  /// Snapshot pages read before uploading anything.
  public var snapshotPage = 500
  /// Days of samples read per backfill query.
  public var windowDays = 30
  /// How long a run without a distance waits for one.
  public var distanceWait: TimeInterval = 6 * 3600
  /// How long an unreadable deferred item is kept.
  public var unreadableRetention: TimeInterval = 30 * 86_400
  /// Timezone rewinds allowed in one run.
  public var rewinds = 3

  public init() {}
}

/// Lets a run's checkpoint writes stop at once. Closing waits for a write
/// in progress, and no write starts after it, so a run whose background
/// time expired can never advance its checkpoint.
public final class WriteFence: @unchecked Sendable {
  private let lock = NSLock()
  private var open = true

  public init() {}

  public var isOpen: Bool {
    lock.lock()
    defer { lock.unlock() }
    return open
  }

  public func close() {
    lock.lock()
    open = false
    lock.unlock()
  }

  /// Runs `body` while the fence is open, holding it open until it ends.
  func write(_ body: () throws -> Void) throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard open else { return false }
    try body()
    return true
  }
}

/// Facts about the run that decide whether a sample can be sent.
final class RunContext: @unchecked Sendable {
  private let lock = NSLock()
  private var userChoice = false
  private var access = DistanceAccess(anyReadable: true)

  /// Sets the run's distance facts: the user's choice to send runs without
  /// distance, and what Health shows the app.
  func decide(userChoice: Bool, access: DistanceAccess) {
    lock.lock()
    self.userChoice = userChoice
    self.access = access
    lock.unlock()
  }

  /// Whether a run that started at `start` can be sent without a distance.
  func sendsWithoutDistance(_ start: Date) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return userChoice || access.covers(start)
  }
}

/// One sync run over the persisted state. Every HTTP call and every commit
/// first checks that the run is still current.
public struct SyncEngine: Sendable {
  let source: HealthSource
  let api: FitnessAPI
  let storage: StateStorage
  let check: SessionCheck
  let session: SyncSession
  let deviceTimeZone: TimeZone
  let limits: SyncLimits
  let now: @Sendable () -> Date
  let writes: WriteFence
  let context = RunContext()

  public init(
    source: HealthSource, api: FitnessAPI, storage: StateStorage, check: SessionCheck,
    session: SyncSession, deviceTimeZone: TimeZone = .current, limits: SyncLimits = SyncLimits(),
    writes: WriteFence = WriteFence(), now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.source = source
    self.api = api
    self.storage = storage
    self.check = check
    self.session = session
    self.deviceTimeZone = deviceTimeZone
    self.limits = limits
    self.writes = writes
    self.now = now
  }

  /// The same engine with another write fence, for one coordinated run.
  public func fenced(by writes: WriteFence) -> SyncEngine {
    SyncEngine(
      source: source, api: api, storage: storage, check: check, session: session,
      deviceTimeZone: deviceTimeZone, limits: limits, writes: writes, now: now)
  }

  // MARK: Run

  /// Runs backfill (in the foreground) and incremental sync, then rechecks
  /// deferred samples. `force` resumes types held after a `400`.
  @discardableResult
  public func run(mode: RunMode, force: Bool = false) async throws -> RunSummary {
    guard var state = try storage.load() else { return RunSummary(at: now()) }
    // Nothing runs until the Health step starts the first sync.
    if state.awaitingHealthStep { return RunSummary(at: now()) }
    var counts: [String: Int] = [:]
    if force && !state.paused.isEmpty {
      state.paused = [:]
      try await commit(state)
    }
    do {
      try await decideRunsWithoutDistance(state)
      if !state.incrementalEnabled {
        // Backfill runs in the foreground, and not while a 400 holds it.
        guard mode == .foreground, state.paused.isEmpty else { return RunSummary(at: now()) }
        try await backfill(&state, counts: &counts)
      }
      if state.incrementalEnabled {
        for kind in SampleKind.allCases where state.paused[kind] == nil {
          try await incremental(kind, &state, counts: &counts)
        }
        try await recheckDeferred(&state, counts: &counts)
      }
    } catch let stop as RunStop {
      if stop != .fenced, var latest = try? storage.load() {
        latest.lastError = code(for: stop)
        latest.record(RunSummary(at: now(), counts: counts, error: latest.lastError))
        try? await commit(latest)
      }
      throw stop
    }
    let summary = RunSummary(at: now(), counts: counts)
    state.lastSyncAt = summary.at
    state.lastError = state.paused.isEmpty ? nil : "needs_correction"
    state.record(summary)
    try await commit(state)
    return summary
  }

  private func code(for stop: RunStop) -> String {
    switch stop {
    case .fenced: "cancelled"
    case .keyInvalid: "key_invalid"
    case .notInvited: "not_invited"
    case .reconnect: "reconnect"
    case .locked: "locked"
    case let .retry(_, reason): reason
    }
  }

  // MARK: Fencing

  private func fence() async throws {
    if Task.isCancelled || !writes.isOpen { throw RunStop.fenced }
    if !(await check.isCurrent(session)) { throw RunStop.fenced }
    // The run may have expired while the session was being checked.
    if Task.isCancelled || !writes.isOpen { throw RunStop.fenced }
  }

  /// Writes the checkpoint if the run is still current. The session check
  /// and the write are one step of the session check's owner, so a cutoff
  /// change or a disconnect either comes first and stops the write, or waits
  /// for it. The write also happens inside the write fence, so an expiry
  /// either waits for it or prevents it.
  private func commit(_ state: SyncState) async throws {
    try await fence()
    let written: Bool
    do {
      let (writes, storage) = (self.writes, self.storage)
      written = try await check.commit(session) {
        try writes.write {
          if Task.isCancelled { throw RunStop.fenced }
          try storage.save(state)
        }
      }
    } catch RunStop.fenced {
      throw RunStop.fenced
    } catch {
      throw RunStop.retry(after: nil, reason: "state_write_failed")
    }
    if !written { throw RunStop.fenced }
  }

  private func read<T: Sendable>(_ body: () async throws -> T) async throws -> T {
    try await fence()
    do {
      return try await body()
    } catch HealthAccessError.protectedDataUnavailable {
      throw RunStop.locked
    } catch is CancellationError {
      throw RunStop.fenced
    } catch {
      throw RunStop.retry(after: nil, reason: "health_query_failed")
    }
  }

  // MARK: Eligibility

  enum Eligibility: Equatable {
    case send
    case deferred(DeferralReason)
    case unknown
  }

  /// Whether a sample can be sent now. A run without a distance waits 6
  /// hours for one; after that it is sent without one only when the app can
  /// read distance for the run's start, or the user chose to send such runs.
  func eligibility(_ sample: HealthSample, at time: Date) -> Eligibility {
    if sample.start > time { return .deferred(.future) }
    if case let .run(_, start, end, _, distance) = sample {
      switch distance {
      case .unknown: return .unknown
      case .none where end > time.addingTimeInterval(-limits.distanceWait): return .deferred(.awaitingDistance)
      case .none where !context.sendsWithoutDistance(start): return .deferred(.distanceAccess)
      default: break
      }
    }
    return .send
  }

  /// Reads once per run what decides whether runs without a readable
  /// distance can be sent: the user's choice, or Health showing the app
  /// distance for the run's time.
  private func decideRunsWithoutDistance(_ state: SyncState) async throws {
    if state.sendRunsWithoutDistance {
      context.decide(userChoice: true, access: DistanceAccess(anyReadable: false))
      return
    }
    let access = try await read { try await source.distanceAccess() }
    context.decide(userChoice: false, access: access)
  }

  // MARK: Upload

  /// Sends samples in order and returns one outcome per sample. A request
  /// that is too large is split in order, earliest samples first, and
  /// succeeds only when every part does.
  func upload(
    _ samples: [HealthSample], expectedTimezone: String?
  ) async throws -> (outcomes: [DeviceOutcome], timezone: String?) {
    guard !samples.isEmpty else { return ([], nil) }
    let request: ImportRequest
    do {
      request = try ImportRequest(
        samples: samples, timestamps: Timestamps(timeZone: deviceTimeZone), expectedTimezone: expectedTimezone)
    } catch {
      throw RunStop.retry(after: nil, reason: "distance_unknown")
    }
    try await fence()
    switch await api.importSamples(request, key: session.key) {
    case let .accepted(reply):
      return (reply.outcomes, reply.accountTimezone)
    case .split:
      guard samples.count > 1 else { throw UploadFailure.needsCorrection("A single sample is too large to send.") }
      let half = samples.count / 2
      let first = try await upload(Array(samples[..<half]), expectedTimezone: expectedTimezone)
      let second = try await upload(Array(samples[half...]), expectedTimezone: expectedTimezone)
      return (first.outcomes + second.outcomes, second.timezone ?? first.timezone)
    case let .timezoneChanged(timezone):
      throw UploadFailure.timezoneChanged(timezone)
    case let .needsCorrection(message):
      throw UploadFailure.needsCorrection(message)
    case .keyInvalid:
      throw RunStop.keyInvalid
    case let .notInvited(message):
      throw RunStop.notInvited(message)
    case let .reconnect(message):
      throw RunStop.reconnect(message)
    case let .retry(after, reason):
      throw RunStop.retry(after: after, reason: reason)
    }
  }

  enum UploadFailure: Error, Equatable {
    case timezoneChanged(String)
    case needsCorrection(String)
  }

  /// Applies outcomes: counts by type and code, and `future` skips deferred.
  private func apply(
    _ outcomes: [DeviceOutcome], sent: [HealthSample], to state: inout SyncState, counts: inout [String: Int]
  ) {
    let byRef = Dictionary(sent.map { ($0.ref, $0) }, uniquingKeysWith: { first, _ in first })
    for outcome in outcomes {
      counts["\(outcome.type.rawValue).\(outcome.code.rawValue)", default: 0] += 1
      guard let sample = byRef[Refs.canonical(outcome.ref) ?? outcome.ref] else { continue }
      let id = sample.id.uuidString.lowercased()
      if outcome.code == .future {
        state.deferred[id] = DeferredItem(kind: sample.kind, reason: .serverFuture)
      } else {
        state.deferred[id] = nil
        state.backfill?.resolved.insert(id)
        if case .run(_, _, _, _, .none) = sample { state.runsWithoutDistance += 1 }
      }
    }
  }

  // MARK: Backfill

  private func backfill(_ state: inout SyncState, counts: inout [String: Int]) async throws {
    if state.backfill == nil { try await snapshot(&state) }
    var rewinds = 0
    while true {
      do {
        try await backfillDays(&state, counts: &counts)
        break
      } catch let UploadFailure.needsCorrection(message) {
        // Requests hold both types, so both wait for Sync now.
        for kind in SampleKind.allCases { state.paused[kind] = message }
        try await commit(state)
        return
      } catch let UploadFailure.timezoneChanged(timezone) {
        rewinds += 1
        guard rewinds <= limits.rewinds else { throw RunStop.retry(after: nil, reason: "timezone_changed") }
        state.accountTimezone = timezone
        rewind(&state)
        try await commit(state)
      }
    }
    // Install the baseline: the snapshot's anchors and its deferred samples,
    // without the ones resolved since.
    guard let finished = state.backfill else { return }
    var deferred = finished.snapshotDeferred.merging(state.deferred) { _, live in live }
    for id in finished.resolved { deferred[id] = nil }
    state.deferred = deferred
    state.anchors = finished.snapshotAnchors
    state.backfill = nil
    try await commit(state)
  }

  /// Back to the start of the snapshot's cutoff, grouped in the current
  /// account timezone. The snapshot itself is reused.
  private func rewind(_ state: inout SyncState) {
    state.backfill?.through = nil
    state.backfill?.timezone = state.accountTimezone
  }

  /// Pages each type's anchored query to its end without uploading, and
  /// keeps the anchors and the samples not yet eligible.
  private func snapshot(_ state: inout SyncState) async throws {
    var anchors: [SampleKind: Data] = [:]
    var deferred: [String: DeferredItem] = [:]
    var deleted = Set<String>()
    let time = now()
    for kind in SampleKind.allCases {
      var anchor: Data?
      while true {
        let page = try await read { [anchor] in
          try await source.page(kind, cutoff: state.cutoff, anchor: anchor, limit: limits.snapshotPage)
        }
        for sample in page.samples where sample.start > time {
          deferred[sample.id.uuidString.lowercased()] = DeferredItem(kind: kind, reason: .future)
        }
        // A sample deleted on a later page is no longer waiting.
        for id in page.deleted.map({ $0.uuidString.lowercased() }) {
          deferred[id] = nil
          deleted.insert(id)
        }
        anchor = page.anchor
        if !page.more { break }
      }
      if let anchor { anchors[kind] = anchor }
    }
    var backfill = Backfill(
      cutoff: state.cutoff, snapshotAnchors: anchors, snapshotDeferred: deferred, timezone: state.accountTimezone)
    backfill.resolved = deleted
    state.backfill = backfill
    try await commit(state)
  }

  private func backfillDays(_ state: inout SyncState, counts: inout [String: Int]) async throws {
    guard let current = state.backfill else { return }
    if current.timezone != state.accountTimezone {
      rewind(&state)
      try await commit(state)
    }
    guard let progress = state.backfill, let days = AccountDays(timezone: progress.timezone) else {
      throw RunStop.retry(after: nil, reason: "unknown_timezone")
    }
    let time = now()
    let tomorrow = days.next(days.start(containing: time))
    var dayStart: Date
    if let through = progress.through, let last = days.start(of: through) {
      dayStart = days.next(last)
    } else {
      dayStart = days.start(containing: progress.cutoff)
    }
    while dayStart < tomorrow {
      let windowEnd = min(days.next(dayStart, by: limits.windowDays), tomorrow)
      // The first window starts at the cutoff; the last includes today.
      let from = max(dayStart, progress.cutoff)
      var samples: [HealthSample] = []
      for kind in SampleKind.allCases {
        samples += try await read { try await source.samples(kind, start: from, end: windowEnd) }
      }
      samples.sort { $0.start < $1.start }
      let grouped = Dictionary(grouping: samples) { days.day($0.start) }
      var batch: [HealthSample] = []
      var batchDays: [String] = []
      // Sends the complete days gathered so far, or, with nothing to send,
      // marks them done with their deferrals.
      func flush() async throws {
        if !batch.isEmpty {
          try await sendBackfill(batch, days: batchDays, &state, counts: &counts)
        } else if let last = batchDays.last, state.backfill?.through != last {
          state.backfill?.through = last
          try await commit(state)
        }
        batch = []
        batchDays = []
      }
      var day = dayStart
      while day < windowEnd {
        let key = days.day(day)
        var send: [HealthSample] = []
        for sample in grouped[key] ?? [] {
          switch eligibility(sample, at: time) {
          case .send: send.append(sample)
          case let .deferred(reason):
            state.deferred[sample.id.uuidString.lowercased()] = DeferredItem(kind: sample.kind, reason: reason)
          case .unknown:
            // The day waits until its runs' distances can be read.
            try await flush()
            throw RunStop.retry(after: nil, reason: "distance_unknown")
          }
        }
        if batch.count + send.count > limits.pageSize { try await flush() }
        if send.count > limits.pageSize {
          // A large day goes alone, in start order, the earliest first.
          var rest = send[...]
          while !rest.isEmpty {
            let chunk = Array(rest.prefix(limits.serverSamples))
            rest = rest.dropFirst(chunk.count)
            try await sendBackfill(chunk, days: rest.isEmpty ? [key] : [], &state, counts: &counts)
          }
        } else {
          batch += send
          batchDays.append(key)
        }
        day = days.next(day)
      }
      try await flush()
      dayStart = windowEnd
    }
  }

  /// Sends one backfill request of complete days, then marks the last of
  /// them done together with the request's deferrals.
  private func sendBackfill(
    _ samples: [HealthSample], days: [String], _ state: inout SyncState, counts: inout [String: Int]
  ) async throws {
    guard let progress = state.backfill else { return }
    let result = try await upload(samples, expectedTimezone: progress.timezone)
    apply(result.outcomes, sent: samples, to: &state, counts: &counts)
    if let timezone = result.timezone { state.accountTimezone = timezone }
    if let last = days.last { state.backfill?.through = last }
    try await commit(state)
  }

  // MARK: Incremental

  private func incremental(_ kind: SampleKind, _ state: inout SyncState, counts: inout [String: Int]) async throws {
    while true {
      let anchor = state.anchors?[kind]
      let page = try await read { [state] in
        try await source.page(kind, cutoff: state.cutoff, anchor: anchor, limit: limits.pageSize)
      }
      let time = now()
      var send: [HealthSample] = []
      var deferred: [String: DeferredItem] = [:]
      for sample in page.samples {
        switch eligibility(sample, at: time) {
        case .send: send.append(sample)
        case let .deferred(reason):
          deferred[sample.id.uuidString.lowercased()] = DeferredItem(kind: kind, reason: reason)
        case .unknown:
          // Not committed: the page is read again on the next run.
          throw RunStop.retry(after: nil, reason: "distance_unknown")
        }
      }
      var next = state
      do {
        let result = try await upload(send, expectedTimezone: nil)
        apply(result.outcomes, sent: send, to: &next, counts: &counts)
        if let timezone = result.timezone { next.accountTimezone = timezone }
      } catch let UploadFailure.needsCorrection(message) {
        state.paused[kind] = message
        try await commit(state)
        return
      }
      for id in page.deleted { next.deferred[id.uuidString.lowercased()] = nil }
      next.deferred.merge(deferred) { _, new in new }
      next.anchors?[kind] = page.anchor
      try await commit(next)
      state = next
      if !page.more { return }
    }
  }

  // MARK: Deferred

  private func recheckDeferred(_ state: inout SyncState, counts: inout [String: Int]) async throws {
    let time = now()
    for kind in SampleKind.allCases where state.paused[kind] == nil {
      let ids = state.deferred.filter { $0.value.kind == kind }.keys.sorted()
      guard !ids.isEmpty else { continue }
      let found: [HealthSample]
      do {
        found = try await read { try await source.samples(kind, ids: ids.compactMap(UUID.init(uuidString:))) }
      } catch RunStop.retry {
        // A query error keeps every item as it is.
        continue
      }
      var next = state
      let readable = Set(found.map { $0.id.uuidString.lowercased() })
      for id in ids where !readable.contains(id) {
        // An empty answer may mean read access was removed, so the item is
        // kept for 30 days from the first empty answer.
        let first = next.deferred[id]?.firstEmptyAt ?? time
        if time.timeIntervalSince(first) >= limits.unreadableRetention {
          next.deferred[id] = nil
          next.unreadableRetired += 1
        } else {
          next.deferred[id]?.firstEmptyAt = first
        }
      }
      var send: [HealthSample] = []
      for sample in found.sorted(by: { $0.start < $1.start }) {
        let id = sample.id.uuidString.lowercased()
        // A sample from before the current cutoff is no longer sent.
        if sample.start < next.cutoff {
          next.deferred[id] = nil
          continue
        }
        next.deferred[id]?.firstEmptyAt = nil
        switch eligibility(sample, at: time) {
        case .send: send.append(sample)
        case let .deferred(reason): next.deferred[id]?.reason = reason
        case .unknown: break
        }
      }
      var rest = send[...]
      repeat {
        let chunk = Array(rest.prefix(limits.pageSize))
        rest = rest.dropFirst(chunk.count)
        do {
          let result = try await upload(chunk, expectedTimezone: nil)
          apply(result.outcomes, sent: chunk, to: &next, counts: &counts)
          if let timezone = result.timezone { next.accountTimezone = timezone }
        } catch let UploadFailure.needsCorrection(message) {
          next.paused[kind] = message
          rest = []
        }
        try await commit(next)
        state = next
      } while !rest.isEmpty
    }
  }
}
