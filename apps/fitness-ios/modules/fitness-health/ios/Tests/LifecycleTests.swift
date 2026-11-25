import XCTest
@testable import FitnessHealthCore

final class MemoryCredentials: CredentialStore, @unchecked Sendable {
  let document = Locked(CredentialDocument())
  let id = UUID(uuidString: "3B0F6A52-8C1D-4E7F-9A2B-5C6D7E8F9A0B")!
  let failSaves = Locked(0)
  func installationId() throws -> UUID { id }
  func load() throws -> CredentialDocument { document.get }
  func save(_ document: CredentialDocument) throws {
    try failSaves.with { count in
      if count > 0 {
        count -= 1
        throw CocoaError(.fileWriteUnknown)
      }
    }
    self.document.with { $0 = document }
  }
}

final class MemoryStates: StateDirectory, @unchecked Sendable {
  let stores = Locked([String: MemoryStateStorage]())
  let failClears = Locked(0)
  func storage(for credential: DeviceCredential) -> StateStorage {
    stores.with { stores in
      let key = "\(credential.userId) \(credential.apiOrigin)"
      if let existing = stores[key] { return existing }
      let created = MemoryStateStorage()
      stores[key] = created
      return created
    }
  }
  func clear(keeping credential: DeviceCredential?) throws {
    try failClears.with { count in
      if count > 0 {
        count -= 1
        throw CocoaError(.fileWriteUnknown)
      }
    }
    let keep = credential.map { "\($0.userId) \($0.apiOrigin)" }
    stores.with { stores in stores = stores.filter { $0.key == keep } }
  }
  var count: Int { stores.get.filter { (try? $0.value.load()) != nil }.count }
}

/// A gate a test opens to let a held request finish.
final class Gate: @unchecked Sendable {
  private struct State {
    var isOpen = false
    var isReached = false
    var waiters: [CheckedContinuation<Void, Never>] = []
    var arrivals: [CheckedContinuation<Void, Never>] = []
  }
  private let state = Locked(State())

  /// Called by the held request: waits until the gate opens.
  func pass() async {
    let arrived = state.with { state in
      state.isReached = true
      defer { state.arrivals = [] }
      return state.arrivals
    }
    arrived.forEach { $0.resume() }
    await withCheckedContinuation { continuation in
      let open = state.with { state in
        if !state.isOpen { state.waiters.append(continuation) }
        return state.isOpen
      }
      if open { continuation.resume() }
    }
  }

  /// Waits until the held request reaches the gate.
  func reached() async {
    await withCheckedContinuation { continuation in
      let reached = state.with { state in
        if !state.isReached { state.arrivals.append(continuation) }
        return state.isReached
      }
      if reached { continuation.resume() }
    }
  }

  func open() {
    let waiting = state.with { state in
      state.isOpen = true
      defer { state.waiters = [] }
      return state.waiters
    }
    waiting.forEach { $0.resume() }
  }
}

/// The device routes in memory, per origin.
final class FakeDevices: HTTPTransport, @unchecked Sendable {
  struct State {
    var issued = 0
    var revoked: [String] = []
    var offline = false
    var enrollScripts: [HTTPReply?] = []
    var onEnroll: (@Sendable () async -> Void)?
    var userId = "user_syntheticdeviceowner"
    /// The enrollment sequences received, in order.
    var sequences: [Int] = []
    /// Requests for these sequences wait at their gate before replying.
    var gates: [Int: Gate] = [:]
    /// Requests for these sequences get this reply.
    var replies: [Int: HTTPReply?] = [:]
    /// Replies to the next revocations, in order; then 204.
    var revokeReplies: [HTTPReply] = []
  }
  let state = Locked(State())
  var revoked: [String] { state.get.revoked }
  var sequences: [Int] { state.get.sequences }

