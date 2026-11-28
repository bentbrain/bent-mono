import XCTest

/// End-to-end flows for a development build of bent Fitness that talks to
/// the local harness from `scripts/flows.mjs`: the real Fitness handlers on
/// Postgres, with synthetic Clerk sign-in. `FITNESS_SIM_ORIGIN` names the
/// harness; without it these tests are skipped.
@MainActor
final class SyncFlowTests: XCTestCase {
  private static let appId = "build.bent.fitness.dev"
  private var origin: URL!

  override func setUp() async throws {
    continueAfterFailure = false
    guard let value = ProcessInfo.processInfo.environment["FITNESS_SIM_ORIGIN"], let url = URL(string: value) else {
      throw XCTSkip("Set FITNESS_SIM_ORIGIN to run the sync flows.")
    }
    origin = url
  }

  // MARK: Helpers

  /// Thrown to end a flow at a failed check that the later steps depend on.
  /// `continueAfterFailure` doesn't stop an async test, so without it each
  /// later wait would run to its timeout and use up the time for a retry.
  private struct FlowStopped: Error {}

  /// Fails and ends the flow when `condition` is false.
  private func require(
    _ condition: Bool, _ message: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    guard condition else {
      XCTFail(message(), file: file, line: line)
      throw FlowStopped()
    }
  }

  /// Launches `app`, and ends the flow when XCTest has recorded a failure,
  /// such as a launch that timed out, even when the app finishes launching
  /// afterwards.
  private func launch(_ app: XCUIApplication) throws {
    app.launch()
    try require((testRun?.totalFailureCount ?? 0) == 0, "Launching \(app.debugDescription) failed.")
  }

  private func seed() throws {
    let seeder = XCUIApplication()
    try launch(seeder)
    HealthSheet.seed(seeder)
    try wait(for: seeder.staticTexts["status"], label: "Seeded", timeout: 10)
    seeder.terminate()
  }

  private func wait(for element: XCUIElement, label prefix: String, timeout: TimeInterval) throws {
    let predicate = NSPredicate(format: "label BEGINSWITH %@", prefix)
    let found = XCTWaiter.wait(for: [expectation(for: predicate, evaluatedWith: element)], timeout: timeout)
    try require(found == .completed, "Waiting for \(prefix): \(element.debugDescription)")
  }

  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// Asks for Health access from the Health step. On a newly booted
  /// Simulator, HealthKit's request can time out before its sheet appears;
  /// the app then shows the error, and the request is made again.
  private enum Access { case all, none, withoutDistance }

  private func requestHealth(_ app: XCUIApplication, _ access: Access) {
    for _ in 0..<3 {
      element(app, "health-allow").tap()
      if HealthSheet.appears(in: app, timeout: 60) {
        switch access {
        case .all: HealthSheet.allowAll(in: app)
        case .none: HealthSheet.denyAll(in: app)
        case .withoutDistance: HealthSheet.allow(["Weight", "Workouts"], in: app)
        }
        return
      }
      _ = element(app, "health-failed").waitForExistence(timeout: 30)
    }
    XCTFail("The Health access sheet did not appear.\n\(app.debugDescription)")
  }

  /// Signs in through the synthetic OAuth server, connects Apple Health
  /// from Settings and confirms consent. Nothing is imported before consent,
  /// after a relaunch at the consent screen, or after a relaunch at the
  /// Health step; each relaunch returns to the step it left.
  private func connect(_ app: XCUIApplication) async throws {
    try launch(app)
    let signIn = element(app, "sign-in")
    try require(signIn.waitForExistence(timeout: 30), app.debugDescription)
    signIn.tap()
    try openHealth(app)
    let email = element(app, "consent-email")
    try require(email.waitForExistence(timeout: 120), app.debugDescription)
    XCTAssertTrue(app.staticTexts["fitness-device+clerk_test@example.com"].exists)
    let beforeConsent = try await serverState()
    XCTAssertEqual(beforeConsent.imports, 0)
    // A relaunch while consent is pending comes back to consent.
    app.terminate()
    try launch(app)
    try require(element(app, "consent-email").waitForExistence(timeout: 60), app.debugDescription)
    let afterRelaunch = try await serverState()
    XCTAssertEqual(afterRelaunch.imports, 0)
    element(app, "backfill-30d").tap()
    element(app, "consent-confirm").tap()
    try require(element(app, "health-allow").waitForExistence(timeout: 30), app.debugDescription)
    // A relaunch before the Health step returns to it, and nothing syncs.
    app.terminate()
    try launch(app)
    try require(element(app, "health-allow").waitForExistence(timeout: 60), app.debugDescription)
    let atHealthStep = try await serverState()
    XCTAssertEqual(atHealthStep.imports, 0)
  }

  /// Opens Settings › Apple Health and starts connecting this iPhone.
  private func openHealth(_ app: XCUIApplication) throws {
    let settings = app.tabBars.buttons["Settings"]
    try require(settings.waitForExistence(timeout: 90), app.debugDescription)
    settings.tap()
    let health = element(app, "open-health")
    try require(health.waitForExistence(timeout: 30), app.debugDescription)
    health.tap()
    let connect = element(app, "health-connect")
    try require(connect.waitForExistence(timeout: 30), app.debugDescription)
    connect.tap()
  }

  private struct ServerState: Decodable {
    struct Weight: Decodable { let date: String; let kg: Double }
    struct Run: Decodable { let date: String; let distanceKm: Double; let notes: String }
    struct Key: Decodable { let revoked: Bool }
    let weights: [Weight]
    let runs: [Run]
    let keys: [Key]
    let imports: Int
    let enrollments: Int
  }

