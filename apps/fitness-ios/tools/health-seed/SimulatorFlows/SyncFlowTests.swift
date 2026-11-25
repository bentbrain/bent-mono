import XCTest

/// End-to-end flows for a development build of Fitness Sync that talks to
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

  private func seed() {
    let seeder = XCUIApplication()
    seeder.launch()
    seeder.buttons["seed"].tap()
    // On a newly booted Simulator, Health can take a while to show its sheet.
    let status = seeder.staticTexts["status"]
    let deadline = Date().addingTimeInterval(90)
    while !status.label.hasPrefix("Seeded") && Date() < deadline {
      if HealthSheet.appears(in: seeder, timeout: 2) { HealthSheet.allowAll(in: seeder) }
    }
    wait(for: status, label: "Seeded", timeout: 10)
    seeder.terminate()
  }

  private func wait(for element: XCUIElement, label prefix: String, timeout: TimeInterval) {
    let predicate = NSPredicate(format: "label BEGINSWITH %@", prefix)
    let found = XCTWaiter.wait(for: [expectation(for: predicate, evaluatedWith: element)], timeout: timeout)
    XCTAssertEqual(found, .completed, "Waiting for \(prefix): \(element.debugDescription)")
  }

  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// Signs in through the synthetic OAuth server and confirms consent.
  private func connect(_ app: XCUIApplication) {
    app.launch()
    let signIn = element(app, "sign-in")
    XCTAssertTrue(signIn.waitForExistence(timeout: 30), app.debugDescription)
    signIn.tap()
    let email = element(app, "consent-email")
    XCTAssertTrue(email.waitForExistence(timeout: 60), app.debugDescription)
    XCTAssertTrue(app.staticTexts["fitness-device+clerk_test@example.com"].exists)
    element(app, "backfill-30d").tap()
    element(app, "consent-confirm").tap()
    XCTAssertTrue(element(app, "health-allow").waitForExistence(timeout: 30))
  }

  private struct ServerState: Decodable {
    struct Weight: Decodable { let date: String; let kg: Double }
    struct Run: Decodable { let date: String; let distanceKm: Double; let notes: String }
    struct Key: Decodable { let revoked: Bool }
    let weights: [Weight]
    let runs: [Run]
    let keys: [Key]
  }

  private func serverState() async throws -> ServerState {
    let (data, _) = try await URLSession.shared.data(from: origin.appendingPathComponent("__state"))
    return try JSONDecoder().decode(ServerState.self, from: data)
  }

  private func waitForSync(_ app: XCUIApplication) {
    let lastSync = element(app, "status-last-sync")
    XCTAssertTrue(lastSync.waitForExistence(timeout: 60), app.debugDescription)
    let synced = NSPredicate(format: "label != 'Not yet'")
    let done = XCTWaiter.wait(for: [expectation(for: synced, evaluatedWith: lastSync)], timeout: 120)
    XCTAssertEqual(done, .completed, app.debugDescription)
  }

  // MARK: Flows

  /// With Health access denied, the app reads nothing and sends nothing.
  func testDeniedHealthAccessSendsNothing() async throws {
    seed()
    let app = XCUIApplication(bundleIdentifier: Self.appId)
    connect(app)
    element(app, "health-allow").tap()
    HealthSheet.denyAll(in: app)
    XCTAssertTrue(element(app, "readable-none").waitForExistence(timeout: 30), app.debugDescription)
    element(app, "health-start").tap()
    waitForSync(app)
    let state = try await serverState()
    XCTAssertEqual(state.weights.count, 0)
    XCTAssertEqual(state.runs.count, 0)

    // Disconnect revokes the key and returns to sign-in.
    element(app, "disconnect").tap()
    app.alerts.buttons["Disconnect"].tap()
    XCTAssertTrue(element(app, "sign-in").waitForExistence(timeout: 30), app.debugDescription)
    let after = try await serverState()
    XCTAssertTrue(after.keys.allSatisfy(\.revoked))
  }

  /// With Health access allowed, the first sync sends the seeded history:
  /// the earliest weigh-in per day, and runs with their distances, including
  /// one attached after the workout was saved.
  func testAllowedHealthAccessSyncsTheSeededHistory() async throws {
    seed()
    let app = XCUIApplication(bundleIdentifier: Self.appId)
    connect(app)
    element(app, "health-allow").tap()
    HealthSheet.allowAll(in: app)
    let weight = element(app, "readable-weight")
    XCTAssertTrue(weight.waitForExistence(timeout: 30), app.debugDescription)
    XCTAssertNotEqual(weight.label, "None readable")
    element(app, "health-start").tap()
    waitForSync(app)

    let state = try await serverState()
    XCTAssertEqual(state.weights.count, 3, "\(state.weights)")
    XCTAssertEqual(state.weights.map(\.kg).sorted(), [79.9, 80.1, 80.4])
    let distances = state.runs.map(\.distanceKm).sorted()
    XCTAssertEqual(distances, [0, 3.1, 4.2, 5], "\(state.runs)")
    XCTAssertTrue(state.runs.allSatisfy { $0.notes == "Apple Health" })
    // The weigh-in dated two days ahead waits until it is due.
    XCTAssertTrue(element(app, "status-deferred").exists, app.debugDescription)

    // A later Sync now finds nothing new.
    element(app, "sync-now").tap()
    waitForSync(app)
    let again = try await serverState()
    XCTAssertEqual(again.weights.count, 3)
    XCTAssertEqual(again.runs.count, 4)
  }
}