  func send(_ request: URLRequest) async -> HTTPReply? {
    if state.get.offline { return nil }
    let path = request.url?.path ?? ""
    let key = request.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: "") ?? ""
    if path == "/api/health/devices" {
      let json = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      let sequence = json?["enrollmentSequence"] as? Int ?? 0
      state.with { $0.sequences.append(sequence) }
      if let hook = state.get.onEnroll { await hook() }
      if let gate = state.get.gates[sequence] { await gate.pass() }
      if let reply = state.get.replies[sequence] { return reply }
      let scripted: HTTPReply?? = state.with { state in
        state.enrollScripts.isEmpty ? Optional<HTTPReply?>.none : .some(state.enrollScripts.removeFirst())
      }
      if case let .some(reply) = scripted { return reply }
      let user = state.get.userId
      let body = """
        {"secret":"ak_issued_\(sequence)","accountTimezone":"Australia/Brisbane","userId":"\(user)",\
        "email":"fitness-device+clerk_test@example.com"}
        """
      return HTTPReply(status: 201, body: Data(body.utf8))
    }
    if path == "/api/health/devices/current" {
      let host = request.url?.host ?? ""
      return state.with { state in
        state.revoked.append("\(host) \(key)")
        return state.revokeReplies.isEmpty ? HTTPReply(status: 204) : state.revokeReplies.removeFirst()
      }
    }
    return HTTPReply(status: 404)
  }
}

final class LifecycleTests: XCTestCase {
  let origin = URL(string: "https://fitness.example.test")!
  let credentials = MemoryCredentials()
  let states = MemoryStates()
  let devices = FakeDevices()

  func lifecycle(origin: URL? = nil) -> DeviceLifecycle {
    let devices = self.devices
    return DeviceLifecycle(
      credentials: credentials, states: states, origin: origin ?? self.origin, deviceName: { "Test iPhone" },
      makeAPI: { try? FitnessAPI(origin: $0, transport: devices) })
  }

  func testEnrollmentWaitsForConsentBeforeAnySync() async throws {
    let device = lifecycle()
    let outcome = try await device.enroll(token: "oat_1", revokeLater: false)
    XCTAssertEqual(
      outcome, .consentPending(email: "fitness-device+clerk_test@example.com", accountTimezone: "Australia/Brisbane"))
    let value1 = await device.session()
    XCTAssertNil(value1)
    let value2 = await device.storage()
    XCTAssertNil(value2)
    // A relaunch between enrollment and consent still has no session.
    let relaunched = lifecycle()
    let value3 = await relaunched.session()
    XCTAssertNil(value3)
    XCTAssertEqual(try credentials.load().active?.state, .consentPending)
    let cutoff = date("2026-11-01T00:00:00Z")
    _ = try await relaunched.confirmPending(cutoff: cutoff)
    let value4 = await relaunched.session()
    XCTAssertNotNil(value4)
    let value5 = try await relaunched.storage()?.load()?.cutoff
    XCTAssertEqual(value5, cutoff)
  }

