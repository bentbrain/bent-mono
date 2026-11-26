import XCTest
@testable import FitnessHealthCore

/// Regression tests for the independent review of the iPhone app. Several
/// cases started from the reviewer's own reproductions.
final class ReviewRegressionTests: XCTestCase {
  private let origin = URL(string: "https://fitness.example.test")!

  // The lifecycle with its fake Keychain and fake device routes.
  // swiftlint:disable large_tuple
  private func makeLifecycle(
    now: @escaping @Sendable () -> Date = { Date() }
  ) -> (DeviceLifecycle, MemoryCredentials, FakeDevices) {
    // swiftlint:enable large_tuple
    let credentials = MemoryCredentials()
    let fake = FakeDevices()
    let device = DeviceLifecycle(
      credentials: credentials, states: MemoryStates(), origin: origin,
      deviceName: { "Test iPhone" }, makeAPI: { try? FitnessAPI(origin: $0, transport: fake) }, now: now)
    return (device, credentials, fake)
  }

  // MARK: 1. Overlapping attempts keep the highest successful sequence

  func testHighestSuccessWhenRepliesArriveInSequenceOrder() async throws {
    let (device, credentials, fake) = makeLifecycle()
    let earlier = Gate()
    let later = Gate()
    fake.state.with { $0.gates = [1: earlier, 2: later] }
    let first = Task { try await device.enroll(token: "a", revokeLater: false) }
    await earlier.reached()
    let second = Task { try await device.enroll(token: "b", revokeLater: false) }
    await later.reached()
    earlier.open()
    _ = try await first.value
    later.open()
    _ = try await second.value
    XCTAssertEqual(try credentials.load().active?.sequence, 2)
    XCTAssertFalse(fake.revoked.contains("fitness.example.test ak_issued_2"))
    // The replaced key waits for revocation on the next launch or sign-in.
    XCTAssertEqual(try credentials.load().pending.map(\.key), ["ak_issued_1"])
  }

  func testHighestSuccessWhenRepliesArriveInReverseOrder() async throws {
    let (device, credentials, fake) = makeLifecycle()
    let earlier = Gate()
    let later = Gate()
    fake.state.with { $0.gates = [1: earlier, 2: later] }
    let first = Task { try await device.enroll(token: "a", revokeLater: false) }
    await earlier.reached()
    let second = Task { try await device.enroll(token: "b", revokeLater: false) }
    await later.reached()
    later.open()
    _ = try await second.value
    earlier.open()
    let late = try await first.value
    XCTAssertEqual(late, .superseded)
    XCTAssertEqual(try credentials.load().active?.sequence, 2)
    XCTAssertEqual(fake.revoked, ["fitness.example.test ak_issued_1"])
  }

  func testADisconnectStillRevokesAnAttemptInFlight() async throws {
    let (device, credentials, fake) = makeLifecycle()
    let gate = Gate()
    fake.state.with { $0.gates = [1: gate] }
    let attempt = Task { try await device.enroll(token: "a", revokeLater: false) }
    await gate.reached()
    _ = try await device.disconnect()
    gate.open()
    let outcome = try await attempt.value
    XCTAssertEqual(outcome, .superseded)
    XCTAssertNil(try credentials.load().active)
    XCTAssertEqual(fake.revoked, ["fitness.example.test ak_issued_1"])
  }

  // MARK: 2. Consent acts only on the enrollment it showed

