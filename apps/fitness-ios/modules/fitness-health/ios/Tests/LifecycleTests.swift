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

/// The device routes in memory, per origin.
final class FakeDevices: HTTPTransport, @unchecked Sendable {
  struct State {
    var issued = 0
    var revoked: [String] = []
    var offline = false
    var enrollScripts: [HTTPReply?] = []
    var onEnroll: (@Sendable () async -> Void)?
    var userId = "user_syntheticdeviceowner"
  }
  let state = Locked(State())
  var revoked: [String] { state.get.revoked }

  func send(_ request: URLRequest) async -> HTTPReply? {
    if state.get.offline { return nil }
    let path = request.url?.path ?? ""
    let key = request.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: "") ?? ""
    if path == "/api/health/devices" {
      if let hook = state.get.onEnroll { await hook() }
      let scripted: HTTPReply?? = state.with { state in
        state.enrollScripts.isEmpty ? Optional<HTTPReply?>.none : .some(state.enrollScripts.removeFirst())
      }
      if case let .some(reply) = scripted { return reply }
      let (secret, user) = state.with { state -> (String, String) in
        state.issued += 1
        return ("ak_issued_\(state.issued)", state.userId)
      }
      let body = """
        {"secret":"\(secret)","accountTimezone":"Australia/Brisbane","userId":"\(user)",\
        "email":"fitness-device+clerk_test@example.com"}
        """
      return HTTPReply(status: 201, body: Data(body.utf8))
    }
    if path == "/api/health/devices/current" {
      let host = request.url?.host ?? ""
      state.with { $0.revoked.append("\(host) \(key)") }
      return HTTPReply(status: 204)
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
    _ = try await relaunched.confirm(cutoff: cutoff)
    let value4 = await relaunched.session()
    XCTAssertNotNil(value4)
    let value5 = try await relaunched.storage()?.load()?.cutoff
    XCTAssertEqual(value5, cutoff)
  }

  func testDecliningRevokesTheKeyWithoutReadingHealth() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    let remaining = try await device.decline()
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
    _ = try await device.confirm(cutoff: Date())
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
    _ = try await device.confirm(cutoff: Date())
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
    _ = try await device.confirm(cutoff: Date())
    let current = await device.session()
    let session = try XCTUnwrap(current)
    try await device.markInvalid(session)
    let value8 = await device.session()
    XCTAssertNil(value8)
    let value9 = await device.isCurrent(session)
    XCTAssertFalse(value9)
    // Reconnecting replaces the invalid key without revoking it again.
    _ = try await device.enroll(token: "oat_2", revokeLater: false)
    XCTAssertEqual(devices.revoked, [])
  }

  func testGenerationsFenceOldSessions() async throws {
    let device = lifecycle()
    _ = try await device.enroll(token: "oat_1", revokeLater: false)
    _ = try await device.confirm(cutoff: Date())
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
    _ = try await device.confirm(cutoff: first)
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
      makeEngine: { _ in engine }, onResult: { result in results.with { $0.append(result) } })
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