  func testDecliningRevokesTheKeyWithoutReadingHealth() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    let remaining = try await device.declinePending()
    XCTAssertEqual(remaining, 0)
    XCTAssertEqual(devices.revoked, ["fitness.example.test ak_issued_1"])
    XCTAssertNil(try credentials.load().active)
    XCTAssertEqual(states.count, 0)
  }

  func testALateReplyAcrossAnAccountChangeIsRevokedNotActivated() async throws {
    let device = lifecycle()
    devices.state.with { state in
      state.onEnroll = { [device] in
        // The user disconnects while the enrollment is in flight.
        _ = try? await device.disconnect()
      }
    }
    let outcome = try await device.enroll(token: "oat_1", revokeLater: false)
    XCTAssertEqual(outcome, .superseded)
    XCTAssertNil(try credentials.load().active)
    XCTAssertTrue(devices.revoked.contains("fitness.example.test ak_issued_1"))
  }

  func testOfflineDisconnectThenAccountChangeStillRevokesWithTheOldOrigin() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    _ = try await device.confirmPending(cutoff: Date())
    devices.state.with { $0.offline = true }
    let remaining = try await device.disconnect()
    XCTAssertEqual(remaining, 1)
    let value6 = await device.session()
    XCTAssertNil(value6)
    XCTAssertEqual(states.count, 0)
    // A build for another origin connects another account.
    devices.state.with { $0.userId = "user_other" }
    let other = lifecycle(origin: URL(string: "http://127.0.0.1:3025")!)
    let blocked = try await other.enroll(token: "oat_2", revokeLater: false)
    XCTAssertEqual(blocked, .pendingRevocations(1))
    devices.state.with { $0.offline = false }
    _ = try await other.enroll(token: "oat_2", revokeLater: false)
    XCTAssertEqual(devices.revoked, ["fitness.example.test ak_issued_1"])
    XCTAssertEqual(try credentials.load().active?.apiOrigin, "http://127.0.0.1:3025")
  }

  func testRevokeLaterKeepsThePendingKey() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    devices.state.with { $0.offline = true }
    _ = try await device.disconnect()
    devices.state.with { $0.offline = false }
    devices.state.with { $0.enrollScripts = [HTTPReply(status: 503, body: Data())] }
    // Revocation succeeds once online, so enrollment proceeds.
    let outcome = try await device.enroll(token: "oat_2", revokeLater: false)
    XCTAssertEqual(outcome, .failed(.reauthorize(code: "http_503")))
    XCTAssertEqual(try credentials.load().pending, [])
  }

  func testALostEnrollmentReplyAsksForAFreshSignIn() async throws {
    let device = lifecycle()
    devices.state.with { $0.enrollScripts = [nil] }
    let outcome = try await device.enroll(token: "oat_1", revokeLater: false)
    XCTAssertEqual(outcome, .failed(.reauthorize(code: "lost_reply")))
    XCTAssertNil(try credentials.load().active)
    // The next sign-in uses the same installation and replaces the key.
    let next = try await device.enroll(token: "oat_2", revokeLater: false)
    guard case .consentPending = next else { return XCTFail("\(next)") }
  }

  func testACrashDuringDisconnectFinishesOnLaunch() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    _ = try await device.confirmPending(cutoff: Date())
    XCTAssertEqual(states.count, 1)
    // The key moves to pending; clearing the state fails, as in a crash.
    states.failClears.with { $0 = 1 }
    devices.state.with { $0.offline = true }
    do {
      _ = try await device.disconnect()
      XCTFail("Expected the clear to fail.")
    } catch {}
    XCTAssertNil(try credentials.load().active)
    XCTAssertEqual(try credentials.load().pending.count, 1)
    XCTAssertEqual(states.count, 1)
    let relaunched = lifecycle()
    try await relaunched.resumeCleanup()
    XCTAssertEqual(states.count, 0)
    devices.state.with { $0.offline = false }
    let value7 = await relaunched.revokePending()
    XCTAssertEqual(value7, 0)
  }

  func testKeyInvalidStopsSyncUntilReconnect() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    _ = try await device.confirmPending(cutoff: Date())
    let current = await device.session()
    let session = try XCTUnwrap(current)
    try await device.markInvalid(session)
    let value8 = await device.session()
    XCTAssertNil(value8)
    let value9 = await device.isCurrent(session)
    XCTAssertFalse(value9)
    // The key is cleared and the app asks to connect again.
    XCTAssertNil(try credentials.load().active)
    XCTAssertTrue(try credentials.load().keyInvalid)
    // Reconnecting sends a higher sequence and does not revoke the old key.
    _ = try await device.enroll(token: "oat_2", revokeLater: false)
    XCTAssertEqual(devices.sequences, [1, 2])
    XCTAssertEqual(try credentials.load().active?.sequence, 2)
    XCTAssertFalse(try credentials.load().keyInvalid)
    XCTAssertEqual(devices.revoked, [])
  }

  func testKeyInvalidLeavesANewerStoredKeyAlone() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    _ = try await device.confirmPending(cutoff: Date())
    let first = await device.session()
    let old = try XCTUnwrap(first)
    _ = try await device.enroll(token: "oat_2", revokeLater: false)
    // An upload with the replaced key reports it invalid; the newer one stays.
    try await device.markInvalid(old)
    XCTAssertEqual(try credentials.load().active?.key, "ak_issued_2")
    XCTAssertFalse(try credentials.load().keyInvalid)
  }

  // MARK: Enrollment sequence

  func testTheSequenceIncreasesForEveryAttemptAndSurvivesRelaunch() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    // A lost reply still used its sequence.
    devices.state.with { $0.enrollScripts = [nil] }
    _ = try await device.enroll(token: "oat_2", revokeLater: false)
    XCTAssertEqual(try credentials.load().sequence, 2)
    let relaunched = lifecycle()
    _ = try await relaunched.enroll(token: "oat_3", revokeLater: false)
    XCTAssertEqual(devices.sequences, [1, 2, 3])
    XCTAssertEqual(try credentials.load().active?.sequence, 3)
  }

  func testTheSequenceIsStoredBeforeTheRequestIsSent() async throws {
    let device = lifecycle()
    let stored = Locked(-1)
    let credentials = self.credentials
    devices.state.with { state in
      state.onEnroll = { stored.with { $0 = (try? credentials.load().sequence) ?? -1 } }
    }
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    XCTAssertEqual(stored.get, 1)
  }

  func testStaleEnrollmentRetriesTheSameTokenWithAHigherSequence() async throws {
    let device = lifecycle()
    let stale = HTTPReply(
      status: 409, body: Data(#"{"error":"Connected again since.","code":"stale_enrollment"}"#.utf8))
    devices.state.with { $0.replies[1] = stale }
    let refused = try await device.enroll(token: "oat_1", revokeLater: false)
    XCTAssertEqual(refused, .failed(.retrySameToken(after: 0, code: "stale_enrollment")))
    XCTAssertNil(try credentials.load().active)
    let retried = try await device.enroll(token: "oat_1", revokeLater: false)
    guard case .consentPending = retried else { return XCTFail("\(retried)") }
    XCTAssertEqual(devices.sequences, [1, 2])
    XCTAssertEqual(try credentials.load().active?.sequence, 2)
  }

  func testAnEarlierSuccessIsKeptWhenALaterAttemptFails() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    // Attempt A (sequence 2) is held; attempt B (sequence 3) fails meanwhile.
    let gate = Gate()
    devices.state.with { state in
      state.gates[2] = gate
      state.replies[3] = HTTPReply(
        status: 503, body: Data(#"{"error":"Sign in again.","code":"issuance_failed"}"#.utf8))
    }
    let first = Task { try await device.enroll(token: "oat_a", revokeLater: false) }
    await gate.reached()
    let second = try await device.enroll(token: "oat_b", revokeLater: false)
    XCTAssertEqual(second, .failed(.reauthorize(code: "issuance_failed")))
    gate.open()
    let kept = try await first.value
    guard case .consentPending = kept else { return XCTFail("\(kept)") }
    XCTAssertEqual(try credentials.load().active?.key, "ak_issued_2")
    XCTAssertEqual(try credentials.load().active?.sequence, 2)
    XCTAssertFalse(devices.revoked.contains("fitness.example.test ak_issued_2"))
  }

  func testALowerSequenceSuccessAfterAHigherOneIsRevoked() async throws {
    let device = lifecycle()
    // Attempt A (sequence 1) is held while attempt B (sequence 2) succeeds.
    let gate = Gate()
    devices.state.with { $0.gates[1] = gate }
    let first = Task { try await device.enroll(token: "oat_a", revokeLater: false) }
    await gate.reached()
    let second = try await device.enroll(token: "oat_b", revokeLater: false)
    guard case .consentPending = second else { return XCTFail("\(second)") }
    gate.open()
    let late = try await first.value
    XCTAssertEqual(late, .superseded)
    XCTAssertEqual(try credentials.load().active?.key, "ak_issued_2")
    XCTAssertEqual(devices.revoked, ["fitness.example.test ak_issued_1"])
  }

  func testGenerationsFenceOldSessions() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    _ = try await device.confirmPending(cutoff: Date())
    let current = await device.session()
    let session = try XCTUnwrap(current)
    let value10 = await device.isCurrent(session)
    XCTAssertTrue(value10)
    try await device.resyncFromEarliest()
    let value11 = await device.isCurrent(session)
    XCTAssertFalse(value11)
  }

  func testEarlierCutoffRestartsBackfillAndKeepsTheEarliest() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    let first = date("2026-11-01T00:00:00Z")
    _ = try await device.confirmPending(cutoff: first)
    let found = await device.storage()
    let storage = try XCTUnwrap(found)
    var state = try XCTUnwrap(storage.load())
    state.anchors = [.weight: Data("1".utf8)]
    try storage.save(state)
    try await device.setCutoff(date("2026-10-01T00:00:00Z"))
    XCTAssertNil(try storage.load()?.anchors)
    XCTAssertEqual(try storage.load()?.earliestCutoff, date("2026-10-01T00:00:00Z"))
    try await device.setCutoff(date("2026-11-10T00:00:00Z"))
    XCTAssertEqual(try storage.load()?.earliestCutoff, date("2026-10-01T00:00:00Z"))
    try await device.resyncFromEarliest()
    XCTAssertEqual(try storage.load()?.cutoff, date("2026-10-01T00:00:00Z"))
  }
}

