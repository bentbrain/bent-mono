import XCTest
@testable import FitnessHealthCore

/// The committed real-handler replies from the Fitness integration test.
enum WireFixtures {
  static let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // ios
    .deletingLastPathComponent()  // fitness-health
    .deletingLastPathComponent()  // modules
    .deletingLastPathComponent()  // fitness-ios
    .deletingLastPathComponent()  // apps
    .appendingPathComponent("fitness/tests/fixtures/wire/replies")

  /// A fixture as an HTTP reply: `{status, body}`, with `null` for no body.
  static func reply(_ name: String, headers: [String: String] = [:]) throws -> HTTPReply {
    try load(directory.appendingPathComponent("\(name).json"), headers: headers)
  }

  static func load(_ file: URL, headers: [String: String] = [:]) throws -> HTTPReply {
    let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
    let status = json?["status"] as? Int ?? 0
    let body = json?["body"]
    let data = body is NSNull || body == nil ? Data() : try JSONSerialization.data(withJSONObject: body as Any)
    let stored = json?["headers"] as? [String: String] ?? [:]
    return HTTPReply(status: status, headers: stored.merging(headers) { _, new in new }, body: data)
  }

  /// The refs and types a device reply answers, as the request sent them.
  static func submitted(_ reply: HTTPReply) throws -> [ImportRequest.Submitted] {
    let json = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any]
    let outcomes = json?["outcomes"] as? [[String: String]] ?? []
    return outcomes.map {
      ImportRequest.Submitted(ref: $0["ref"] ?? "", kind: SampleKind(rawValue: $0["type"] ?? "") ?? .weight)
    }
  }
}

final class WireTests: XCTestCase {
  private let now = date("2026-11-20T02:00:00Z")

  func testFixturesArePresent() throws {
    let names = try FileManager.default.contentsOfDirectory(atPath: WireFixtures.directory.path)
    XCTAssertTrue(names.contains("device-mixed.json"), "Run from the repository checkout.")
  }

  func testDeviceRepliesDecodeWithEveryCode() throws {
    var codes = Set<OutcomeCode>()
    for name in ["device-first", "device-mixed", "device-replay", "device-removed"] {
      let reply = try WireFixtures.reply(name)
      let action = Classify.importReply(reply, submitted: try WireFixtures.submitted(reply), now: now)
      guard case let .accepted(decoded) = action else { return XCTFail("\(name): \(action)") }
      XCTAssertEqual(decoded.accountTimezone, "Australia/Brisbane")
      codes.formUnion(decoded.outcomes.map(\.code))
    }
    XCTAssertEqual(codes, Set(OutcomeCode.allCases))
  }

  func testMixedReplyValues() throws {
    let reply = try WireFixtures.reply("device-mixed")
    let decoded = try DeviceReply.accept(reply.body, for: WireFixtures.submitted(reply))
    XCTAssertEqual(decoded.outcomes.count, 13)
    XCTAssertEqual(decoded.outcomes.first, DeviceOutcome(
      ref: "w:00000001-1111-4222-8333-444455556666", type: .weight, result: .added, code: .new))
    XCTAssertEqual(decoded.outcomes.filter { $0.code == .duplicateInRequest }.count, 2)
  }

  func testARepliesMissingOrExtraRefsIsRetried() throws {
    let reply = try WireFixtures.reply("device-mixed")
    var submitted = try WireFixtures.submitted(reply)
    submitted.removeLast()
    XCTAssertEqual(
      Classify.importReply(reply, submitted: submitted, now: now), .retry(after: nil, reason: "malformed_reply"))
    submitted.append(ImportRequest.Submitted(ref: Refs.make(.run, UUID()), kind: .run))
    XCTAssertEqual(
      Classify.importReply(reply, submitted: submitted, now: now), .retry(after: nil, reason: "malformed_reply"))
    // The same ref under the other type does not count.
    let first = try WireFixtures.reply("device-first")
    let wrongType = [ImportRequest.Submitted(ref: "r:00000020-1111-4222-8333-444455556666", kind: .weight)]
    XCTAssertEqual(
      Classify.importReply(first, submitted: wrongType, now: now), .retry(after: nil, reason: "malformed_reply"))
  }

  func testRefsCompareInCanonicalForm() throws {
    let reply = try WireFixtures.reply("device-first")
    let upper = [ImportRequest.Submitted(ref: "r:00000020-1111-4222-8333-444455556666".uppercased(), kind: .run)]
    guard case .accepted = Classify.importReply(reply, submitted: upper, now: now) else {
      return XCTFail("Refs should compare in lower case.")
    }
  }

  func testMalformedSuccessRepliesAreRetried() {
    let submitted = [ImportRequest.Submitted(ref: Refs.make(.weight, Sample.id(1)), kind: .weight)]
    let bodies = [
      "",
      "{}",
      #"{"received":{"weights":1,"runs":0}}"#,
      """
      {"kind":"device","accountTimezone":"UTC","outcomes":[{"ref":"w:00000001-1111-4222-8333-444455556666",\
      "type":"weight","result":"added","code":"date_has_weighin"}]}
      """,
      #"{"kind":"other","accountTimezone":"UTC","outcomes":[]}"#,
    ]
    for body in bodies {
      XCTAssertEqual(
        Classify.importReply(HTTPReply(status: 200, body: Data(body.utf8)), submitted: submitted, now: now),
        .retry(after: nil, reason: "malformed_reply"), body)
    }
  }

