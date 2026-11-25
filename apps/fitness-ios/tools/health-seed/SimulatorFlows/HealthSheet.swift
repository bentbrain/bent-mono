import XCTest

/// Drives the Health access sheet, which HealthKit shows inside the app's
/// own window. The sheet lists a "Select All" cell and a switch per type,
/// then a confirming button at the end of the list: Allow when the app asks
/// to write, Continue when it only asks to read. A read request then asks how
/// much history to share, the past 30 days or all of it, before Allow. Don't
/// Allow is followed by an alert that points to the Health app.
@MainActor
enum HealthSheet {
  static let selectAll = "UIA.Health.AuthSheet.AllCategoryButton"
  static let timeBounded = "HealthUI.HKAuthorizationTimeBoundedView"

  /// The history choices the sheet offers for read access.
  enum History: String {
    case all = "All Recorded Data and Future Data"
    case past30Days = "Past 30 Days and Future Data"
  }

  /// Whether the sheet appeared within the timeout.
  static func appears(in app: XCUIApplication, timeout: TimeInterval = 15) -> Bool {
    app.cells[selectAll].waitForExistence(timeout: timeout)
  }

  /// Turns on every requested type and allows access.
  static func allowAll(in app: XCUIApplication, history: History = .all, timeout: TimeInterval = 15) {
    guard appears(in: app, timeout: timeout) else {
      XCTFail("The Health access sheet did not appear.\n\(app.debugDescription)")
      return
    }
    app.cells[selectAll].tap()
    // Write requests confirm with Allow; read-only requests with Continue.
    tapLabel(["Allow", "Continue"], in: app)
    // Read requests can then ask how much history to share.
    let window = app.navigationBars[timeBounded]
    if window.waitForExistence(timeout: 5) {
      tapLabel([history.rawValue], in: app)
      tapLabel(["Allow"], in: app)
    }
  }

  /// Leaves every type off and closes the sheet.
  static func denyAll(in app: XCUIApplication, timeout: TimeInterval = 15) {
    guard appears(in: app, timeout: timeout) else {
      XCTFail("The Health access sheet did not appear.\n\(app.debugDescription)")
      return
    }
    tapLabel(["Don\u{2019}t Allow"], in: app)
    // HealthKit then says categories can be turned on later in Health.
    let done = app.buttons["OK"]
    if done.waitForExistence(timeout: 10) { done.tap() }
  }

  private static func tapLabel(_ labels: [String], in app: XCUIApplication) {
    let element = app.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", labels)).firstMatch
    var swipes = 0
    while !element.isHittable && swipes < 6 {
      app.tables.firstMatch.swipeUp()
      swipes += 1
    }
    element.tap()
  }
}
