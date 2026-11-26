import XCTest
@testable import FitnessHealthCore

/// Regression tests for the second independent review of the iPhone app.
/// Several cases started from the reviewer's own reproductions.
final class FollowupRegressionTests: XCTestCase {
  private let origin = URL(string: "https://fitness.example.test")!

  // MARK: 1. A checkpoint cannot restore an excluded history range

  /// Paused after the run's session check and before its checkpoint write:
  /// the cutoff narrows, and the write that follows is refused.
  func testACheckpointPausedAfterTheSessionCheckCannotRestoreTheCutoff() async throws {
    let old = date("2026-11-10T00:00:00Z")
    let new = date("2026-11-15T00:00:00Z")
    let now = date("2026-11-20T02:00:00Z")
    let (device, store) = try await activeLifecycle(cutoff: old, states: MemoryStates())
    let h = Harness(now: now, cutoff: old)
    h.health.add(Sample.weight(1, date("2026-11-18T00:00:00Z")))
    let check = PausingCheck(lifecycle: device)
    // Held at the checkpoint after the first accepted upload.
    h.fitness.onRequest { _ in check.arm() }
    let engine = try await engine(h, device: device, store: store, check: check)
    let run = Task { try await engine.run(mode: .foreground) }
    await check.gate.reached()
    try await device.setCutoff(new)
    check.gate.open()
    _ = try? await run.value
    XCTAssertEqual(try store.load()?.cutoff, new)
    try await assertExcludedSampleStaysUnsent(h, device: device, store: store)
  }

  /// The reviewer's reproduction: the checkpoint write itself is in
  /// progress when the cutoff is changed. The cutoff change waits for the
  /// write, then rebuilds from the new cutoff. The run may write another
  /// checkpoint before the change reaches the lifecycle, but none after it:
  /// no write with the old cutoff follows the first with the new one.
  func testACutoffChangeWaitsForACheckpointWriteInProgress() async throws {
    let old = date("2026-11-10T00:00:00Z")
    let new = date("2026-11-15T00:00:00Z")
    let now = date("2026-11-20T02:00:00Z")
    let directory = WriteRaceDirectory()
    let (device, store) = try await activeLifecycle(cutoff: old, states: directory)
    let h = Harness(now: now, cutoff: old)
    let engine = try await engine(h, device: device, store: store, check: RealLifecycleCheck(lifecycle: device))
    directory.isHolding.with { $0 = true }
    let run = Task { try await engine.run(mode: .foreground) }
    await directory.started.reached()
    let requested = Gate()
    let narrowing = Task {
      await requested.pass()
      try await device.setCutoff(new)
    }
    await requested.reached()
    requested.open()
    directory.started.open()
    directory.release.signal()
    _ = try? await run.value
    try await narrowing.value
    let writes = directory.writes.get
    XCTAssertEqual(writes.first, old, "The held checkpoint")
    XCTAssertEqual(writes.last, new, "\(writes)")
    let firstNew = try XCTUnwrap(writes.firstIndex(of: new))
    XCTAssertFalse(writes[firstNew...].contains(old), "An old-cutoff write followed the new cutoff: \(writes)")
    XCTAssertEqual(try store.load()?.cutoff, new)
    try await assertExcludedSampleStaysUnsent(h, device: device, store: store)
  }

  /// A checkpoint for a run that started before a disconnect is refused, so
  /// it cannot write the cleared account's state back.
  func testACheckpointAfterADisconnectWritesNothing() async throws {
    let old = date("2026-11-10T00:00:00Z")
    let now = date("2026-11-20T02:00:00Z")
    let states = MemoryStates()
    let (device, store) = try await activeLifecycle(cutoff: old, states: states)
    let h = Harness(now: now, cutoff: old)
    h.health.add(Sample.weight(1, date("2026-11-18T00:00:00Z")))
    let check = PausingCheck(lifecycle: device)
    h.fitness.onRequest { _ in check.arm() }
    let engine = try await engine(h, device: device, store: store, check: check)
    let run = Task { try await engine.run(mode: .foreground) }
    await check.gate.reached()
    _ = try await device.disconnect()
    let cleared = try store.load()
    check.gate.open()
    _ = try? await run.value
    XCTAssertEqual(h.fitness.received.count, 1)
    XCTAssertEqual(try store.load(), cleared)
    XCTAssertTrue(states.stores.get.isEmpty)
  }

