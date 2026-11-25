import XCTest

/// Drives the Health access sheet, which HealthKit shows inside the app's
/// own window. On iOS 26 and later the sheet lists a "Select All" cell, a
/// switch per type, then Allow and Don't Allow at the end of the list.
@MainActor
enum HealthSheet {
  static let selectAll = "UIA.Health.AuthSheet.AllCategoryButton"

  /// Whether the sheet appeared within the timeout.
  static func appears(in app: XCUIApplication, timeout: TimeInterval = 15) -> Bool {
    app.cells[selectAll].waitForExistence(timeout: timeout)
  }

  /// Turns on every requested type and allows access.
  static func allowAll(in app: XCUIApplication, timeout: TimeInterval = 15) {
    guard appears(in: app, timeout: timeout) else {
      XCTFail("The Health access sheet did not appear.\n\(app.debugDescription)")
      return
    }
    app.cells[selectAll].tap()
    tapLabel("Allow", in: app)
  }

  /// Leaves every type off and closes the sheet.
  static func denyAll(in app: XCUIApplication, timeout: TimeInterval = 15) {
    guard appears(in: app, timeout: timeout) else {
      XCTFail("The Health access sheet did not appear.\n\(app.debugDescription)")
      return
    }
    tapLabel("Don\u{2019}t Allow", in: app)
  }

  private static func tapLabel(_ label: String, in app: XCUIApplication) {
    let element = app.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
    var swipes = 0
    while !element.isHittable && swipes < 6 {
      app.tables.firstMatch.swipeUp()
      swipes += 1
    }
    element.tap()
  }
}