  func testPreviouslyDisplayedConsentCannotAuthorizeAReplacementKey() async throws {
    let (device, credentials, fake) = makeLifecycle()
    _ = try await device.enroll(token: "a", revokeLater: false)
    let shown = try XCTUnwrap(try credentials.load().active)
    fake.state.with { state in
      state.replies[2] = HTTPReply(
        status: 201,
        body: Data(
          #"{"secret":"ak_other","userId":"user_other","email":"other@example.test","accountTimezone":"UTC"}"#.utf8))
    }
    _ = try await device.enroll(token: "b", revokeLater: false)
    do {
      _ = try await device.confirm(cutoff: Date(), enrollmentId: shown.enrollmentId)
      XCTFail("Consent shown for one account confirmed another.")
    } catch {
      XCTAssertEqual(error as? LifecycleError, .enrollmentChanged)
    }
    XCTAssertEqual(try credentials.load().active?.state, .consentPending)
    do {
      _ = try await device.decline(enrollmentId: shown.enrollmentId)
      XCTFail("Decline shown for one account declined another.")
    } catch {
      XCTAssertEqual(error as? LifecycleError, .enrollmentChanged)
    }
    XCTAssertEqual(try credentials.load().active?.userId, "user_other")
  }

  // MARK: 3. A later cutoff leaves out history and deferred samples before it

  private func activeStorage(_ device: DeviceLifecycle, cutoff: Date) async throws -> StateStorage {
    _ = try await device.enroll(token: "a", revokeLater: false)
    _ = try await device.confirmPending(cutoff: cutoff)
    try await device.startFirstSync()
    let found = await device.storage()
    return try XCTUnwrap(found)
  }

  private func engine(_ h: Harness, storage: StateStorage, now: Date) throws -> SyncEngine {
    let old = try h.engine()
    return SyncEngine(
      source: old.source, api: old.api, storage: storage, check: old.check, session: old.session, now: { now })
  }

  func testANarrowedCutoffExcludesAnExistingDeferredSample() async throws {
    let (device, _, _) = makeLifecycle()
    let first = date("2026-11-10T00:00:00Z")
    let raised = date("2026-11-12T00:00:00Z")
    let now = date("2026-11-20T02:00:00Z")
    let storage = try await activeStorage(device, cutoff: first)
    let h = Harness(now: now, cutoff: first)
    let sample = Sample.weight(88, date("2026-11-11T00:00:00Z"))
    h.health.add(sample)
    var state = try XCTUnwrap(storage.load())
    state.anchors = [.weight: Data("1".utf8)]
    state.deferred[sample.id.uuidString.lowercased()] = DeferredItem(kind: .weight, reason: .serverFuture)
    try storage.save(state)
    try await device.setCutoff(raised)
    try await engine(h, storage: storage, now: now).run(mode: .foreground)
    XCTAssertTrue(h.fitness.sentRefs.isEmpty)
  }

  func testANarrowedCutoffExcludesAlreadySnapshottedHistory() async throws {
    let (device, _, _) = makeLifecycle()
    let first = date("2026-11-10T00:00:00Z")
    let raised = date("2026-11-12T00:00:00Z")
    let now = date("2026-11-20T02:00:00Z")
    let storage = try await activeStorage(device, cutoff: first)
    let h = Harness(now: now, cutoff: first)
    h.health.add(Sample.weight(88, date("2026-11-11T00:00:00Z")))
    var state = try XCTUnwrap(storage.load())
    state.backfill = Backfill(
      cutoff: first, snapshotAnchors: [.weight: Data("1".utf8)], snapshotDeferred: [:],
      timezone: "Australia/Brisbane")
    try storage.save(state)
    try await device.setCutoff(raised)
    try await engine(h, storage: storage, now: now).run(mode: .foreground)
    XCTAssertTrue(h.fitness.sentRefs.isEmpty)
  }

  func testDeferredSamplesBeforeTheCutoffAreDropped() async throws {
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00+10:00"))
    try await h.engine().run(mode: .foreground)
    let old = Sample.weight(5, date("2026-11-05T06:00:00+10:00"))
    h.health.add(old)
    var state = h.state
    state.deferred[old.id.uuidString.lowercased()] = DeferredItem(kind: .weight, reason: .serverFuture)
    try h.storage.save(state)
    try await h.engine().run(mode: .background)
    XCTAssertTrue(h.fitness.sentRefs.isEmpty)
    XCTAssertTrue(h.state.deferred.isEmpty)
  }

  // MARK: 4. Days stay whole across daylight-saving changes at midnight

  func testDaysStartAtTheirOwnStartInZonesThatChangeAtMidnightOrAt2300() throws {
    let zones = ["America/Santiago", "America/Nuuk", "America/Havana", "America/Asuncion", "Africa/Cairo"]
    for zone in zones {
      let days = try XCTUnwrap(AccountDays(timezone: zone))
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = days.timeZone
      var day = try XCTUnwrap(days.start(of: "2023-01-01"))
      while day < date("2027-01-01T12:00:00Z") {
        let next = days.next(day)
        XCTAssertEqual(next, calendar.startOfDay(for: next), "\(zone) \(days.day(day))")
        // No gap and no overlap: the instant before the next start is still
        // in this day, and the next start is in the following one.
        XCTAssertEqual(days.day(next.addingTimeInterval(-1)), days.day(day), zone)
        XCTAssertNotEqual(days.day(next), days.day(day), zone)
        XCTAssertEqual(days.start(of: days.day(next)), next, "\(zone) \(days.day(next))")
        day = next
      }
      // A thirty-day step lands on a day start too.
      let start = try XCTUnwrap(days.start(of: "2024-08-25"))
      let later = days.next(start, by: 30)
      XCTAssertEqual(later, calendar.startOfDay(for: later), zone)
    }
  }

  func testAMidnightDSTTransitionKeepsTheNextDaysFirstHour() async throws {
    let cutoff = date("2024-09-08T04:00:00Z")
    let nextDayEarly = date("2024-10-08T03:30:00Z")
    let now = date("2024-10-09T21:00:00Z")
    let days = try XCTUnwrap(AccountDays(timezone: "America/Santiago"))
    XCTAssertEqual(days.next(days.start(containing: cutoff)), date("2024-09-09T03:00:00Z"))
    let h = Harness(now: now, cutoff: cutoff, timezone: "America/Santiago")
    let sample = Sample.weight(45, nextDayEarly)
    h.health.add(sample)
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.fitness.sentRefs, [sample.ref])
  }

  func testA2300TransitionKeepsEveryHourOfTheDay() async throws {
    // Nuuk moves its clocks at 23:00 local; weigh-ins just before and after
    // the change and early the next day are all sent once.
    let samples = [
      Sample.weight(1, date("2024-03-30T23:30:00-02:00")),
      Sample.weight(2, date("2024-03-31T00:30:00-01:00")),
      Sample.weight(3, date("2024-10-26T22:30:00-01:00")),
      Sample.weight(4, date("2024-10-27T00:30:00-02:00")),
    ]
    let h = Harness(
      now: date("2024-11-10T12:00:00Z"), cutoff: date("2024-03-01T00:00:00Z"), timezone: "America/Nuuk")
    h.health.add(samples)
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(Set(h.fitness.sentRefs), Set(samples.map(\.ref)))
    XCTAssertEqual(h.fitness.sentRefs.count, samples.count)
  }

  // MARK: 5. A late key_invalid leaves a replacement key alone

  func testALateKeyInvalidThroughTheCoordinatorKeepsTheReplacementKey() async throws {
    let (device, credentials, _) = makeLifecycle()
    _ = try await device.enroll(token: "a", revokeLater: false)
    _ = try await device.confirmPending(cutoff: date("2026-11-10T00:00:00Z"))
    try await device.startFirstSync()
    let before = await device.session()
    let old = try XCTUnwrap(before)
    // The run with the old key gets 401 key_invalid only after the user
    // connected again and confirmed the new key.
    let gate = Gate()
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00Z"))
    h.fitness.script(.reply(HTTPReply(status: 401, body: Data(#"{"error":"x","code":"key_invalid"}"#.utf8))))
    h.fitness.onRequest { _ in }
    let stopped = Locked<[Bool]>([])
    let coordinator = SyncCoordinator(
      session: { old }, background: FakeBackground(),
      makeEngine: { session in
        await gate.pass()
        let base = try? h.engine()
        return base.map {
          SyncEngine(source: $0.source, api: $0.api, storage: h.storage, check: AlwaysCurrent(), session: session)
        }
      },
      onResult: { result, session in
        let stop = await RunOutcomePolicy.apply(result, session: session, lifecycle: device)
        stopped.with { $0.append(stop) }
      })
    h.health.add(Sample.weight(1, date("2026-11-12T06:00:00+10:00")))
    let run = Task { await coordinator.trigger(mode: .foreground) }
    await gate.reached()
    _ = try await device.enroll(token: "b", revokeLater: false)
    _ = try await device.confirmPending(cutoff: date("2026-11-10T00:00:00Z"))
    gate.open()
    await run.value
    XCTAssertEqual(stopped.get, [false])
    XCTAssertEqual(try credentials.load().active?.key, "ak_issued_2")
    XCTAssertFalse(try credentials.load().keyInvalid)
  }

  func testAKeyInvalidForTheStoredKeyClearsIt() async throws {
    let (device, credentials, _) = makeLifecycle()
    _ = try await device.enroll(token: "a", revokeLater: false)
    _ = try await device.confirmPending(cutoff: Date())
    let current = await device.session()
    let session = try XCTUnwrap(current)
    let stop = await RunOutcomePolicy.apply(.stopped(.keyInvalid), session: session, lifecycle: device)
    XCTAssertTrue(stop)
    XCTAssertNil(try credentials.load().active)
    XCTAssertTrue(try credentials.load().keyInvalid)
  }

  // MARK: 6. Expiry never advances the checkpoint

  func testExpirationWhileAwaitingTheFenceCannotCommit() async throws {
    let now = date("2026-11-20T02:00:00Z")
    var h = Harness(now: now, cutoff: date("2026-11-10T00:00:00Z"))
    // Held at the checkpoint that follows an accepted upload.
    let check = HeldCheck()
    h.check = check
    h.fitness.onRequest { _ in check.arm() }
    var state = h.state
    let zero = Data("0".utf8)
    state.anchors = [.weight: zero, .run: zero]
    try h.storage.save(state)
    h.health.add(Sample.weight(88, now))
    let engine = try h.engine()
    let background = FakeBackground()
    let coordinator = SyncCoordinator(
      session: { engine.session }, background: background, makeEngine: { _ in engine })
    let trigger = Task { await coordinator.trigger(mode: .background) }
    await check.gate.reached()
    background.expireAll()
    check.gate.open()
    await trigger.value
    XCTAssertEqual(h.fitness.received.count, 1)
    XCTAssertEqual(h.state.anchors?[.weight], zero)
  }

  func testBackgroundTimeIsTakenBeforeTheRunStarts() async throws {
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00Z"))
    let engine = try h.engine()
    let order = Locked<[String]>([])
    let background = RecordingBackground(order: order)
    let coordinator = SyncCoordinator(
      session: {
        order.with { $0.append("session") }
        return engine.session
      },
      background: background,
      makeEngine: { _ in engine })
    await coordinator.trigger(mode: .foreground)
    XCTAssertEqual(order.get.prefix(2), ["begin", "session"])
  }

  func testAClosedWriteFenceStopsCommits() async throws {
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00Z"))
    h.health.add(Sample.weight(1, date("2026-11-12T06:00:00+10:00")))
    let fence = WriteFence()
    fence.close()
    let before = h.state
    await XCTAssertThrowsRunStop(try await h.engine().fenced(by: fence).run(mode: .foreground))
    XCTAssertEqual(h.state, before)
    XCTAssertTrue(h.fitness.received.isEmpty)
  }

  // MARK: 7. Launch: the Health step, consent and a locked Keychain

  func testNothingRunsUntilTheHealthStepStartsTheFirstSync() async throws {
    let (device, credentials, _) = makeLifecycle()
    _ = try await device.enroll(token: "a", revokeLater: false)
    _ = try await device.confirmPending(cutoff: date("2026-11-10T00:00:00Z"))
    let found = await device.storage()
    let storage = try XCTUnwrap(found)
    XCTAssertEqual(try storage.load()?.awaitingHealthStep, true)
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00Z"))
    h.health.add(Sample.weight(1, date("2026-11-12T06:00:00+10:00")))
    try await engine(h, storage: storage, now: date("2026-11-20T02:00:00Z")).run(mode: .foreground)
    XCTAssertTrue(h.fitness.received.isEmpty)
    // A relaunch keeps the wait.
    let relaunched = DeviceLifecycle(
      credentials: credentials, states: MemoryStates(), origin: origin, deviceName: { "Test iPhone" },
      makeAPI: { _ in nil })
    let relaunchedSession = await relaunched.session()
    XCTAssertNotNil(relaunchedSession)
    XCTAssertEqual(try storage.load()?.awaitingHealthStep, true)
    try await device.startFirstSync()
    try await engine(h, storage: storage, now: date("2026-11-20T02:00:00Z")).run(mode: .foreground)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.weight(1, Date()).ref])
  }

  func testNoSessionWhileConsentIsPending() async throws {
    let (device, _, _) = makeLifecycle()
    _ = try await device.enroll(token: "a", revokeLater: false)
    let pending = try await device.currentSession()
    XCTAssertNil(pending)
  }

  func testALockedKeychainKeepsStateAndMarksARetry() async throws {
    let locked = LockedCredentials()
    let device = DeviceLifecycle(
      credentials: locked, states: MemoryStates(), origin: origin, deviceName: { "Test iPhone" },
      makeAPI: { _ in nil })
    do {
      _ = try await device.currentSession()
      XCTFail("A locked Keychain is not an absent credential.")
    } catch {
      XCTAssertEqual(error as? HealthAccessError, .protectedDataUnavailable)
    }
    let results = Locked<[RunResult]>([])
    let coordinator = SyncCoordinator(
      session: { try await device.currentSession() }, background: FakeBackground(),
      makeEngine: { _ in nil }, onResult: { result, _ in results.with { $0.append(result) } })
    let completed = Locked(0)
    await coordinator.trigger(mode: .background) { completed.with { $0 += 1 } }
    XCTAssertEqual(results.get, [.stopped(.locked)])
    XCTAssertEqual(completed.get, 1)
    let retry = await coordinator.retryPending
    XCTAssertTrue(retry)
    XCTAssertEqual(locked.saves.get, 0)
  }

  // MARK: 8. Without distance access, runs wait instead of becoming 0 km

  func testRunsWaitForDistanceAccessUntilTheUserChooses() async throws {
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00+10:00"))
    h.health.distanceStart(.answered(nil))
    h.health.add(Sample.run(1, date("2026-11-12T06:00:00+10:00"), km: RunDistance.none))
    try await h.engine().run(mode: .foreground)
    XCTAssertTrue(h.fitness.received.isEmpty)
    XCTAssertEqual(h.state.deferred[Sample.id(1).uuidString.lowercased()]?.reason, .distanceAccess)
    try await h.engine().run(mode: .background)
    XCTAssertTrue(h.fitness.received.isEmpty)
    var state = h.state
    state.approvedWithoutDistance = [Sample.id(1).uuidString.lowercased()]
    try h.storage.save(state)
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.run(1, Date()).ref])
    XCTAssertTrue(h.state.approvedWithoutDistance.isEmpty)
  }

  func testALateDistanceIsSentWhenAccessIsPartial() async throws {
    // Weight and workouts allowed, distance not readable yet: the run waits.
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00+10:00"))
    h.health.distanceStart(.answered(nil))
    let start = date("2026-11-12T06:00:00+10:00")
    h.health.add(Sample.run(1, start, km: RunDistance.none))
    try await h.engine().run(mode: .foreground)
    XCTAssertTrue(h.fitness.received.isEmpty)
    // Distance access is turned on and the late distance sample is found.
    h.health.distanceStart(.answered(.distantPast))
    h.health.delete(Sample.id(1))
    h.health.add(Sample.run(1, start, km: .km(3.1)))
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.run(1, start).ref])
    let workouts = (h.fitness.received.last?.body["data"] as? [String: Any])?["workouts"] as? [[String: Any]]
    XCTAssertEqual((workouts?.first?["distance"] as? [String: Any])?["qty"] as? Double, 3.1)
  }

  // MARK: 9. Snapshot pages apply deletions

  func testASnapshotDeletionOnALaterPageDropsTheDeferredSample() async throws {
    var h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00+10:00"))
    h.limits.snapshotPage = 1
    let future = Sample.weight(1, date("2026-11-25T06:00:00+10:00"))
    h.health.add(future)
    h.health.add(Sample.weight(2, date("2026-11-12T06:00:00+10:00")))
    // The future sample is on the first page and its deletion on a later one.
    h.health.delete(Sample.id(1))
    h.health.add(future)
    h.health.delete(Sample.id(1))
    try await h.engine().run(mode: .foreground)
    XCTAssertNil(h.state.deferred[Sample.id(1).uuidString.lowercased()])
  }

  // MARK: 10. State files

  func testTheDirectoryIsPreparedBeforeTheFirstWriteAndClearReportsFailures() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("state-\(UUID().uuidString)")
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
      try? FileManager.default.removeItem(at: root)
    }
    let order = Locked<[String]>([])
    let storage = FileStateStorage(
      directory: root.appendingPathComponent("account"),
      protection: FileProtection(
        writeOptions: [.atomic],
        prepareDirectory: { directory in
          let exists = FileManager.default.fileExists(atPath: directory.appendingPathComponent("state.json").path)
          order.with { $0.append(exists ? "prepare-after" : "prepare") }
        },
        verify: { _ in order.with { $0.append("verify") } }))
    try storage.save(SyncState(cutoff: Date(), accountTimezone: "UTC"))
    XCTAssertEqual(order.get, ["prepare", "verify"])
    // A missing state is fine; a state that cannot be removed throws.
    let missing = FileStateStorage(directory: root.appendingPathComponent("none"))
    XCTAssertNoThrow(try missing.clear())
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: root.path)
    XCTAssertThrowsError(try storage.clear())
  }

  // MARK: 11. Revocation timing and keys Fitness will not revoke

  func testRevocationHonorsRetryAfterAndRecordsKeysThatAreNotDeviceKeys() async throws {
    let clock = TestClock(date("2026-11-20T02:00:00Z"))
    let (device, credentials, fake) = makeLifecycle(now: { clock.now })
    _ = try await device.enroll(token: "a", revokeLater: false)
    fake.state.with { $0.revokeReplies = [HTTPReply(status: 503, headers: ["Retry-After": "120"])] }
    let remaining = try await device.disconnect()
    XCTAssertEqual(remaining, 1)
    XCTAssertEqual(try credentials.load().pending.first?.retryAt, clock.now.addingTimeInterval(120))
    let attempts = fake.revoked.count
    _ = await device.revokePending()
    XCTAssertEqual(fake.revoked.count, attempts, "Retried before Retry-After.")
    clock.advance(121)
    fake.state.with {
      $0.revokeReplies = [
        HTTPReply(status: 403, body: Data(#"{"error":"Not a device key.","code":"not_device_key"}"#.utf8))
      ]
    }
    let left = await device.revokePending()
    XCTAssertEqual(left, 0)
    XCTAssertEqual(try credentials.load().manualRevocations, 1)
    // The count outlives the disconnect, so the signed-out screen can show it.
    XCTAssertNil(try credentials.load().active)
    XCTAssertFalse(try credentials.load().keyInvalid)
    // Signing in again keeps it; only dismissing the notice clears it.
    _ = try await device.enroll(token: "b", revokeLater: false)
    XCTAssertEqual(try credentials.load().manualRevocations, 1)
    try await device.dismissManualRevocations()
    XCTAssertEqual(try credentials.load().manualRevocations, 0)
    try await device.dismissManualRevocations()
    XCTAssertEqual(try credentials.load().manualRevocations, 0)
  }
}

/// A session check that holds the first check after it is armed.
private final class HeldCheck: SessionCheck, @unchecked Sendable {
  let armed = Locked(false)
  let gate = Gate()
  func arm() { armed.with { $0 = true } }
  func isCurrent(_ session: SyncSession) async -> Bool {
    let hold = armed.with { armed -> Bool in
      defer { armed = false }
      return armed
    }
    if hold { await gate.pass() }
    return true
  }
}

private struct RecordingBackground: BackgroundTime {
  let order: Locked<[String]>
  func begin(expired: @escaping @Sendable () -> Void) async -> Int {
    order.with { $0.append("begin") }
    return 1
  }
  func end(_ id: Int) async {}
}

/// A Keychain that is locked, as before the first unlock after a restart.
private final class LockedCredentials: CredentialStore, @unchecked Sendable {
  let saves = Locked(0)
  func installationId() throws -> UUID { throw HealthAccessError.protectedDataUnavailable }
  func load() throws -> CredentialDocument { throw HealthAccessError.protectedDataUnavailable }
  func save(_ document: CredentialDocument) throws {
    saves.with { $0 += 1 }
    throw HealthAccessError.protectedDataUnavailable
  }
}