  /// Dismissing the manual-revoke notice while an upload's reply is being
  /// handled leaves the session current: the run writes its checkpoint, and
  /// the next run sends nothing again.
  func testDismissingTheManualRevokeNoticeDuringASyncKeepsTheSession() async throws {
    let cutoff = date("2026-11-10T00:00:00Z")
    let now = date("2026-11-20T02:00:00Z")
    let credentials = MemoryCredentials()
    let (device, store) = try await activeLifecycle(cutoff: cutoff, states: MemoryStates(), credentials: credentials)
    var document = try credentials.load()
    document.manualRevocations = 1
    try credentials.save(document)
    let h = Harness(now: now, cutoff: cutoff)
    h.health.add(Sample.weight(1, date("2026-11-18T00:00:00Z")))
    let check = PausingCheck(lifecycle: device)
    // Held after Fitness accepted the upload, before its checkpoint.
    h.fitness.onRequest { _ in check.arm() }
    let engine = try await engine(h, device: device, store: store, check: check)
    let current = try await device.currentSession()
    let session = try XCTUnwrap(current)
    let run = Task { try await engine.run(mode: .foreground) }
    await check.gate.reached()
    try await device.dismissManualRevocations(revision: 1)
    let stillCurrent = await device.isCurrent(session)
    XCTAssertTrue(stillCurrent)
    check.gate.open()
    try await run.value
    XCTAssertEqual(try credentials.load().unseenManualRevocations, 0)
    XCTAssertEqual(h.fitness.received.count, 1)
    let next = try await self.engine(h, device: device, store: store, check: RealLifecycleCheck(lifecycle: device))
    try await next.run(mode: .foreground)
    XCTAssertEqual(h.fitness.received.count, 1, "The checkpoint was not written, so the sample was sent again.")
  }

  // MARK: 2. A cancelled enrollment never sends or replaces the key

  func testADisconnectDuringPendingKeyCleanupCancelsTheEnrollment() async throws {
    let credentials = MemoryCredentials()
    try credentials.save(CredentialDocument(pending: [
      PendingRevocation(key: "ak_prior", userId: "user_prior", apiOrigin: origin.absoluteString)
    ]))
    let transport = RemovalGate()
    let device = DeviceLifecycle(
      credentials: credentials, states: MemoryStates(), origin: origin,
      deviceName: { "iPhone" }, makeAPI: { try? FitnessAPI(origin: $0, transport: transport) })
    let enrollment = Task { try await device.enroll(token: "a", revokeLater: false) }
    await transport.pendingDelete.reached()
    _ = try await device.disconnect()
    transport.pendingDelete.open()
    let outcome = try await enrollment.value
    XCTAssertEqual(outcome, .superseded)
    XCTAssertTrue(transport.devices.sequences.isEmpty)
    XCTAssertNil(try credentials.load().active)
  }

  func testADisconnectDuringTheNameLookupSendsNothingAfterAReconnect() async throws {
    let credentials = MemoryCredentials()
    let transport = FakeDevices()
    let nameReads = Locked(0)
    let nameGate = Gate()
    let device = DeviceLifecycle(
      credentials: credentials, states: MemoryStates(), origin: origin,
      deviceName: {
        let read = nameReads.with { reads -> Int in
          reads += 1
          return reads
        }
        if read == 1 { await nameGate.pass() }
        return "iPhone"
      }, makeAPI: { try? FitnessAPI(origin: $0, transport: transport) })
    let cancelled = Task { try await device.enroll(token: "cancelled", revokeLater: false) }
    await nameGate.reached()
    _ = try await device.disconnect()
    _ = try await device.enroll(token: "new", revokeLater: false)
    let working = try credentials.load().active
    nameGate.open()
    let outcome = try await cancelled.value
    XCTAssertEqual(outcome, .superseded)
    XCTAssertEqual(transport.sequences, [1], "A cancelled attempt sent a sequence")
    XCTAssertEqual(try credentials.load().active, working)
  }