final class CoordinatorTests: XCTestCase {
  func testSimultaneousTriggersCompleteEveryHandlerOnce() async throws {
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00+10:00"))
    let background = FakeBackground()
    let calls = Locked([Int: Int]())
    let runs = Locked(0)
    let engine = try h.engine()
    let coordinator = SyncCoordinator(
      session: { SyncSession(key: "ak_test", generation: 1) }, background: background,
      makeEngine: { _ in
        runs.with { $0 += 1 }
        return engine
      })
    await withTaskGroup(of: Void.self) { group in
      for n in 0..<5 {
        group.addTask {
          await coordinator.trigger(mode: .background) { calls.with { $0[n, default: 0] += 1 } }
        }
      }
    }
    XCTAssertEqual(calls.get, [0: 1, 1: 1, 2: 1, 3: 1, 4: 1])
    XCTAssertLessThanOrEqual(runs.get, 5)
    XCTAssertTrue(background.open.isEmpty)
  }

  func testExpirationCompletesHandlersAndCancelsTheRun() async throws {
    var h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00+10:00"))
    h.limits.pageSize = 1
    for day in 11...19 {
      h.health.add(Sample.weight(day, date("2026-11-\(day)T06:00:00+10:00")))
    }
    let background = FakeBackground()
    let completed = Locked(0)
    let engine = try h.engine()
    let results = Locked([RunResult]())
    let coordinator = SyncCoordinator(
      session: { SyncSession(key: "ak_test", generation: 1) }, background: background,
      makeEngine: { _ in engine }, onResult: { result, _ in results.with { $0.append(result) } })
    h.fitness.onRequest { count in if count == 2 { background.expireAll() } }
    await coordinator.trigger(mode: .foreground) { completed.with { $0 += 1 } }
    XCTAssertEqual(completed.get, 1)
    XCTAssertEqual(results.get, [.stopped(.fenced)])
    // Nothing after the expiry was written: two days at most.
    XCTAssertLessThanOrEqual(h.state.backfill?.through ?? "", "2026-11-12")
    // A later trigger catches up.
    h.fitness.onRequest(nil)
    await coordinator.trigger(mode: .foreground)
    XCTAssertTrue(h.state.incrementalEnabled)
  }

