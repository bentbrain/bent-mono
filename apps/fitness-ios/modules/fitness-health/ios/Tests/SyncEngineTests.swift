import XCTest
@testable import FitnessHealthCore

/// Midday on 20 November 2026 in Brisbane.
private let noon = date("2026-11-20T02:00:00Z")
private let cutoff = date("2026-11-10T00:00:00+10:00")

final class SyncEngineTests: XCTestCase {
  private func harness() -> Harness { Harness(now: noon, cutoff: cutoff) }

  // MARK: Backfill

  func testBackfillSendsWholeDaysInOrderThenInstallsTheBaseline() async throws {
    let h = harness()
    h.health.add(
      Sample.weight(2, date("2026-11-12T18:00:00+10:00")),
      Sample.weight(1, date("2026-11-12T06:00:00+10:00")),
      Sample.run(1, date("2026-11-13T06:00:00+10:00")),
      Sample.weight(9, date("2026-11-01T06:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(
      h.fitness.sentRefs,
      [Sample.weight(1, noon).ref, Sample.weight(2, noon).ref, Sample.run(1, noon).ref])
    XCTAssertEqual(h.fitness.received.first?.expectedTimezone, "Australia/Brisbane")
    XCTAssertTrue(h.state.incrementalEnabled)
    XCTAssertNil(h.state.backfill)
    XCTAssertEqual(h.state.history.last?.counts["weight.new"], 2)
  }

  func testBackgroundRunsDoNotBackfill() async throws {
    let h = harness()
    h.health.add(Sample.weight(1, date("2026-11-12T06:00:00+10:00")))
    try await h.engine().run(mode: .background)
    XCTAssertTrue(h.fitness.received.isEmpty)
    XCTAssertFalse(h.state.incrementalEnabled)
  }

  func testBackfillResumesAfterTheLastCompletedDay() async throws {
    var h = harness()
    h.limits.pageSize = 1
    for day in 11...15 {
      h.health.add(Sample.weight(day, date("2026-11-\(day)T06:00:00+10:00")))
    }
    // 11 and 12 Nov succeed; the reply for 13 Nov is lost.
    h.fitness.script(.pass, .pass, .loseReply)
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .foreground))
    XCTAssertEqual(h.state.backfill?.through, "2026-11-12")
    try await h.engine().run(mode: .foreground)
    let refs = h.fitness.sentRefs
    XCTAssertEqual(refs.filter { $0 == Sample.weight(11, noon).ref }.count, 1)
    XCTAssertEqual(refs.filter { $0 == Sample.weight(13, noon).ref }.count, 2)
    XCTAssertEqual(Set(refs), Set((11...15).map { Sample.weight($0, noon).ref }))
    XCTAssertTrue(h.state.incrementalEnabled)
  }

