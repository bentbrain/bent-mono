import XCTest
@testable import FitnessHealthCore

/// The Swift half of the contract round trip with the Fitness server.
///
/// With FITNESS_WIRE_PASS=encode, the production encoder writes each
/// synthetic request to `$FITNESS_WIRE_DIR/requests`. A Bun test then sends
/// them to the real import handler and writes the replies, along with the
/// replies to enrollment and disconnect, to `$FITNESS_WIRE_DIR/replies`.
/// With FITNESS_WIRE_PASS=decode, the production decoder reads those replies
/// and checks each outcome and action. Without FITNESS_WIRE_DIR, the tests
/// are skipped.
final class RoundTripTests: XCTestCase {
  /// The fixed clock both sides use: midday on 20 November 2026 in Brisbane.
  static let now = date("2026-11-20T02:00:00Z")
  static let account = "Australia/Brisbane"

  private var directory: URL!
  private var pass: String!

  override func setUpWithError() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let dir = environment["FITNESS_WIRE_DIR"], let pass = environment["FITNESS_WIRE_PASS"] else {
      throw XCTSkip("Set FITNESS_WIRE_DIR and FITNESS_WIRE_PASS to run the round trip.")
    }
    directory = URL(fileURLWithPath: dir)
    self.pass = pass
  }

  // MARK: Cases

  struct Case {
    let name: String
    let samples: [HealthSample]
    let expectedTimezone: String?
    let deviceTimeZone: String
    /// The outcome code each ref should get.
    let expected: [String: OutcomeCode]
  }

  private static func at(_ text: String) -> Date { date(text) }

  /// Synthetic samples, as the sync engine would send them. Samples that are
  /// not yet eligible are left out by the engine's own rule.
  static var cases: [Case] {
    let weighIns: [HealthSample] = [
      // Fractional seconds and another device offset.
      .weight(id: Sample.id(101), date: at("2026-11-14T06:00:00Z").addingTimeInterval(0.375), kg: 80.45),
      .weight(id: Sample.id(102), date: at("2026-11-14T08:00:00Z"), kg: 81.2),
      // 23:30 on 15 Nov in Los Angeles is 17:30 on 16 Nov in Brisbane.
      .weight(id: Sample.id(103), date: at("2026-11-16T07:30:00Z"), kg: 79.95),
      // Later than now: excluded by the client.
      .weight(id: Sample.id(104), date: at("2026-11-21T20:00:00Z"), kg: 79.5),
    ]
    let runs: [HealthSample] = [
      .run(
        id: Sample.id(201), start: at("2026-11-16T20:00:00Z"), end: at("2026-11-16T20:32:00Z"), seconds: 1815,
        distance: .km(5.2)),
      // Sent without a distance after its wait.
      .run(
        id: Sample.id(202), start: at("2026-11-17T20:00:00Z"), end: at("2026-11-17T20:25:00Z"), seconds: 1500,
        distance: .none),
      // Indoor run with a long decimal distance.
      .run(
        id: Sample.id(203), start: at("2026-11-18T09:00:00Z"), end: at("2026-11-18T09:40:00Z"), seconds: 2400,
        distance: .km(7.123456)),
    ]
    let ref = { (sample: HealthSample) in sample.ref }
    return [
      Case(
        name: "mixed", samples: weighIns + runs, expectedTimezone: nil, deviceTimeZone: "America/Los_Angeles",
        expected: [
          ref(weighIns[0]): .new, ref(weighIns[1]): .dateHasWeighin, ref(weighIns[2]): .new,
          ref(runs[0]): .new, ref(runs[1]): .new, ref(runs[2]): .new,
        ]),
      Case(
        name: "replay", samples: weighIns + runs, expectedTimezone: nil, deviceTimeZone: "Australia/Brisbane",
        expected: [
          ref(weighIns[0]): .alreadyImported, ref(weighIns[1]): .alreadyImported, ref(weighIns[2]): .alreadyImported,
          ref(runs[0]): .alreadyImported, ref(runs[1]): .alreadyImported, ref(runs[2]): .alreadyImported,
        ]),
      Case(
        name: "backfill",
        samples: [.weight(id: Sample.id(301), date: at("2026-11-10T20:00:00Z"), kg: 78.4)],
        expectedTimezone: account, deviceTimeZone: "Australia/Brisbane",
        expected: [Refs.make(.weight, Sample.id(301)): .new]),
      Case(
        name: "timezone-changed",
        samples: [.weight(id: Sample.id(401), date: at("2026-11-09T20:00:00Z"), kg: 78)],
        expectedTimezone: "Pacific/Auckland", deviceTimeZone: "Australia/Brisbane", expected: [:]),
      Case(
        name: "too-many",
        samples: (0..<2001).map { n in
          .weight(id: Sample.id(10_000 + n), date: at("2026-10-01T00:00:00Z").addingTimeInterval(Double(n)), kg: 80)
        },
        expectedTimezone: nil, deviceTimeZone: "UTC", expected: [:]),
    ]
  }

  // MARK: Encode

  func testEncodePass() throws {
    guard pass == "encode" else { throw XCTSkip("Encode pass only.") }
    let requests = directory.appendingPathComponent("requests")
    try FileManager.default.createDirectory(at: requests, withIntermediateDirectories: true)
    let engine = try Harness(now: Self.now, cutoff: date("2026-10-01T00:00:00Z")).engine()
    for wire in Self.cases {
      let eligible = wire.samples.filter { engine.eligibility($0, at: Self.now) == .send }
      let request = try ImportRequest(
        samples: eligible, timestamps: Timestamps(timeZone: TimeZone(identifier: wire.deviceTimeZone)!),
        expectedTimezone: wire.expectedTimezone)
      let body = try JSONSerialization.jsonObject(with: request.encoded())
      let file: [String: Any] = [
        "body": body,
        "submitted": request.submitted.map { ["ref": $0.ref, "type": $0.kind.rawValue] },
        "expected": wire.expected.mapValues(\.rawValue),
      ]
      try JSONSerialization.data(withJSONObject: file, options: [.prettyPrinted, .sortedKeys])
        .write(to: requests.appendingPathComponent("\(wire.name).json"))
    }
    // The client leaves out the sample dated after now.
    let mixed = try XCTUnwrap(Self.cases.first)
    let sent = mixed.samples.filter { engine.eligibility($0, at: Self.now) == .send }
    XCTAssertFalse(sent.contains { $0.id == Sample.id(104) })
  }

  // MARK: Decode

  private func reply(_ name: String) throws -> HTTPReply {
    try WireFixtures.load(directory.appendingPathComponent("replies/\(name).json"))
  }

  private func submitted(_ name: String) throws -> [ImportRequest.Submitted] {
    let data = try Data(contentsOf: directory.appendingPathComponent("requests/\(name).json"))
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return (json["submitted"] as? [[String: String]] ?? []).map {
      ImportRequest.Submitted(ref: $0["ref"] ?? "", kind: SampleKind(rawValue: $0["type"] ?? "") ?? .weight)
    }
  }

  func testDecodePassImports() throws {
    guard pass == "decode" else { throw XCTSkip("Decode pass only.") }
    for wire in Self.cases where !wire.expected.isEmpty {
      let action = Classify.importReply(try reply(wire.name), submitted: try submitted(wire.name), now: Self.now)
      guard case let .accepted(decoded) = action else { return XCTFail("\(wire.name): \(action)") }
      XCTAssertEqual(decoded.accountTimezone, Self.account)
      let codes = Dictionary(uniqueKeysWithValues: decoded.outcomes.map { ($0.ref, $0.code) })
      XCTAssertEqual(codes, wire.expected, wire.name)
    }
    XCTAssertEqual(
      Classify.importReply(try reply("timezone-changed"), submitted: try submitted("timezone-changed"), now: Self.now),
      .timezoneChanged(Self.account))
    XCTAssertEqual(
      Classify.importReply(try reply("too-many"), submitted: try submitted("too-many"), now: Self.now), .split)
  }

  func testDecodePassBranchesWithoutFixtures() throws {
    guard pass == "decode" else { throw XCTSkip("Decode pass only.") }
    let now = Self.now
    // Enrollment.
    guard case .enrolled = Classify.enrollReply(try reply("enroll"), now: now) else { return XCTFail("enroll") }
    XCTAssertEqual(
      Classify.enrollReply(try reply("enroll-rate-limited"), now: now),
      .retrySameToken(after: try retryAfter("enroll-rate-limited"), code: "rate_limited"))
    XCTAssertNotNil(try retryAfter("enroll-rate-limited"))
    XCTAssertEqual(
      Classify.enrollReply(try reply("enroll-issuance-pending"), now: now),
      .retrySameToken(after: 10, code: "issuance_pending"))
    XCTAssertEqual(
      Classify.enrollReply(try reply("enroll-issuance-failed"), now: now), .reauthorize(code: "issuance_failed"))
    XCTAssertEqual(
      Classify.enrollReply(try reply("enroll-auth-unavailable"), now: now),
      .retrySameToken(after: nil, code: "auth_unavailable"))
    // Import outages, both Authorization forms, and mixed refs.
    XCTAssertEqual(
      Classify.importReply(try reply("import-auth-unavailable"), submitted: [], now: now),
      .retry(after: nil, reason: "auth_unavailable"))
    for name in ["import-bearer", "import-bare"] {
      guard case .accepted = Classify.importReply(try reply(name), submitted: try submitted("backfill"), now: now)
      else { return XCTFail(name) }
    }
    // Disconnect: an outage, then a lost 204 and its retry.
    XCTAssertEqual(Classify.revokeReply(try reply("revoke-auth-unavailable"), now: now), .retry(after: nil))
    XCTAssertEqual(Classify.revokeReply(try reply("revoke"), now: now), .done)
    XCTAssertEqual(Classify.revokeReply(try reply("revoke-retry"), now: now), .alreadyInvalid)
    XCTAssertEqual(
      Classify.importReply(try reply("import-after-revoke"), submitted: [], now: now), .keyInvalid)
  }

  private func retryAfter(_ name: String) throws -> TimeInterval? {
    try reply(name).retryAfter(now: Self.now)
  }
}
