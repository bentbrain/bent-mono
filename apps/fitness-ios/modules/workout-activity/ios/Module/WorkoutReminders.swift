import ExpoModulesCore
import Foundation
import UIKit
import UserNotifications

/// One day's workout reminder, as JavaScript builds it. `at` is milliseconds since 1970.
struct ReminderRecord: Record {
  @Field var day: String = ""
  @Field var at: Double = 0
  @Field var title: String = ""
  @Field var body: String = ""
}

/// Schedules the daily workout reminders and reports the reminder a tap opened.
public final class WorkoutRemindersModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WorkoutReminders")

    Events("onReminderOpened")

    OnStartObserving {
      let listener = ReminderListener(module: self)
      ReminderTaps.listen { day in listener.send(day) }
    }

    OnStopObserving {
      ReminderTaps.listen(nil)
    }

    AsyncFunction("permission") { () async -> String in
      await WorkoutReminders.permission()
    }

    AsyncFunction("requestPermission") { () async -> Bool in
      await WorkoutReminders.requestPermission()
    }

    // Replaces every pending reminder. Resolves "denied" when notifications
    // are off for the app, after removing the pending ones.
    AsyncFunction("schedule") { (reminders: [ReminderRecord]) async -> String in
      await WorkoutReminders.replace(reminders)
    }

    AsyncFunction("cancel") { () async in
      await WorkoutReminders.cancel()
    }

    // The day of a reminder tapped before JavaScript was listening.
    Function("takeOpened") { () -> String? in
      ReminderTaps.take()
    }
  }
}

/// Sends reminder taps to the module while it is alive.
private final class ReminderListener: @unchecked Sendable {
  weak var module: WorkoutRemindersModule?
  init(module: WorkoutRemindersModule) { self.module = module }
  func send(_ day: String) { module?.sendEvent("onReminderOpened", ["day": day]) }
}

/// The daily workout reminders: local notifications with their own
/// identifier prefix, so replacing them never touches the timer alerts.
enum WorkoutReminders {
  static let prefix = "build.bent.fitness.workout-reminder."

  static func isReminder(_ identifier: String) -> Bool { identifier.hasPrefix(prefix) }

  private static func allowed(_ status: UNAuthorizationStatus) -> Bool {
    status == .authorized || status == .provisional || status == .ephemeral
  }

  /// "granted", "denied" or "undetermined", from the app's notification setting.
  static func permission() async -> String {
    let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    if status == .notDetermined { return "undetermined" }
    return allowed(status) ? "granted" : "denied"
  }

  /// Asks for permission when iOS hasn't asked yet, and reports whether reminders can show.
  static func requestPermission() async -> Bool {
    let center = UNUserNotificationCenter.current()
    if (try? await center.requestAuthorization(options: [.alert, .sound])) == true { return true }
    return allowed(await center.notificationSettings().authorizationStatus)
  }

  /// Replaces every pending reminder with these. Without permission the
  /// pending reminders are removed and nothing is added.
  static func replace(_ reminders: [ReminderRecord]) async -> String {
    let center = UNUserNotificationCenter.current()
    let pending = await center.pendingNotificationRequests().map(\.identifier).filter(isReminder)
    center.removePendingNotificationRequests(withIdentifiers: pending)
    guard allowed(await center.notificationSettings().authorizationStatus) else { return "denied" }
    for reminder in reminders {
      let interval = Date(timeIntervalSince1970: reminder.at / 1000).timeIntervalSinceNow
      guard interval >= 1 else { continue }
      let content = UNMutableNotificationContent()
      content.title = reminder.title
      content.body = reminder.body
      content.sound = .default
      content.threadIdentifier = prefix
      content.userInfo = ["day": reminder.day]
      let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
      try? await center.add(UNNotificationRequest(identifier: prefix + reminder.day, content: content, trigger: trigger))
    }
    return "scheduled"
  }

  /// Removes pending and delivered reminders, as on signing out.
  static func cancel() async {
    let center = UNUserNotificationCenter.current()
    let pending = await center.pendingNotificationRequests().map(\.identifier).filter(isReminder)
    let delivered = await center.deliveredNotifications().map(\.request.identifier).filter(isReminder)
    center.removePendingNotificationRequests(withIdentifiers: pending)
    center.removeDeliveredNotifications(withIdentifiers: delivered)
  }
}

/// The day of the last reminder tapped, until JavaScript takes it. A tap
/// that opens the app arrives before JavaScript listens, so it waits here.
enum ReminderTaps {
  private static let lock = NSLock()
  private static var pending: String?
  private static var listener: ((String) -> Void)?

  static func opened(_ day: String) {
    lock.lock()
    let current = listener
    if current == nil { pending = day }
    lock.unlock()
    current?(day)
  }

  static func listen(_ next: ((String) -> Void)?) {
    lock.lock()
    defer { lock.unlock() }
    listener = next
  }

  static func take() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let day = pending
    pending = nil
    return day
  }
}

/// Decides how notifications show while the app is open and handles taps.
/// Timer alerts show nothing while the app is open, where the logger gives
/// its own haptic. Reminders show as a banner. Tapping a reminder opens the
/// Week tab at its day.
final class NotificationResponder: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationResponder()

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler(WorkoutReminders.isReminder(notification.request.identifier) ? [.banner, .list, .sound] : [])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let request = response.notification.request
    if WorkoutReminders.isReminder(request.identifier),
      response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let day = request.content.userInfo["day"] as? String {
      ReminderTaps.opened(day)
    }
    completionHandler()
  }
}

/// Handles notifications from launch, so a tap that opens the app reaches it.
public final class WorkoutActivityAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = NotificationResponder.shared
    return true
  }
}