  func testASampleAddedToACompletedDayArrivesAfterTheBaseline() async throws {
    var h = harness()
    h.limits.pageSize = 1
    for day in 11...14 {
      h.health.add(Sample.weight(day, date("2026-11-\(day)T06:00:00+10:00")))
    }
    h.fitness.script(.pass, .loseReply)
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .foreground))
    XCTAssertEqual(h.state.backfill?.through, "2026-11-11")
    XCTAssertNotNil(h.state.backfill?.snapshotAnchors)
    // Added after the snapshot, on a day the backfill already finished.
    h.health.add(Sample.weight(99, date("2026-11-11T19:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    // Backfill requests carry the timezone; the incremental one does not.
    let carrying = h.fitness.received.filter { $0.refs.contains(Sample.weight(99, noon).ref) }
    XCTAssertEqual(carrying.map(\.expectedTimezone), [nil])
  }

  func testSplitDayMarksTheDayOnlyAfterItsLastChunk() async throws {
    var h = harness()
    h.limits.pageSize = 2
    h.limits.serverSamples = 2
    for n in 1...3 {
      h.health.add(Sample.weight(n, date("2026-11-12T0\(n):00:00+10:00")))
    }
    // 12 Nov is split into [1, 2] and [3]; the second chunk's reply is lost.
    h.fitness.onRequest(nil)
    let engine = try h.engine()
    // [1, 2] succeeds and the reply for [3] is lost.
    h.fitness.script(.pass, .loseReply)
    await XCTAssertThrowsRunStop(try await engine.run(mode: .foreground))
    // [1, 2] succeeded but [3] was lost: 12 Nov is not done.
    XCTAssertEqual(h.state.backfill?.through, "2026-11-11")
    try await engine.run(mode: .foreground)
    XCTAssertTrue(h.state.incrementalEnabled)
    // The whole day was sent again; the ledger answers already_imported.
    XCTAssertEqual(h.fitness.sentRefs.filter { $0 == Sample.weight(1, noon).ref }.count, 2)
    // All three were recorded, the last one before its reply was lost.
    XCTAssertEqual(h.state.history.last?.counts["weight.already_imported"], 3)
  }

  func testTimezoneChangeAfterACompletedDayRewindsToTheCutoff() async throws {
    var h = harness()
    h.limits.pageSize = 1
    h.health.add(
      Sample.weight(1, date("2026-11-11T06:00:00+10:00")),
      Sample.weight(2, date("2026-11-13T06:00:00+10:00")))
    h.fitness.onRequest { [fitness = h.fitness] count in
      if count == 1 { fitness.timezone = "Pacific/Auckland" }
    }
    try await h.engine().run(mode: .foreground)
    let requests = h.fitness.received
    // 11 Nov in Brisbane, refused 13 Nov, then both again in Auckland days.
    XCTAssertEqual(requests.map(\.expectedTimezone), [
      "Australia/Brisbane", "Australia/Brisbane", "Pacific/Auckland", "Pacific/Auckland",
    ])
    XCTAssertEqual(h.state.accountTimezone, "Pacific/Auckland")
    XCTAssertTrue(h.state.incrementalEnabled)
  }

  func testExpandedBackfillInterruptedByATimezoneChange() async throws {
    var h = harness()
    h.limits.pageSize = 1
    h.health.add(
      Sample.weight(1, date("2026-11-05T06:00:00+10:00")),
      Sample.weight(2, date("2026-11-12T06:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.weight(2, noon).ref])
    // The cutoff moves earlier: a new backfill with its own snapshot.
    var state = h.state
    let earlier = date("2026-11-01T00:00:00+10:00")
    state = SyncState(cutoff: earlier, accountTimezone: state.accountTimezone)
    try h.storage.save(state)
    h.fitness.script(.loseReply)
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .foreground))
    XCTAssertEqual(h.state.backfill?.cutoff, earlier)
    h.fitness.timezone = "Pacific/Auckland"
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.state.accountTimezone, "Pacific/Auckland")
    XCTAssertEqual(h.fitness.received.last?.expectedTimezone, "Pacific/Auckland")
    XCTAssertTrue(h.fitness.sentRefs.contains(Sample.weight(1, noon).ref))
    XCTAssertTrue(h.state.incrementalEnabled)
  }

  func testAccountDaysDifferFromDeviceDays() async throws {
    // The device is in Los Angeles; the account in Brisbane. A weigh-in at
    // 23:30 on 11 Nov in Los Angeles is 17:30 on 12 Nov in Brisbane.
    var h = harness()
    h.deviceTimeZone = TimeZone(identifier: "America/Los_Angeles")!
    h.limits.pageSize = 2
    let lateLocal = date("2026-11-11T23:30:00-08:00")
    let early = date("2026-11-12T06:00:00+10:00")
    let next = date("2026-11-13T06:00:00+10:00")
    h.health.add(Sample.weight(1, early), Sample.weight(2, lateLocal), Sample.weight(3, next))
    try await h.engine().run(mode: .foreground)
    // 12 Nov (account) holds both samples and goes in one request.
    XCTAssertEqual(h.fitness.received.first?.refs, [Sample.weight(1, noon).ref, Sample.weight(2, noon).ref])
    // Timestamps carry the device's offset.
    let first = (h.fitness.received.first?.body["data"] as? [String: Any])?["metrics"] as? [[String: Any]]
    let dates = (first?.first?["data"] as? [[String: Any]])?.compactMap { $0["date"] as? String }
    XCTAssertEqual(dates?.last, "2026-11-11T23:30:00.000-08:00")
  }

  func testLocalMidnightDiffersFromAccountMidnight() async throws {
    var h = harness()
    h.deviceTimeZone = TimeZone(identifier: "UTC")!
    h.limits.pageSize = 1
    // 15:30 UTC on 11 Nov is 01:30 on 12 Nov in Brisbane.
    h.health.add(Sample.weight(1, date("2026-11-11T15:30:00Z")))
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.fitness.received.count, 1)
    XCTAssertEqual(h.state.backfill, nil)
    let days = AccountDays(timezone: "Australia/Brisbane")!
    XCTAssertEqual(days.day(date("2026-11-11T15:30:00Z")), "2026-11-12")
  }

  func testDaylightSavingDaysKeepTheirLength() {
    let days = AccountDays(timezone: "Australia/Sydney")!
    let start = days.start(of: "2026-10-04")!
    // Clocks go forward that morning, so the day is 23 hours.
    XCTAssertEqual(days.next(start).timeIntervalSince(start), 23 * 3600)
  }

  // MARK: Deferred samples

  func testFutureSamplesAreHeldUntilTheyAreDue() async throws {
    let h = harness()
    let later = date("2026-11-20T20:00:00+10:00")
    h.health.add(Sample.weight(1, later))
    try await h.engine().run(mode: .foreground)
    XCTAssertTrue(h.fitness.received.isEmpty)
    XCTAssertEqual(h.state.deferred[Sample.id(1).uuidString.lowercased()]?.reason, .future)
    // No new Health write; the clock passes the sample.
    h.clock.advance(12 * 3600)
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.weight(1, noon).ref])
    XCTAssertTrue(h.state.deferred.isEmpty)
  }

  func testAFutureSampleSeenAtSnapshotIsDeliveredOnceDue() async throws {
    let h = harness()
    let nextWeek = date("2026-11-27T06:00:00+10:00")
    h.health.add(Sample.weight(1, nextWeek))
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.state.deferred.count, 1)
    h.clock.advance(8 * 86_400)
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.weight(1, noon).ref])
  }

  func testAReadableSampleFarInTheFutureIsKept() async throws {
    let h = harness()
    h.health.add(Sample.weight(1, date("2027-03-01T06:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    h.clock.advance(45 * 86_400)
    try await h.engine().run(mode: .background)
    XCTAssertNotNil(h.state.deferred[Sample.id(1).uuidString.lowercased()])
    XCTAssertNil(h.state.deferred[Sample.id(1).uuidString.lowercased()]?.firstEmptyAt)
  }

  func testUnreadableItemsAreRetiredThirtyDaysAfterTheFirstEmptyRead() async throws {
    let h = harness()
    h.health.add(Sample.weight(1, date("2027-03-01T06:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    let id = Sample.id(1).uuidString.lowercased()
    h.health.hide([Sample.id(1)])
    try await h.engine().run(mode: .background)
    let first = h.state.deferred[id]?.firstEmptyAt
    XCTAssertNotNil(first)
    h.clock.advance(20 * 86_400)
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.state.deferred[id]?.firstEmptyAt, first)
    // A successful read in between resets the clock.
    h.health.hide([])
    try await h.engine().run(mode: .background)
    XCTAssertNil(h.state.deferred[id]?.firstEmptyAt)
    h.health.hide([Sample.id(1)])
    h.clock.advance(20 * 86_400)
    try await h.engine().run(mode: .background)
    XCTAssertNotNil(h.state.deferred[id])
    h.clock.advance(31 * 86_400)
    try await h.engine().run(mode: .background)
    XCTAssertNil(h.state.deferred[id])
    XCTAssertEqual(h.state.unreadableRetired, 1)
  }

  func testAQueryErrorKeepsDeferredItems() async throws {
    let h = harness()
    h.health.add(Sample.weight(1, date("2027-03-01T06:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    h.health.hide([Sample.id(1)])
    h.health.failLookups(true)
    h.clock.advance(40 * 86_400)
    try await h.engine().run(mode: .background)
    // A failed lookup is not an empty answer: no clock starts.
    XCTAssertEqual(h.state.deferred.count, 1)
    XCTAssertNil(h.state.deferred.first?.value.firstEmptyAt)
  }

  func testADeletedDeferredSampleIsDropped() async throws {
    let h = harness()
    h.health.add(Sample.weight(1, date("2026-11-25T06:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.state.deferred.count, 1)
    h.health.delete(Sample.id(1))
    try await h.engine().run(mode: .background)
    XCTAssertTrue(h.state.deferred.isEmpty)
    XCTAssertEqual(h.state.unreadableRetired, 0)
  }

  func testServerFutureOutcomesAreDeferred() async throws {
    let h = harness()
    h.fitness.today("2026-11-11")
    h.health.add(Sample.weight(1, date("2026-11-12T06:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.state.deferred[Sample.id(1).uuidString.lowercased()]?.reason, .serverFuture)
    h.fitness.today(nil)
    try await h.engine().run(mode: .background)
    XCTAssertTrue(h.state.deferred.isEmpty)
    XCTAssertEqual(h.state.history.last?.counts["weight.new"], 1)
  }

  // MARK: Run distance

  func testARecentRunWithoutDistanceWaitsSixHoursThenSendsWithoutOne() async throws {
    let h = harness()
    h.health.add(Sample.run(1, date("2026-11-20T10:00:00+10:00"), km: RunDistance.none))
    try await h.engine().run(mode: .foreground)
    XCTAssertEqual(h.state.deferred[Sample.id(1).uuidString.lowercased()]?.reason, .awaitingDistance)
    XCTAssertTrue(h.fitness.received.isEmpty)
    h.clock.advance(7 * 3600)
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.run(1, noon).ref])
    let workout = (h.fitness.received.last?.body["data"] as? [String: Any])?["workouts"] as? [[String: Any]]
    XCTAssertNil(workout?.first?["distance"])
    XCTAssertEqual(h.state.runsWithoutDistance, 1)
  }

  func testAnUnknownDistanceIsNeverSentAsZero() async throws {
    let h = harness()
    h.health.add(Sample.run(1, date("2026-11-12T06:00:00+10:00"), km: .unknown))
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .foreground))
    h.clock.advance(7 * 3600)
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .foreground))
    XCTAssertTrue(h.fitness.received.isEmpty)
  }

  func testDistanceFallsBackInOrder() async {
    let stats = await Distance.resolve(statistics: 5, associated: { 9 }, total: 7)
    XCTAssertEqual(stats, .km(5))
    let late = await Distance.resolve(statistics: 0, associated: { 3.1 }, total: nil)
    XCTAssertEqual(late, .km(3.1))
    let total = await Distance.resolve(statistics: nil, associated: { nil }, total: 4)
    XCTAssertEqual(total, .km(4))
    let none = await Distance.resolve(statistics: nil, associated: { 0 }, total: 0)
    XCTAssertEqual(none, RunDistance.none)
    let failed = await Distance.resolve(statistics: nil, associated: { throw CocoaError(.featureUnsupported) }, total: 4)
    XCTAssertEqual(failed, .unknown)
  }

  // MARK: Incremental

  func testIncrementalPagesCommitAfterEachAcceptedRequest() async throws {
    var h = harness()
    h.limits.pageSize = 2
    try await h.engine().run(mode: .foreground)
    for n in 1...5 {
      h.health.add(Sample.weight(n, date("2026-11-19T0\(n):00:00+10:00")))
    }
    // The first page is accepted; the second gets a malformed reply.
    h.fitness.script(.pass, .reply(okEmpty()))
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .background))
    XCTAssertEqual(h.fitness.sentRefs, [Sample.weight(1, noon).ref, Sample.weight(2, noon).ref])
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs, (1...5).map { Sample.weight($0, noon).ref })
  }

  func testALostReplyIsResentAndReportedAsAlreadySynced() async throws {
    let h = harness()
    try await h.engine().run(mode: .foreground)
    h.health.add(Sample.weight(1, date("2026-11-19T06:00:00+10:00")))
    h.fitness.script(.loseReply)
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .background))
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.weight(1, noon).ref, Sample.weight(1, noon).ref])
    XCTAssertEqual(h.state.history.last?.counts["weight.already_imported"], 1)
  }

  func testInterruptionAtTheCheckpointResendsThePage() async throws {
    let h = harness()
    try await h.engine().run(mode: .foreground)
    h.health.add(Sample.weight(1, date("2026-11-19T06:00:00+10:00")))
    // The upload succeeds and the checkpoint write fails, as in a crash.
    h.storage.failSaves = 1
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .background))
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs.count, 2)
    XCTAssertEqual(h.state.history.last?.counts["weight.already_imported"], 1)
  }

  func testDeletionOnlyPagesCommitTheirAnchor() async throws {
    let h = harness()
    h.health.add(Sample.weight(1, date("2026-11-19T06:00:00+10:00")))
    try await h.engine().run(mode: .foreground)
    let before = h.state.anchors?[.weight]
    h.health.delete(Sample.id(1))
    try await h.engine().run(mode: .background)
    XCTAssertNotEqual(h.state.anchors?[.weight], before)
    XCTAssertEqual(h.fitness.received.count, 1)
  }

  func testTooManySamplesSplitsInOrder() async throws {
    var h = harness()
    h.limits.pageSize = 4
    h.fitness.limit(2)
    try await h.engine().run(mode: .foreground)
    for n in 1...4 {
      h.health.add(Sample.weight(n, date("2026-11-19T0\(n):00:00+10:00")))
    }
    try await h.engine().run(mode: .background)
    let accepted = h.fitness.received.filter { $0.refs.count <= 2 && !$0.refs.isEmpty }.map(\.refs)
    XCTAssertEqual(accepted.flatMap { $0 }, (1...4).map { Sample.weight($0, noon).ref })
  }

  func testASingleSampleTooLargePausesItsType() async throws {
    let h = harness()
    try await h.engine().run(mode: .foreground)
    h.health.add(Sample.weight(1, date("2026-11-19T06:00:00+10:00")))
    h.fitness.script(.reply(HTTPReply(status: 413, body: Data(#"{"error":"big","code":"payload_too_large"}"#.utf8))))
    try await h.engine().run(mode: .background)
    XCTAssertNotNil(h.state.paused[.weight])
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.received.count, 0)
    // Sync now resumes the type.
    try await h.engine().run(mode: .foreground, force: true)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.weight(1, noon).ref])
    XCTAssertNil(h.state.paused[.weight])
  }

  func testABadRequestHoldsTheCursor() async throws {
    let h = harness()
    try await h.engine().run(mode: .foreground)
    h.health.add(Sample.run(1, date("2026-11-19T06:00:00+10:00")))
    let anchor = h.state.anchors?[.run]
    h.fitness.script(.reply(HTTPReply(
      status: 400, body: Data(#"{"error":"data.workouts.0.ref: bad","code":"invalid_device_request"}"#.utf8))))
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.state.anchors?[.run], anchor)
    XCTAssertEqual(h.state.paused[.run], "data.workouts.0.ref: bad")
    XCTAssertEqual(h.state.lastError, "needs_correction")
  }

  func testKeyInvalidStopsTheRun() async throws {
    let h = harness()
    try await h.engine().run(mode: .foreground)
    h.health.add(Sample.weight(1, date("2026-11-19T06:00:00+10:00")))
    h.fitness.script(.reply(HTTPReply(status: 401, body: Data(#"{"error":"x","code":"key_invalid"}"#.utf8))))
    do {
      try await h.engine().run(mode: .background)
      XCTFail("Expected the run to stop.")
    } catch {
      XCTAssertEqual(error as? RunStop, .keyInvalid)
    }
    XCTAssertEqual(h.state.lastError, "key_invalid")
  }

  func testALockedDeviceKeepsTheCheckpoint() async throws {
    let h = harness()
    try await h.engine().run(mode: .foreground)
    h.health.add(Sample.weight(1, date("2026-11-19T06:00:00+10:00")))
    let before = h.state.anchors
    h.health.lock(true)
    do {
      try await h.engine().run(mode: .background)
      XCTFail("Expected the run to stop.")
    } catch {
      XCTAssertEqual(error as? RunStop, .locked)
    }
    XCTAssertEqual(h.state.anchors, before)
    h.health.lock(false)
    try await h.engine().run(mode: .background)
    XCTAssertEqual(h.fitness.sentRefs, [Sample.weight(1, noon).ref])
  }

  func testAStaleSessionSendsAndWritesNothing() async throws {
    var h = harness()
    let check = SwitchableCheck()
    h.check = check
    h.health.add(Sample.weight(1, date("2026-11-12T06:00:00+10:00")))
    check.current.with { $0 = false }
    let before = h.state
    await XCTAssertThrowsRunStop(try await h.engine().run(mode: .foreground))
    XCTAssertTrue(h.fitness.received.isEmpty)
    XCTAssertEqual(h.state, before)
  }

  func testRepeatedExpirationAfterPartialSuccessStillProgresses() async throws {
    var h = harness()
    h.limits.pageSize = 1
    for day in 11...16 {
      h.health.add(Sample.weight(day, date("2026-11-\(day)T06:00:00+10:00")))
    }
    let check = SwitchableCheck()
    h.check = check
    // Each run is cut off after its second request, as if iOS took the
    // background time back.
    var runs = 0
    while !h.state.incrementalEnabled && runs < 10 {
      runs += 1
      let start = h.fitness.received.count
      check.current.with { $0 = true }
      h.fitness.onRequest { count in
        if count - start >= 2 { check.current.with { $0 = false } }
      }
      _ = try? await h.engine().run(mode: .foreground)
    }
    XCTAssertTrue(h.state.incrementalEnabled)
    XCTAssertEqual(Set(h.fitness.sentRefs), Set((11...16).map { Sample.weight($0, noon).ref }))
    XCTAssertLessThan(runs, 10)
  }
}

/// A 200 that is not a device reply.
func okEmpty() -> HTTPReply { HTTPReply(status: 200, body: Data("{}".utf8)) }

func XCTAssertThrowsRunStop(
  _ body: @autoclosure () async throws -> RunSummary, file: StaticString = #filePath, line: UInt = #line
) async {
  do {
    _ = try await body()
    XCTFail("Expected the run to stop.", file: file, line: line)
  } catch {
    XCTAssertTrue(error is RunStop, "Unexpected error \(error)", file: file, line: line)
  }
}