  // MARK: 3. Limited history never turns a real distance into 0 km

  /// Health shares distance only from a date after an older workout
  /// started: that workout's empty distance lookup is ambiguous, so it waits.
  /// A run inside the shared history has no distance to read, so it is sent.
  func testAnOlderRunBeforeTheDistanceHistoryLimitWaits() async throws {
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00Z"))
    h.health.distanceStart(.answered(date("2026-11-15T00:00:00Z")))
    let older = Sample.run(1, date("2026-11-12T02:00:00Z"), km: RunDistance.none)
    let recent = Sample.run(2, date("2026-11-17T02:00:00Z"), km: RunDistance.none)
    h.health.add(older, recent)
    try await h.engine().run(mode: .foreground)
    XCTAssertFalse(h.fitness.sentRefs.contains(older.ref))
    XCTAssertEqual(h.state.deferred[older.id.uuidString.lowercased()]?.reason, .distanceAccess)
    XCTAssertTrue(h.fitness.sentRefs.contains(recent.ref))
  }

  /// A boundary at the workout's start covers it.
  func testABoundaryAtTheWorkoutStartCoversIt() async throws {
    let start = date("2026-11-12T02:00:00Z")
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00Z"))
    h.health.distanceStart(.answered(start))
    h.health.add(Sample.run(1, start, km: RunDistance.none))
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.run(1, start).ref])
  }

  /// Without a reported start date, no run with an empty distance lookup is
  /// sent: the lookup is unavailable (built with an SDK without it, or
  /// before iOS 27), failed, or Health left distance out of its answer.
  func testUnknownCoverageHoldsEveryRunWithoutDistance() async throws {
    for answer in [DistanceStartAnswer.unavailable, .failed, .answered(nil)] {
      let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00Z"))
      h.health.distanceStart(answer)
      let run = Sample.run(1, date("2026-11-19T00:00:00Z"), minutes: 30, km: RunDistance.none)
      let measured = Sample.run(2, date("2026-11-18T00:00:00Z"), km: .km(5))
      h.health.add(run, measured)
      try await h.engine().run(mode: .foreground)
      XCTAssertEqual(h.fitness.sentRefs, [measured.ref], "\(answer)")
      XCTAssertEqual(h.state.deferred[run.id.uuidString.lowercased()]?.reason, .distanceAccess, "\(answer)")
    }
  }

  func testCoverageComesOnlyFromAReportedDate() {
    let start = date("2026-11-15T00:00:00Z")
    XCTAssertFalse(DistanceAccess(.unavailable).covers(start))
    XCTAssertFalse(DistanceAccess(.failed).covers(start))
    XCTAssertFalse(DistanceAccess(.answered(nil)).covers(start))
    XCTAssertTrue(DistanceAccess(.answered(start)).covers(start))
    XCTAssertTrue(DistanceAccess(.answered(start)).covers(start.addingTimeInterval(1)))
    XCTAssertFalse(DistanceAccess(.answered(start)).covers(start.addingTimeInterval(-1)))
  }

  /// Once Health shares distance for the older workout's time, its late
  /// distance is found and sent.
  func testAnOlderRunIsSentWithItsDistanceOnceAccessCoversIt() async throws {
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00Z"))
    h.health.distanceStart(.answered(date("2026-11-15T00:00:00Z")))
    let start = date("2026-11-12T02:00:00Z")
    h.health.add(Sample.run(1, start, km: RunDistance.none))
    try await h.engine().run(mode: .foreground)
    XCTAssertTrue(h.fitness.received.isEmpty)
    h.health.distanceStart(.answered(.distantPast))
    h.health.delete(Sample.id(1))
    h.health.add(Sample.run(1, start, km: .km(4.2)))
    try await h.engine().run(mode: .background)
    let workouts = (h.fitness.received.last?.body["data"] as? [String: Any])?["workouts"] as? [[String: Any]]
    XCTAssertEqual((workouts?.first?["distance"] as? [String: Any])?["qty"] as? Double, 4.2)
  }

  /// The user's choice sends the runs the status screen showed. A run that
  /// starts waiting later needs its own choice.
  func testSendingWithoutDistanceCoversOnlyTheRunsShown() async throws {
    let now = date("2026-11-20T02:00:00Z")
    let (device, store) = try await activeLifecycle(cutoff: date("2026-11-10T00:00:00Z"), states: MemoryStates())
    let h = Harness(now: now, cutoff: date("2026-11-10T00:00:00Z"))
    h.health.distanceStart(.unavailable)
    let first = Sample.run(1, date("2026-11-12T02:00:00Z"), km: RunDistance.none)
    h.health.add(first)
    try await sync(h, device, store, .foreground)
    XCTAssertTrue(h.fitness.sentRefs.isEmpty)
    let shown = try await screen(device, store)
    XCTAssertEqual(shown.runs, [first.id.uuidString.lowercased()])
    let approved = try await device.sendRunsWithoutDistance(runs: shown.runs, enrollmentId: shown.enrollmentId)
    XCTAssertEqual(approved, 1)
    // Approved runs leave the list the screen offers.
    let afterChoice = try await screen(device, store)
    XCTAssertEqual(afterChoice.runs, [])
    let later = Sample.run(2, date("2026-11-14T02:00:00Z"), km: RunDistance.none)
    h.health.add(later)
    try await sync(h, device, store, .foreground)
    XCTAssertEqual(h.fitness.sentRefs, [first.ref])
    XCTAssertEqual(try store.load()?.deferred[later.id.uuidString.lowercased()]?.reason, .distanceAccess)
    XCTAssertEqual(try store.load()?.approvedWithoutDistance, [])
  }

  /// The reviewer's reproduction: the screen shows one run, a background
  /// sync adds a second before the tap, and the tap names the one run shown.
  /// The choice is refused, nothing is sent, and the refreshed screen shows
  /// both runs for a new choice.
  func testAStaleOneRunChoiceSendsNothingAfterASecondRunWaits() async throws {
    let now = date("2026-11-20T02:00:00Z")
    let (device, store) = try await activeLifecycle(cutoff: date("2026-11-10T00:00:00Z"), states: MemoryStates())
    let h = Harness(now: now, cutoff: date("2026-11-10T00:00:00Z"))
    h.health.distanceStart(.unavailable)
    let first = Sample.run(1, date("2026-11-12T02:00:00Z"), km: RunDistance.none)
    let next = Sample.run(2, date("2026-11-14T02:00:00Z"), km: RunDistance.none)
    h.health.add(first)
    try await sync(h, device, store, .foreground)
    let shown = try await screen(device, store)
    XCTAssertEqual(shown.runs.count, 1)
    h.health.add(next)
    try await sync(h, device, store, .background)
    do {
      try await device.sendRunsWithoutDistance(runs: shown.runs, enrollmentId: shown.enrollmentId)
      XCTFail("A choice for a list that changed was accepted")
    } catch LifecycleError.waitingRunsChanged {}
    try await sync(h, device, store, .foreground)
    XCTAssertTrue(h.fitness.sentRefs.isEmpty)
    let refreshed = try await screen(device, store)
    XCTAssertEqual(refreshed.runs.count, 2)
    // A new tap on the refreshed screen sends both.
    try await device.sendRunsWithoutDistance(runs: refreshed.runs, enrollmentId: refreshed.enrollmentId)
    try await sync(h, device, store, .foreground)
    XCTAssertEqual(Set(h.fitness.sentRefs), [first.ref, next.ref])
  }

  /// A choice shown for another enrollment approves nothing.
  func testAChoiceForAnotherEnrollmentApprovesNothing() async throws {
    let now = date("2026-11-20T02:00:00Z")
    let (device, store) = try await activeLifecycle(cutoff: date("2026-11-10T00:00:00Z"), states: MemoryStates())
    let h = Harness(now: now, cutoff: date("2026-11-10T00:00:00Z"))
    h.health.distanceStart(.unavailable)
    h.health.add(Sample.run(1, date("2026-11-12T02:00:00Z"), km: RunDistance.none))
    try await sync(h, device, store, .foreground)
    let shown = try await screen(device, store)
    do {
      try await device.sendRunsWithoutDistance(runs: shown.runs, enrollmentId: "another-enrollment")
      XCTFail("A choice for another enrollment was accepted")
    } catch LifecycleError.enrollmentChanged {}
    // An empty list is never a choice.
    do {
      try await device.sendRunsWithoutDistance(runs: [], enrollmentId: shown.enrollmentId)
      XCTFail("An empty choice was accepted")
    } catch LifecycleError.waitingRunsChanged {}
    try await sync(h, device, store, .foreground)
    XCTAssertTrue(h.fitness.sentRefs.isEmpty)
    XCTAssertEqual(try store.load()?.approvedWithoutDistance, [])
  }

  // MARK: 4. Retry-After counts from the reply

  func testRevocationRetryAfterStartsWhenTheReplyArrives() async throws {
    let clock = TestClock(date("2026-11-20T02:00:00Z"))
    let credentials = MemoryCredentials()
    try credentials.save(CredentialDocument(pending: [
      PendingRevocation(key: "ak_prior", userId: "user_prior", apiOrigin: origin.absoluteString)
    ]))
    let transport = SlowRevocation(clock)
    let device = DeviceLifecycle(
      credentials: credentials, states: MemoryStates(), origin: origin, deviceName: { "iPhone" },
      makeAPI: { try? FitnessAPI(origin: $0, transport: transport, clock: { clock.now }) }, now: { clock.now })
    _ = await device.revokePending()
    XCTAssertEqual(try credentials.load().pending.first?.retryAt, clock.now.addingTimeInterval(10))
    _ = await device.revokePending()
    XCTAssertEqual(transport.attempts.get, 1)
  }

  // MARK: Helpers

  /// What the status screen shows: the waiting runs and the enrollment.
  private func screen(_ device: DeviceLifecycle, _ store: StateStorage) async throws -> (
    runs: [String], enrollmentId: String
  ) {
    let enrollment = try await device.document().active?.enrollmentId
    return (try XCTUnwrap(store.load()).runsAwaitingDistanceAccess, try XCTUnwrap(enrollment))
  }

  private func sync(_ h: Harness, _ device: DeviceLifecycle, _ store: StateStorage, _ mode: RunMode) async throws {
    try await engine(h, device: device, store: store, check: RealLifecycleCheck(lifecycle: device)).run(mode: mode)
  }

  /// A lifecycle with a confirmed key whose first sync has started.
  private func activeLifecycle(
    cutoff: Date, states: StateDirectory, credentials: MemoryCredentials = MemoryCredentials()
  ) async throws -> (DeviceLifecycle, StateStorage) {
    let devices = FakeDevices()
    let device = DeviceLifecycle(
      credentials: credentials, states: states, origin: origin,
      deviceName: { "iPhone" }, makeAPI: { try? FitnessAPI(origin: $0, transport: devices) })
    _ = try await device.enroll(token: "a", revokeLater: false)
    let pending = try XCTUnwrap(credentials.load().active)
    let active = try await device.confirm(cutoff: cutoff, enrollmentId: pending.enrollmentId)
    try await device.startFirstSync()
    let store = states.storage(for: active)
    var state = try XCTUnwrap(store.load())
    state.anchors = [.weight: Data("0".utf8), .run: Data("0".utf8)]
    try store.save(state)
    return (device, store)
  }

  private func engine(
    _ h: Harness, device: DeviceLifecycle, store: StateStorage, check: SessionCheck
  ) async throws -> SyncEngine {
    let api = try FitnessAPI(origin: origin, transport: h.fitness)
    let session = try await device.currentSession()
    let now = h.clock.now
    return SyncEngine(
      source: h.health, api: api, storage: store, check: check, session: try XCTUnwrap(session), now: { now })
  }

  /// A sample from before the narrowed cutoff is never sent by later runs.
  private func assertExcludedSampleStaysUnsent(
    _ h: Harness, device: DeviceLifecycle, store: StateStorage, file: StaticString = #filePath, line: UInt = #line
  ) async throws {
    let excluded = Sample.weight(81, date("2026-11-13T00:00:00Z"))
    h.health.add(excluded)
    let next = try await engine(h, device: device, store: store, check: RealLifecycleCheck(lifecycle: device))
    try await next.run(mode: .foreground)
    try await next.run(mode: .foreground)
    XCTAssertFalse(h.fitness.sentRefs.contains(excluded.ref), file: file, line: line)
  }
}

