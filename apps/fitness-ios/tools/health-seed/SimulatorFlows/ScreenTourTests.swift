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

  /// Taps a chart right of its middle, so the popover for the point there
  /// shows, checks that the chart's value now reads that point, and
  /// captures the screen. `id` is a test ID or its prefix.
  private func captureChart(_ id: String, _ name: String) {
    let chart = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", id)).firstMatch
    guard chart.waitForExistence(timeout: 5) else {
      XCTFail("The chart \(id) is missing.")
      return
    }
    reveal(chart)
    let before = chart.value as? String ?? ""
    chart.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)).tap()
    let selected = NSPredicate(format: "value != %@ AND value != ''", before)
    let read = XCTNSPredicateExpectation(predicate: selected, object: chart)
    XCTAssertEqual(XCTWaiter().wait(for: [read], timeout: 3), .completed, "Tapping \(id) selected no point.")
    capture(name)
  }

  /// Scrolls in short steps until the element's top is in the upper part of
  /// the screen, below the navigation bar, so it and what follows it show,
  /// even with the largest text sizes.
  private func reveal(_ element: XCUIElement) {
    let window = app.windows.firstMatch.frame
    let top = window.minY + 120
    let bottom = window.minY + window.height * 0.4
    for _ in 0..<20 {
      let frame = element.frame
      if frame.minY >= top && frame.minY <= bottom { return }
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: frame.minY > bottom ? 0.3 : 0.7))
      start.press(forDuration: 0.05, thenDragTo: end)
      sleep(1)
    }
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
    // The harness seed makes today Strength A, which ends with a plank.
    guard let hold = scrollTo(suffix: "-start-hold") else {
      XCTFail("Today's workout has no hold to start.")
      return
    }
    do {
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
    XCTAssertTrue(tap("set-0-0-done"), "The first set could not be marked Done.")
    do {
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

  /// Turns a picker wheel towards `target`. A wheel can stop a row away
  /// from the value asked for, so it is read back and turned again.
  private func turn(_ wheel: XCUIElement, to target: String) {
    for _ in 0..<5 {
      wheel.adjust(toPickerWheelValue: target)
      let shown = (wheel.value as? String) ?? ""
      if shown == target || shown.hasPrefix("\(target) ") || shown.lowercased() == target.lowercased() { return }
    }
  }

  /// The leading number a wheel shows, such as 1 for "1 o'clock".
  private func number(_ wheel: XCUIElement) -> Int? {
    Int(((wheel.value as? String) ?? "").prefix { $0.isNumber })
  }

  /// Sets the open compact time picker as close to `date` as the wheels
  /// allow, and returns today at the time they show.
  private func setTime(_ date: Date) -> Date? {
    let wheels = app.pickerWheels
    guard wheels.firstMatch.waitForExistence(timeout: 5) else {
      XCTFail("The time picker shows no wheels.")
      return nil
    }
    let calendar = Calendar.current
    let hour = calendar.component(.hour, from: date)
    let minute = calendar.component(.minute, from: date)
    let twelveHour = wheels.count > 2
    let shownHour = twelveHour ? (hour % 12 == 0 ? 12 : hour % 12) : hour
    var afternoon = hour >= 12
    if twelveHour {
      // The wheel lists "AM" and "PM" in the case the locale writes them.
      let period = wheels.element(boundBy: 2)
      let value = (period.value as? String) ?? ""
      let target = hour < 12 ? "AM" : "PM"
      turn(period, to: value == value.lowercased() ? target.lowercased() : target)
      afternoon = ((period.value as? String) ?? "").lowercased().hasPrefix("p")
    }
    turn(wheels.element(boundBy: 0), to: twelveHour ? "\(shownHour)" : String(format: "%02d", shownHour))
    turn(wheels.element(boundBy: 1), to: String(format: "%02d", minute))
    guard let setHour = number(wheels.element(boundBy: 0)), let setMinute = number(wheels.element(boundBy: 1)) else {
      XCTFail("The time picker's wheels can't be read.")
      return nil
    }
    let hour24 = twelveHour ? setHour % 12 + (afternoon ? 12 : 0) : setHour
    return calendar.date(bySettingHour: hour24, minute: setMinute, second: 0, of: date)
  }

  /// Sets the reminder a few minutes ahead from the Reminders screen and
  /// returns when it fires.
  private func remindSoon() -> Date? {
    guard tap("reminders-time") else {
      XCTFail("The Reminders screen has no time picker.")
      return nil
    }
    let set = setTime(Date().addingTimeInterval(180))
    // Closes the picker.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
    sleep(2)
    guard let set, set.timeIntervalSinceNow > 20 else {
      XCTFail("The reminder time could not be set a few minutes ahead.")
      return nil
    }
    return set
  }

  /// The delivered reminder SpringBoard shows, as a banner or in Notification Center.
  private func shownReminder() -> XCUIElement {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let views = springboard.descendants(matching: .any).matching(identifier: "NotificationShortLookView")
    let labelled = views.matching(NSPredicate(format: "label CONTAINS %@", "Today:")).firstMatch
    return labelled.exists ? labelled : views.firstMatch
  }

  /// Waits on the Home Screen until the reminder's banner shows.
  private func waitForReminder(_ fireAt: Date) -> Bool {
    Thread.sleep(forTimeInterval: max(0, fireAt.timeIntervalSinceNow))
    for _ in 0..<60 {
      if shownReminder().exists { return true }
      sleep(1)
    }
    XCTFail("No reminder was delivered.")
    return false
  }

  /// Checks that the Week tab shows today, the day of the tapped reminder.
  private func assertWeekShowsToday(_ name: String) {
    // Coming forward from a tap, the app answers queries only once it is in front.
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 60), "Tapping the reminder did not open the app.")
    sleep(5)
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 90), "The app shows no tab bar.")
    let panel = element("day-panel")
    XCTAssertTrue(panel.waitForExistence(timeout: 20), "The Week tab is not showing a day.")
    XCTAssertTrue(app.tabBars.buttons["Week"].isSelected, "The reminder did not open the Week tab.")
    // The day panel and the date bar both say "Today" for today's date.
    XCTAssertTrue(app.staticTexts["Today"].exists, "The Week tab is not showing the reminder's day.")
    capture(name)
  }

  /// Settings with the Reminders row and the Reminders screen off and on.
  /// Run `testRemindersDelivery` next, after restarting the Simulator.
  func testRemindersTour() throws {
    app.launch()
    if element("sign-in").waitForExistence(timeout: 30) { element("sign-in").tap() }
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 90), app.debugDescription)
    sleep(3)
    openTab("Settings")
    capture("reminders-01-settings")
    XCTAssertTrue(tap("open-reminders"), "Settings has no Reminders row.")
    capture("reminders-02-off")
    let toggle = app.switches["reminders-enabled"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5), "The Reminders screen has no switch.")
    toggle.tap()
    // On a newly booted Simulator the permission alert can take most of a
    // minute to appear. It shows from SpringBoard, or in the app's window.
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    for _ in 0..<60 {
      if let allow = [app.buttons["Allow"], springboard.buttons["Allow"]].first(where: { $0.exists }) {
        allow.tap()
        break
      }
      sleep(1)
    }
    XCTAssertTrue(element("reminders-next").waitForExistence(timeout: 20), "Turning reminders on shows no next reminder.")
    capture("reminders-03-on")
    let restDays = app.switches["reminders-rest-days"]
    if restDays.exists {
      restDays.tap()
      capture("reminders-04-rest-days")
      restDays.tap()
    }
  }

  /// Reminders delivered a few minutes ahead: one banner tapped while the
  /// app is in the background, and one tapped after the app was closed, each
  /// opening the Week tab at its day. Run it after `testRemindersTour` and a
  /// Simulator restart: SpringBoard delivers an app's local notifications
  /// only once it has started with the app's permission in place.
  func testRemindersDelivery() throws {
    app.launch()
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 90), app.debugDescription)
    sleep(3)
    openTab("Settings")
    if !element("reminders-time").waitForExistence(timeout: 3) { tap("open-reminders") }
    let toggle = app.switches["reminders-enabled"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5), "The Reminders screen has no switch.")
    XCTAssertEqual(toggle.value as? String, "1", "Reminders were not on after a restart.")

    // A tap on the banner while the app is in the background.
    guard let first = remindSoon() else { return }
    capture("reminders-05-time")
    XCUIDevice.shared.press(.home)
    guard waitForReminder(first) else { return }
    captureScreen("reminders-06-banner")
    shownReminder().tap()
    assertWeekShowsToday("reminders-07-opened-week")

    // A tap on the banner that launches the app. A tap in Notification
    // Center doesn't open apps in the iOS 27 Simulator, so the tour taps banners.
    openTab("Settings")
    if !element("reminders-time").waitForExistence(timeout: 3) { tap("open-reminders") }
    guard let second = remindSoon() else { return }
    XCUIDevice.shared.press(.home)
    app.terminate()
    guard waitForReminder(second) else { return }
    captureScreen("reminders-08-banner-closed-app")
    shownReminder().tap()
    assertWeekShowsToday("reminders-09-cold-launch-week")
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
    captureChart("food-week-chart", "09-food-week-popover")
    if tap("food-add") {
      capture("10-food-add")
      if !tap("meal-cancel") { dismissSheet() }
    }

    openTab("Progress")
    capture("11-progress")
    captureChart("progress-week-chart", "11-progress-weeks-popover")
    captureChart("progress-weight-chart", "11-progress-weight-popover")
    app.swipeUp()
    capture("12-progress-strength")
    captureChart("progress-strength-chart-", "12-progress-strength-popover")
    app.swipeDown()
    if tap("progress-open-history") {
      capture("13-history")
      back()
    }
    if tap("progress-open-body") {
      capture("14-bodyweight")
      captureChart("body-trend", "14-bodyweight-popover")
      back()
    }

    openTab("Settings")
    capture("15-settings")
    if tap("open-profile") {
      capture("16-profile")
      app.swipeUp()
      capture("16-profile-nutrients")
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