  func testNoSessionCompletesHandlersWithoutRunning() async {
    let completed = Locked(0)
    let coordinator = SyncCoordinator(
      session: { nil }, background: FakeBackground(), makeEngine: { _ in nil })
    await coordinator.trigger(mode: .background) { completed.with { $0 += 1 } }
    XCTAssertEqual(completed.get, 1)
  }

  func testALockedDeviceMarksARetry() async throws {
    let h = Harness(now: date("2026-11-20T02:00:00Z"), cutoff: date("2026-11-10T00:00:00+10:00"))
    h.health.lock(true)
    let engine = try h.engine()
    let coordinator = SyncCoordinator(
      session: { SyncSession(key: "ak_test", generation: 1) }, background: FakeBackground(),
      makeEngine: { _ in engine })
    let completed = Locked(0)
    await coordinator.trigger(mode: .foreground) { completed.with { $0 += 1 } }
    XCTAssertEqual(completed.get, 1)
    let value12 = await coordinator.retryPending
    XCTAssertTrue(value12)
    h.health.lock(false)
    await coordinator.trigger(mode: .foreground)
    let value13 = await coordinator.retryPending
    XCTAssertFalse(value13)
  }
}

extension DeviceLifecycle {
  /// Confirms the pending enrollment, as the consent screen does with the ID it showed.
  @discardableResult
  func confirmPending(cutoff: Date) async throws -> DeviceCredential {
    let id = try document().active?.enrollmentId ?? ""
    return try confirm(cutoff: cutoff, enrollmentId: id)
  }

  func declinePending() async throws -> Int {
    let id = try document().active?.enrollmentId ?? ""
    return try await decline(enrollmentId: id)
  }
}