  func testImportErrorFixturesMapToActions() throws {
    let none: [ImportRequest.Submitted] = []
    let cases: [(String, ImportAction)] = [
      ("error-payload-too-large", .split),
      ("error-too-many-samples", .split),
      ("error-timezone-changed", .timezoneChanged("Australia/Brisbane")),
      ("error-key-invalid", .keyInvalid),
      ("error-auth-unavailable", .retry(after: nil, reason: "auth_unavailable")),
      ("error-invalid-device-request-prefix", .needsCorrection("data.workouts.0.ref: A run ref starts with r:.")),
      (
        "error-invalid-device-request-duplicate-ref",
        .needsCorrection("data.metrics.0.data.1.ref: This ref was already sent at data.metrics.0.data.0.ref.")
      ),
      (
        "error-invalid-device-request-malformed",
        .needsCorrection("data.metrics.0.data.1.qty: Invalid input: expected number, received string")
      ),
    ]
    for (name, expected) in cases {
      XCTAssertEqual(Classify.importReply(try WireFixtures.reply(name), submitted: none, now: now), expected, name)
    }
    XCTAssertEqual(Classify.importReply(nil, submitted: none, now: now), .retry(after: nil, reason: "transport"))
    let unauthorized = HTTPReply(status: 401, body: Data(#"{"error":"x","code":"unauthorized"}"#.utf8))
    XCTAssertEqual(
      Classify.importReply(unauthorized, submitted: none, now: now), .retry(after: nil, reason: "unauthorized"))
    let conflict = HTTPReply(status: 409, body: Data(#"{"error":"x","code":"import_conflict"}"#.utf8))
    XCTAssertEqual(
      Classify.importReply(conflict, submitted: none, now: now), .retry(after: nil, reason: "import_conflict"))
    let uninvited = HTTPReply(status: 403, body: Data(#"{"error":"Ask","code":"not_invited"}"#.utf8))
    XCTAssertEqual(Classify.importReply(uninvited, submitted: none, now: now), .notInvited("Ask"))
  }

  func testEnrollmentFixturesMapToActions() throws {
    let enrolled = Classify.enrollReply(try WireFixtures.reply("enroll"), now: now)
    XCTAssertEqual(enrolled, .enrolled(EnrollResponse(
      secret: "ak_secret_1", accountTimezone: "Australia/Brisbane", userId: "user_syntheticdeviceowner",
      email: "fitness-device+clerk_test@example.com")))
    XCTAssertEqual(
      Classify.enrollReply(try WireFixtures.reply("error-enrollment-token-used"), now: now),
      .reauthorize(code: "enrollment_token_used"))
    XCTAssertEqual(
      Classify.enrollReply(try WireFixtures.reply("error-issuance-pending", headers: ["Retry-After": "10"]), now: now),
      .retrySameToken(after: 10, code: "issuance_pending"))
    XCTAssertEqual(
      Classify.enrollReply(try WireFixtures.reply("error-auth-unavailable"), now: now),
      .retrySameToken(after: nil, code: "auth_unavailable"))
    guard case .deviceLimit = Classify.enrollReply(try WireFixtures.reply("error-device-limit"), now: now) else {
      return XCTFail("device_limit")
    }
    guard case .refused(code: "enrollment_unavailable", _) =
      Classify.enrollReply(try WireFixtures.reply("error-enrollment-unavailable"), now: now)
    else { return XCTFail("enrollment_unavailable") }
    XCTAssertEqual(
      Classify.enrollReply(try WireFixtures.reply("error-stale-enrollment"), now: now),
      .retrySameToken(after: 0, code: "stale_enrollment"))
    XCTAssertEqual(Classify.enrollReply(nil, now: now), .reauthorize(code: "lost_reply"))
    let malformed = HTTPReply(status: 201, body: Data(#"{"secret":""}"#.utf8))
    XCTAssertEqual(Classify.enrollReply(malformed, now: now), .reauthorize(code: "malformed_reply"))
    for code in ["insufficient_scope", "client_not_allowed", "not_invited"] {
      let reply = HTTPReply(status: 403, body: Data(#"{"error":"m","code":"\#(code)"}"#.utf8))
      XCTAssertEqual(Classify.enrollReply(reply, now: now), .refused(code: code, message: "m"))
    }
    let bug = HTTPReply(status: 400, body: Data(#"{"error":"Send a UUID","code":"invalid_request"}"#.utf8))
    XCTAssertEqual(Classify.enrollReply(bug, now: now), .bug("Send a UUID"))
  }

  func testDisconnectFixturesMapToActions() throws {
    XCTAssertEqual(Classify.revokeReply(try WireFixtures.reply("disconnect"), now: now), .done)
    XCTAssertEqual(Classify.revokeReply(try WireFixtures.reply("error-key-invalid"), now: now), .alreadyInvalid)
    XCTAssertEqual(
      Classify.revokeReply(try WireFixtures.reply("error-auth-unavailable", headers: ["Retry-After": "10"]), now: now),
      .retry(after: 10))
    XCTAssertEqual(Classify.revokeReply(nil, now: now), .retry(after: nil))
  }

  func testRetryAfterReadsSecondsAndDates() {
    XCTAssertEqual(HTTPReply(status: 503, headers: ["retry-after": "30"]).retryAfter(now: now), 30)
    let later = HTTPReply(status: 503, headers: ["Retry-After": "Fri, 20 Nov 2026 02:01:30 GMT"])
    XCTAssertEqual(later.retryAfter(now: now), 90)
    XCTAssertNil(HTTPReply(status: 503, headers: ["Retry-After": "soon"]).retryAfter(now: now))
    XCTAssertEqual(HTTPReply(status: 503, headers: ["Retry-After": "Fri, 20 Nov 2026 01:00:00 GMT"])
      .retryAfter(now: now), 0)
  }

  func testRequestsEncodeAsFitnessReadsThem() throws {
    let brisbane = Timestamps(timeZone: TimeZone(identifier: "Australia/Brisbane")!)
    let request = try ImportRequest(
      samples: [
        Sample.weight(1, date("2026-11-19T20:10:00Z"), kg: 80.4),
        .run(
          id: Sample.id(2), start: date("2026-11-19T20:00:00Z").addingTimeInterval(0.25),
          end: date("2026-11-19T20:32:00Z"), seconds: 1815, distance: .km(5.2)),
        Sample.run(3, date("2026-11-18T20:00:00Z"), km: RunDistance.none),
      ],
      timestamps: brisbane, expectedTimezone: "Australia/Brisbane")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.encoded()) as? [String: Any])
    XCTAssertEqual(json["expectedTimezone"] as? String, "Australia/Brisbane")
    let data = try XCTUnwrap(json["data"] as? [String: Any])
    let metric = try XCTUnwrap((data["metrics"] as? [[String: Any]])?.first)
    XCTAssertEqual(metric["name"] as? String, "weight_body_mass")
    XCTAssertEqual(metric["units"] as? String, "kg")
    let point = try XCTUnwrap((metric["data"] as? [[String: Any]])?.first)
    XCTAssertEqual(point["ref"] as? String, "w:00000001-1111-4222-8333-444455556666")
    XCTAssertEqual(point["date"] as? String, "2026-11-20T06:10:00.000+10:00")
    XCTAssertEqual(point["qty"] as? Double, 80.4)
    let workouts = try XCTUnwrap(data["workouts"] as? [[String: Any]])
    XCTAssertEqual(workouts[0]["name"] as? String, "Running")
    XCTAssertEqual(workouts[0]["start"] as? String, "2026-11-20T06:00:00.250+10:00")
    XCTAssertEqual(workouts[0]["duration"] as? Double, 1815)
    XCTAssertEqual((workouts[0]["distance"] as? [String: Any])?["units"] as? String, "km")
    XCTAssertNil(workouts[1]["distance"])
    XCTAssertEqual(request.submitted.map(\.kind), [.weight, .run, .run])
    XCTAssertThrowsError(try ImportRequest(
      samples: [Sample.run(4, date("2026-11-18T20:00:00Z"), km: .unknown)], timestamps: brisbane,
      expectedTimezone: nil))
  }

  func testDeviceNamesFollowFitnessRules() {
    XCTAssertEqual(DeviceName.clean("  Liam\u{200B}'s iPhone\n"), "Liam's iPhone")
    XCTAssertEqual(DeviceName.clean("\u{0007}"), "iPhone")
    let long = String(repeating: "😀", count: 40)
    XCTAssertLessThanOrEqual(DeviceName.clean(long).utf16.count, 60)
    XCTAssertEqual(DeviceName.clean(String(repeating: "a", count: 70)).count, 60)
  }

  func testTheAPIStaysOnItsOrigin() throws {
    XCTAssertThrowsError(try FitnessAPI(origin: URL(string: "http://example.com")!, transport: FakeFitness()))
    XCTAssertThrowsError(try FitnessAPI(origin: URL(string: "https://example.com/path")!, transport: FakeFitness()))
    XCTAssertNoThrow(try FitnessAPI(origin: URL(string: "http://127.0.0.1:3025")!, transport: FakeFitness()))
    let origin = URL(string: "https://fitness.bent.build")!
    XCTAssertTrue(FitnessAPI.sameOrigin(URL(string: "https://fitness.bent.build/api/x"), origin))
    XCTAssertTrue(FitnessAPI.sameOrigin(URL(string: "https://FITNESS.bent.build:443/"), origin))
    XCTAssertFalse(FitnessAPI.sameOrigin(URL(string: "https://evil.example/api"), origin))
    XCTAssertFalse(FitnessAPI.sameOrigin(URL(string: "http://fitness.bent.build/api"), origin))
    XCTAssertFalse(FitnessAPI.sameOrigin(URL(string: "https://fitness.bent.build:8443/api"), origin))
  }
}
