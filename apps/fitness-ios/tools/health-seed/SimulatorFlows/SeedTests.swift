import XCTest

/// Seeds the synthetic sample set. Health asks for write access the first
/// time; the test allows it.
@MainActor
final class SeedTests: XCTestCase {
  func testSeedsSyntheticSamples() throws {
    let app = XCUIApplication()
    app.launch()
    app.buttons["seed"].tap()
    HealthSheet.allowAll(in: app)
    let status = app.staticTexts["status"]
    let seeded = NSPredicate(format: "label BEGINSWITH 'Seeded'")
    if XCTWaiter.wait(for: [expectation(for: seeded, evaluatedWith: status)], timeout: 60) != .completed {
      print("UI hierarchy:\n\(app.debugDescription)")
      XCTFail("Seeding did not finish: \(status.label)")
    }
  }
}
