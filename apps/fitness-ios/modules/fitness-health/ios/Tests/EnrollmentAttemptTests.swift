import XCTest
@testable import FitnessHealthCore

/// A sign-in's requests belong to the attempt that began before it, so a
/// disconnect cancels every one of them, retries included. Started from
/// the third independent review's reproduction.
final class EnrollmentAttemptTests: XCTestCase {
  private let origin = URL(string: "https://fitness.example.test")!

  /// The old sign-in's request is held, the user disconnects and connects
  /// again, then the old request fails with a reply that would be retried.
  /// The old sign-in stops: its reply is `superseded`, its retry sends
  /// nothing, and the new key stays.
  func testACancelledSignInsBusyReplyIsNotRetried() async throws {
    try await assertCancelledSignInStops(
      reply: HTTPReply(
        status: 429, headers: ["Retry-After": "1"],
        body: Data(#"{"error":"Try again later.","code":"rate_limited"}"#.utf8)))
  }

  func testACancelledSignInsUnavailableReplyIsNotRetried() async throws {
    try await assertCancelledSignInStops(
      reply: HTTPReply(
        status: 503, headers: ["Retry-After": "5"],
        body: Data(#"{"error":"Unavailable.","code":"auth_unavailable"}"#.utf8)))
  }

  func testACancelledSignInsTransportFailureIsNotRetried() async throws {
    try await assertCancelledSignInStops(reply: nil)
  }

  /// Without a cancellation, the same busy reply is still retried.
  func testABusyReplyIsRetriedWithinItsAttempt() async throws {
    let credentials = MemoryCredentials()
    let transport = FakeDevices()
    transport.state.with { state in
      state.replies[1] = HTTPReply(
        status: 429, headers: ["Retry-After": "1"],
        body: Data(#"{"error":"Try again later.","code":"rate_limited"}"#.utf8))
    }
    let device = lifecycle(credentials, transport)
    let attempt = await device.beginEnrollment()
    let first = try await device.enroll(token: "oat", revokeLater: false, attempt: attempt)
    XCTAssertEqual(first, .failed(.retrySameToken(after: 1, code: "rate_limited")))
    let second = try await device.enroll(token: "oat", revokeLater: false, attempt: attempt)
    XCTAssertEqual(
      second, .consentPending(email: "fitness-device+clerk_test@example.com", accountTimezone: "Australia/Brisbane"))
    XCTAssertEqual(transport.sequences, [1, 2])
  }

  /// A cancelled attempt's late success is revoked, as before.
  func testACancelledSignInsLateSuccessIsRevoked() async throws {
    let credentials = MemoryCredentials()
    let transport = FakeDevices()
    let held = Gate()
    transport.state.with { $0.gates[1] = held }
    let device = lifecycle(credentials, transport)
    let attempt = await device.beginEnrollment()
    let old = Task { try await device.enroll(token: "old", revokeLater: false, attempt: attempt) }
    await held.reached()
    _ = try await device.disconnect()
    held.open()
    let outcome = try await old.value
    XCTAssertEqual(outcome, .superseded)
    XCTAssertNil(try credentials.load().active)
    XCTAssertTrue(transport.revoked.contains("fitness.example.test ak_issued_1"))
  }

  // MARK: Helpers

  private func lifecycle(_ credentials: MemoryCredentials, _ transport: FakeDevices) -> DeviceLifecycle {
    DeviceLifecycle(
      credentials: credentials, states: MemoryStates(), origin: origin, deviceName: { "iPhone" },
      makeAPI: { try? FitnessAPI(origin: $0, transport: transport) })
  }

  private func assertCancelledSignInStops(
    reply: HTTPReply?, file: StaticString = #filePath, line: UInt = #line
  ) async throws {
    let credentials = MemoryCredentials()
    let transport = FakeDevices()
    let firstReply = Gate()
    transport.state.with { state in
      state.gates[1] = firstReply
      state.replies.updateValue(reply, forKey: 1)
    }
    let device = lifecycle(credentials, transport)
    let attempt = await device.beginEnrollment()
    let old = Task { try await device.enroll(token: "old", revokeLater: false, attempt: attempt) }
    await firstReply.reached()
    _ = try await device.disconnect()
    _ = try await device.enroll(token: "new", revokeLater: false)
    let pending = try XCTUnwrap(credentials.load().active, file: file, line: line)
    _ = try await device.confirm(cutoff: date("2026-11-01T00:00:00Z"), enrollmentId: pending.enrollmentId)
    firstReply.open()
    let result = try await old.value
    XCTAssertEqual(result, .superseded, file: file, line: line)
    // The sign-in's retry, as `connect` would send it, stops before sending.
    let retry = try await device.enroll(token: "old", revokeLater: false, attempt: attempt)
    XCTAssertEqual(retry, .superseded, file: file, line: line)
    XCTAssertEqual(transport.sequences, [1, 2], file: file, line: line)
    let document = try credentials.load()
    XCTAssertEqual(document.active?.key, "ak_issued_2", file: file, line: line)
    XCTAssertEqual(document.active?.state, .active, file: file, line: line)
  }
}