  private func serverState() async throws -> ServerState {
    let (data, _) = try await URLSession.shared.data(from: origin.appendingPathComponent("__state"))
    return try JSONDecoder().decode(ServerState.self, from: data)
  }

  /// Waits for a sync that finished after `previous`, the exact completion
  /// time the status row carried before.
  @discardableResult
  private func waitForSync(_ app: XCUIApplication, after previous: String = "never") -> String {
    let lastSync = element(app, "status-last-sync")
    XCTAssertTrue(lastSync.waitForExistence(timeout: 60), app.debugDescription)
    let synced = NSPredicate(format: "value != %@ AND value != 'never'", previous)
    let done = XCTWaiter.wait(for: [expectation(for: synced, evaluatedWith: lastSync)], timeout: 120)
    XCTAssertEqual(done, .completed, app.debugDescription)
    return lastSync.value as? String ?? ""
  }

  // MARK: Flows

  /// With Health access denied, the app reads nothing and sends nothing.
  func testDeniedHealthAccessSendsNothing() async throws {
    try seed()
    let app = XCUIApplication(bundleIdentifier: Self.appId)
    try await connect(app)
    requestHealth(app, .none)
    XCTAssertTrue(element(app, "readable-none").waitForExistence(timeout: 30), app.debugDescription)
    element(app, "health-start").tap()
    waitForSync(app)
    let state = try await serverState()
    XCTAssertEqual(state.weights.count, 0)
    XCTAssertEqual(state.runs.count, 0)
    XCTAssertEqual(state.imports, 0)

    // Disconnect revokes the key and returns to Connect Apple Health.
    element(app, "disconnect").tap()
    app.alerts.buttons["Disconnect"].tap()
    XCTAssertTrue(element(app, "health-connect").waitForExistence(timeout: 30), app.debugDescription)
    let after = try await serverState()
    XCTAssertTrue(after.keys.allSatisfy(\.revoked))
  }

  /// With Health access allowed, the first sync sends the seeded history:
  /// the earliest weigh-in per day, and runs with their distances, including
  /// one attached after the workout was saved. Health does not report that
  /// distance is shared for every date, so the run with no distance waits
  /// until the user sends it without one.
  func testAllowedHealthAccessSyncsTheSeededHistory() async throws {
    try seed()
    let app = XCUIApplication(bundleIdentifier: Self.appId)
    try await connect(app)
    requestHealth(app, .all)
    let weight = element(app, "readable-weight")
    XCTAssertTrue(weight.waitForExistence(timeout: 30), app.debugDescription)
    XCTAssertNotEqual(weight.label, "None readable")
    element(app, "health-start").tap()
    let first = waitForSync(app)

    let state = try await serverState()
    XCTAssertEqual(state.weights.count, 3, "\(state.weights)")
    XCTAssertEqual(state.weights.map(\.kg).sorted(), [79.9, 80.1, 80.4])
    XCTAssertEqual(state.runs.map(\.distanceKm).sorted(), [3.1, 4.2, 5], "\(state.runs)")
    XCTAssertTrue(state.runs.allSatisfy { $0.notes == "Apple Health" })
    // The weigh-in dated two days ahead waits until it is due.
    XCTAssertTrue(element(app, "status-deferred").exists, app.debugDescription)
    XCTAssertTrue(element(app, "status-distance-access").exists, app.debugDescription)

    // A later Sync now, waited for by its own completion time, finds
    // nothing new and sends no import request.
    element(app, "sync-now").tap()
    let second = waitForSync(app, after: first)
    let again = try await serverState()
    XCTAssertEqual(again.weights.count, 3)
    XCTAssertEqual(again.runs.count, 3)
    XCTAssertEqual(again.imports, state.imports, "The second sync sent samples again")

    // Sending the waiting run without a distance records it as 0 km.
    let send = element(app, "send-without-distance")
    XCTAssertEqual(send.label, "Send 1 run without distance")
    send.tap()
    waitForSync(app, after: second)
    let sent = try await serverState()
    XCTAssertEqual(sent.runs.map(\.distanceKm).sorted(), [0, 3.1, 4.2, 5], "\(sent.runs)")
    let notice = element(app, "status-distance-access")
    await fulfillment(
      of: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: notice)], timeout: 30)
  }

  /// With Weight and Workouts allowed but not Walking + Running Distance,
  /// weigh-ins sync and no run is sent as 0 km: runs without a readable
  /// distance, including the one whose distance was attached later, wait.
  func testPartialHealthAccessHoldsRunsWithoutDistance() async throws {
    try seed()
    let app = XCUIApplication(bundleIdentifier: Self.appId)
    try await connect(app)
    requestHealth(app, .withoutDistance)
    XCTAssertTrue(element(app, "readable-weight").waitForExistence(timeout: 30), app.debugDescription)
    element(app, "health-start").tap()
    waitForSync(app)
    let state = try await serverState()
    XCTAssertEqual(state.weights.count, 3, "\(state.weights)")
    XCTAssertTrue(state.runs.allSatisfy { $0.distanceKm > 0 }, "\(state.runs)")
    XCTAssertLessThan(state.runs.count, 4, "\(state.runs)")
    XCTAssertTrue(element(app, "status-distance-access").waitForExistence(timeout: 10), app.debugDescription)
  }
}