/// The lifecycle's own check, as the app uses it.
private struct RealLifecycleCheck: SessionCheck {
  let lifecycle: DeviceLifecycle
  func isCurrent(_ session: SyncSession) async -> Bool { await lifecycle.isCurrent(session) }
  func commit(_ session: SyncSession, _ write: @Sendable () throws -> Bool) async throws -> Bool {
    try await lifecycle.commit(session, write)
  }
}

/// The lifecycle's check, holding once after it is armed: the session
/// check has passed and the checkpoint write has not started.
private final class PausingCheck: SessionCheck, @unchecked Sendable {
  let lifecycle: DeviceLifecycle
  let armed = Locked(false)
  let gate = Gate()
  init(lifecycle: DeviceLifecycle) { self.lifecycle = lifecycle }
  func arm() { armed.with { $0 = true } }
  func isCurrent(_ session: SyncSession) async -> Bool {
    let current = await lifecycle.isCurrent(session)
    let hold = armed.with { armed -> Bool in
      defer { armed = false }
      return armed
    }
    if hold { await gate.pass() }
    return current
  }
  func commit(_ session: SyncSession, _ write: @Sendable () throws -> Bool) async throws -> Bool {
    try await lifecycle.commit(session, write)
  }
}

/// Revocation replies that arrive 20 seconds after the request, asking the
/// app to wait 10 seconds more.
private final class SlowRevocation: HTTPTransport, @unchecked Sendable {
  let clock: TestClock
  let attempts = Locked(0)
  init(_ clock: TestClock) { self.clock = clock }
  func send(_ request: URLRequest) async -> HTTPReply? {
    attempts.with { $0 += 1 }
    clock.advance(20)
    return HTTPReply(status: 503, headers: ["Retry-After": "10"])
  }
}

