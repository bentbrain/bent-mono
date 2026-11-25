import XCTest

/// Seeds the synthetic sample set. Health asks for write access the first
/// time; the test allows it.
@MainActor
final class SeedTests: XCTestCase {
  func testSeedsSyntheticSamples() throws {
    let app = XCUIApplication()
    app.launch()
    app.buttons["seed"].tap()
    let status = app.staticTexts["status"]
    let deadline = Date().addingTimeInterval(90)
    while !status.label.hasPrefix("Seeded") && Date() < deadline {
      if HealthSheet.appears(in: app, timeout: 2) { HealthSheet.allowAll(in: app) }
    }
    let seeded = NSPredicate(format: "label BEGINSWITH 'Seeded'")
    if XCTWaiter.wait(for: [expectation(for: seeded, evaluatedWith: status)], timeout: 60) != .completed {
      print("UI hierarchy:\n\(app.debugDescription)")
      XCTFail("Seeding did not finish: \(status.label)")
    }
  }
}
