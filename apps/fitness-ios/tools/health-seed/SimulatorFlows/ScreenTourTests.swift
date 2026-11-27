import XCTest

/// Signs in to a development build through the local harness and captures
/// each screen of the app. `FITNESS_SIM_ORIGIN` names the harness and
/// `FITNESS_TOUR_DIR` the folder for the PNGs; without them the tour is
/// skipped. Seed the harness with `POST /__seed` first for a full account.
@MainActor
final class ScreenTourTests: XCTestCase {
  private var folder: URL!
  private var app: XCUIApplication!

  override func setUp() async throws {
    continueAfterFailure = true
    let environment = ProcessInfo.processInfo.environment
    guard environment["FITNESS_SIM_ORIGIN"] != nil, let dir = environment["FITNESS_TOUR_DIR"] else {
      throw XCTSkip("Set FITNESS_SIM_ORIGIN and FITNESS_TOUR_DIR to capture the screen tour.")
    }
    folder = URL(fileURLWithPath: dir, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    app = XCUIApplication(bundleIdentifier: "build.bent.fitness.dev")
  }

  private func capture(_ name: String) {
    sleep(1)
    let shot = app.screenshot()
    try? shot.pngRepresentation.write(to: folder.appendingPathComponent("\(name).png"))
    let attachment = XCTAttachment(screenshot: shot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func element(_ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  /// Taps the element with this test ID or label, if it appears.
  @discardableResult
  private func tap(_ id: String, timeout: TimeInterval = 5) -> Bool {
    let target = element(id)
    guard target.waitForExistence(timeout: timeout) else { return false }
    if !target.isHittable { app.swipeUp() }
    target.tap()
    sleep(1)
    return true
  }

  private func back() {
    let button = app.navigationBars.buttons.firstMatch
    if button.exists { button.tap() }
    sleep(1)
  }

  private func dismissSheet() {
    app.swipeDown(velocity: .fast)
    sleep(1)
  }

  private func openTab(_ label: String) {
    let tab = app.tabBars.buttons[label]
    if tab.waitForExistence(timeout: 20) { tab.tap() }
    sleep(2)
  }

  /// Captures the whole Simulator screen, such as the Home Screen with the
  /// Dynamic Island.
  private func captureScreen(_ name: String) {
    sleep(1)
    let shot = XCUIScreen.main.screenshot()
    try? shot.pngRepresentation.write(to: folder.appendingPathComponent("\(name).png"))
    let attachment = XCTAttachment(screenshot: shot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  /// The first element whose test ID ends with `suffix`, scrolled into view.
  private func scrollTo(suffix: String) -> XCUIElement? {
    let target = app.descendants(matching: .any).matching(NSPredicate(format: "identifier ENDSWITH %@", suffix)).firstMatch
    for _ in 0..<12 {
      if target.exists && target.isHittable { return target }
      app.swipeUp()
    }
    return target.exists ? target : nil
  }

  /// Allows notifications when iOS asks, as it does for the first rest or hold.
  private func allowNotifications() {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let allow = springboard.alerts.buttons["Allow"]
    if allow.waitForExistence(timeout: 4) { allow.tap() }
  }

  /// The hold timer, the rest timer and the workout Live Activity on the
  /// Home Screen.
  func testWorkoutActivityTour() throws {
    app.launch()
    if element("sign-in").waitForExistence(timeout: 30) { element("sign-in").tap() }
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 90), app.debugDescription)
    sleep(3)
    app.swipeUp()
    guard tap("start-workout") || tap("plan-start-workout") || tap("resume-workout") else {
      XCTFail("No workout to start.")
      return
    }
    sleep(2)
    if let hold = scrollTo(suffix: "-start-hold") {
      capture("activity-01-hold-button")
      hold.tap()
      allowNotifications()
      capture("activity-02-hold-ready")
      sleep(5)
      capture("activity-03-holding")
      XCUIDevice.shared.press(.home)
      captureScreen("activity-04-island-hold")
      app.activate()
      sleep(2)
      if let stop = scrollTo(suffix: "-hold-stop") { stop.tap() }
    }
    app.swipeDown(velocity: .fast)
    app.swipeDown(velocity: .fast)
    if tap("set-0-0-done") {
      allowNotifications()
      app.swipeDown(velocity: .fast)
      capture("activity-05-rest")
      XCUIDevice.shared.press(.home)
      captureScreen("activity-06-island-rest")
      app.activate()
      sleep(2)
    }
    if let discard = scrollTo(suffix: "discard-workout") {
      discard.tap()
      let confirm = app.alerts.buttons["Discard draft"]
      if confirm.waitForExistence(timeout: 5) { confirm.tap() }
    }
  }

  func testScreenTour() throws {
    app.launch()
    if element("sign-in").waitForExistence(timeout: 30) {
      capture("01-sign-in")
      element("sign-in").tap()
    }
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 90), app.debugDescription)
    sleep(3)

    capture("02-week")
    app.swipeUp()
    capture("03-week-day")
    if tap("start-workout") || tap("plan-start-workout") {
      sleep(2)
      capture("04-workout")
      app.swipeUp()
      capture("05-workout-sets")
      tap("discard-workout")
      let discard = app.alerts.buttons["Discard draft"]
      if discard.waitForExistence(timeout: 5) { discard.tap() }
      sleep(2)
    }

    openTab("Exercises")
    capture("06-exercises")
    if tap("exercise-row-squat") {
      capture("07-exercise")
      back()
    }

    openTab("Food")
    capture("08-food")
    app.swipeUp()
    capture("09-food-week")
    if tap("food-add") {
      capture("10-food-add")
      if !tap("meal-cancel") { dismissSheet() }
    }

    openTab("Progress")
    capture("11-progress")
    app.swipeUp()
    capture("12-progress-strength")
    app.swipeDown()
    if tap("progress-open-history") {
      capture("13-history")
      back()
    }
    if tap("progress-open-body") {
      capture("14-bodyweight")
      back()
    }

    openTab("Settings")
    capture("15-settings")
    if tap("open-profile") {
      capture("16-profile")
      back()
    }
    if tap("open-plan-settings") {
      capture("17-repeating-week")
      back()
    }
    if tap("open-equipment") {
      capture("18-equipment")
      back()
    }
    if tap("open-health") {
      capture("19-apple-health")
      back()
    }
    if tap("sync-status") {
      capture("20-sync")
      dismissSheet()
    }
  }
}