/// The device routes, holding the first revocation.
private final class RemovalGate: HTTPTransport, @unchecked Sendable {
  let devices = FakeDevices()
  let pendingDelete = Gate()
  let deletes = Locked(0)
  func send(_ request: URLRequest) async -> HTTPReply? {
    let count = deletes.with { deletes -> Int in
      if request.httpMethod == "DELETE" { deletes += 1 }
      return deletes
    }
    if request.httpMethod == "DELETE", count == 1 { await pendingDelete.pass() }
    return await devices.send(request)
  }
}

/// Sync state in memory whose next write can be held part way.
private final class WriteRaceDirectory: StateDirectory, @unchecked Sendable {
  let data = Locked<SyncState?>(nil)
  let release = DispatchSemaphore(value: 0)
  let started = Gate()
  let isHolding = Locked(false)
  /// The cutoff of each completed write, in order, from the first held one.
  let writes = Locked<[Date]>([])
  private let recording = Locked(false)

  func storage(for credential: DeviceCredential) -> StateStorage { Storage(directory: self) }
  func clear(keeping credential: DeviceCredential?) throws { if credential == nil { data.with { $0 = nil } } }

  private struct Storage: StateStorage {
    let directory: WriteRaceDirectory
    func load() throws -> SyncState? { directory.data.get }
    func save(_ state: SyncState) throws {
      let hold = directory.isHolding.with { holding -> Bool in
        defer { holding = false }
        return holding
      }
      if hold {
        directory.recording.with { $0 = true }
        Task { await directory.started.pass() }
        guard directory.release.wait(timeout: .now() + 10) == .success else {
          throw CocoaError(.fileWriteUnknown)
        }
      }
      directory.data.with { $0 = state }
      if directory.recording.get { directory.writes.with { $0.append(state.cutoff) } }
    }
    func clear() throws { directory.data.with { $0 = nil } }
  }
}
