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

/// Reminders iOS could not add. The scheduler tries again on its next run.
struct ReminderAddFailed: Error, CustomStringConvertible {
  let count: Int
  var description: String { "\(count) workout reminders could not be scheduled." }
}

/// Schedules the daily workout reminders and reports the reminder a tap opened.
public final class WorkoutRemindersModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WorkoutReminders")

    Events("onReminderOpened")

    OnStartObserving {
      let listener = ReminderListener(module: self)
      ReminderTaps.listen { tap in listener.send(tap) }
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

    // Brings the pending reminders in line with these, for the account
    // `owner`. Resolves "denied" when notifications are off for the app,
    // after removing the pending ones, and rejects when iOS refused one.
    AsyncFunction("schedule") { (owner: String, reminders: [ReminderRecord]) async throws -> String in
      try await WorkoutReminders.replace(owner: owner, reminders)
    }

    // Removes pending and delivered reminders and forgets a tap not yet
    // handled, as at the end of a sign-in.
    AsyncFunction("cancel") { () async in
      ReminderTaps.clear()
      await WorkoutReminders.cancel()
    }

    // The reminder tapped before JavaScript was listening.
    Function("takeOpened") { () -> [String: String]? in
      ReminderTaps.take()?.json
    }
  }
}

/// Sends reminder taps to the module while it is alive.
private final class ReminderListener: @unchecked Sendable {
  weak var module: WorkoutRemindersModule?
  init(module: WorkoutRemindersModule) { self.module = module }
  func send(_ tap: ReminderTap) { module?.sendEvent("onReminderOpened", tap.json) }
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

  /// Whether a pending request already is this reminder, for this account.
  private static func same(_ request: UNNotificationRequest, _ reminder: ReminderRecord, owner: String) -> Bool {
    let info = request.content.userInfo
    return request.identifier == prefix + reminder.day && request.content.title == reminder.title
      && request.content.body == reminder.body && info["at"] as? Double == reminder.at
      && info["owner"] as? String == owner
  }

  /// Brings the pending reminders in line with these. A pending reminder
  /// that matches one of them stays, so one about to fire is never removed
  /// and added again too late; the others are removed, and the missing ones
  /// added. Without permission every pending reminder is removed. Throws
  /// when iOS refuses to add one.
  static func replace(owner: String, _ reminders: [ReminderRecord]) async throws -> String {
    let center = UNUserNotificationCenter.current()
    let pending = await center.pendingNotificationRequests().filter { isReminder($0.identifier) }
    guard allowed(await center.notificationSettings().authorizationStatus) else {
      center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier))
      return "denied"
    }
    let kept = Set(
      pending.filter { request in reminders.contains { same(request, $0, owner: owner) } }.map(\.identifier))
    center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { !kept.contains($0) })
    var failed = 0
    for reminder in reminders where !kept.contains(prefix + reminder.day) {
      let interval = Date(timeIntervalSince1970: reminder.at / 1000).timeIntervalSinceNow
      guard interval >= 1 else { continue }
      let content = UNMutableNotificationContent()
      content.title = reminder.title
      content.body = reminder.body
      content.sound = .default
      content.threadIdentifier = prefix
      content.userInfo = ["day": reminder.day, "at": reminder.at, "owner": owner]
      let trigger = UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)
      do {
        try await center.add(UNNotificationRequest(identifier: prefix + reminder.day, content: content, trigger: trigger))
      } catch {
        failed += 1
      }
    }
    if failed > 0 { throw ReminderAddFailed(count: failed) }
    return "scheduled"
  }

  /// Removes pending and delivered reminders, as on signing out. Pending
  /// ones go first; one that fires meanwhile is then among the delivered.
  static func cancel() async {
    let center = UNUserNotificationCenter.current()
    let pending = await center.pendingNotificationRequests().map(\.identifier).filter(isReminder)
    center.removePendingNotificationRequests(withIdentifiers: pending)
    let delivered = await center.deliveredNotifications().map(\.request.identifier).filter(isReminder)
    center.removeDeliveredNotifications(withIdentifiers: delivered + pending)
  }
}

/// A tapped reminder: its day and the account it was scheduled for.
struct ReminderTap {
  let day: String
  let owner: String
  var json: [String: String] { ["day": day, "owner": owner] }
}

/// The last reminder tapped, until JavaScript takes it. A tap that opens
/// the app arrives before JavaScript listens, so it waits here.
enum ReminderTaps {
  private static let lock = NSLock()
  private static var pending: ReminderTap?
  private static var listener: ((ReminderTap) -> Void)?

  static func opened(_ tap: ReminderTap) {
    lock.lock()
    let current = listener
    if current == nil { pending = tap }
    lock.unlock()
    current?(tap)
  }

  static func listen(_ next: ((ReminderTap) -> Void)?) {
    lock.lock()
    defer { lock.unlock() }
    listener = next
  }

  static func take() -> ReminderTap? {
    lock.lock()
    defer { lock.unlock() }
    let tap = pending
    pending = nil
    return tap
  }

  static func clear() {
    lock.lock()
    defer { lock.unlock() }
    pending = nil
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
    let info = request.content.userInfo
    if WorkoutReminders.isReminder(request.identifier),
      response.actionIdentifier == UNNotificationDefaultActionIdentifier,
      let day = info["day"] as? String, let owner = info["owner"] as? String {
      ReminderTaps.opened(ReminderTap(day: day, owner: owner))
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
