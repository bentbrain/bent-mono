import ActivityKit
import ExpoModulesCore
import Foundation
import UserNotifications

/// The workout content JavaScript sends. Times are milliseconds since 1970.
struct ActivityContentRecord: Record {
  @Field var workoutId: String = ""
  @Field var workoutName: String = ""
  @Field var startedAt: Double = 0
  @Field var state: ActivityStateRecord = ActivityStateRecord()
  @Field var staleAt: Double?
}

struct ActivityStateRecord: Record {
  @Field var phase: String = "lift"
  @Field var title: String = ""
  @Field var exercise: String = ""
  @Field var detail: String = ""
  @Field var doneTitle: String = ""
  @Field var doneDetail: String = ""
  @Field var completed: Int = 0
  @Field var total: Int = 0
  @Field var timerStart: Double?
  @Field var timerEnd: Double?
  @Field var finalEnd: Double?

  var content: WorkoutActivityAttributes.ContentState {
    WorkoutActivityAttributes.ContentState(
      phase: phase, title: title, exercise: exercise, detail: detail, doneTitle: doneTitle, doneDetail: doneDetail,
      completed: completed, total: total, timerStart: timerStart.map(date), timerEnd: timerEnd.map(date),
      finalEnd: finalEnd.map(date))
  }
}

private func date(_ milliseconds: Double) -> Date {
  Date(timeIntervalSince1970: milliseconds / 1000)
}

/// Shows the workout Live Activity and schedules the alert for the end of a
/// rest or hold. The Live Activity has no push updates: the app updates it
/// while it runs, and its countdowns run on their own.
public final class WorkoutActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WorkoutActivity")

    Function("isEnabled") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    // Starts the activity for this workout, or updates the one already
    // showing. Activities for other workouts end.
    AsyncFunction("show") { (record: ActivityContentRecord) async throws in
      let state = ActivityContent(state: record.state.content, staleDate: record.staleAt.map(date))
      var current: Activity<WorkoutActivityAttributes>?
      for activity in Activity<WorkoutActivityAttributes>.activities {
        // A stale activity, one whose countdown passed its end, is updated in place.
        let live = activity.activityState == .active || activity.activityState == .stale
        if activity.attributes.workoutId == record.workoutId && current == nil && live {
          current = activity
        } else {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
      }
      if let current {
        await current.update(state)
        return
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
      let attributes = WorkoutActivityAttributes(
        workoutId: record.workoutId, workoutName: record.workoutName, startedAt: date(record.startedAt))
      _ = try Activity.request(attributes: attributes, content: state, pushType: nil)
    }

    // Ends every workout activity, or only the one for `workoutId`.
    AsyncFunction("end") { (workoutId: String?) async in
      for activity in Activity<WorkoutActivityAttributes>.activities
      where workoutId == nil || activity.attributes.workoutId == workoutId {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    // The workout IDs with an activity showing.
    Function("showing") { () -> [String] in
      Activity<WorkoutActivityAttributes>.activities
        .filter { $0.activityState == .active || $0.activityState == .stale }
        .map { $0.attributes.workoutId }
    }

    // Replaces the pending timer alert. iOS asks for permission the first
    // time; without it, nothing is scheduled. iOS shows no banner while the
    // app is open, where the logger gives its own haptic. Each schedule or
    // cancel starts a new generation, and an alert whose generation was
    // replaced while it waited for permission removes itself.
    AsyncFunction("scheduleAlert") { (title: String, body: String, at: Double) async -> Bool in
      let generation = TimerAlerts.next()
      let center = UNUserNotificationCenter.current()
      await TimerAlerts.remove(through: generation - 1)
      guard date(at).timeIntervalSinceNow >= 1 else { return false }
      let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
      // The permission prompt can take a while, so the time left is read again.
      let remaining = date(at).timeIntervalSinceNow
      guard granted, remaining >= 1, TimerAlerts.isCurrent(generation) else { return false }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      let identifier = TimerAlerts.identifier(generation)
      let trigger = UNTimeIntervalNotificationTrigger(timeInterval: remaining, repeats: false)
      do {
        try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
      } catch {
        return false
      }
      // A newer schedule or a cancel arrived while this one was being added.
      guard TimerAlerts.isCurrent(generation) else {
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        return false
      }
      return true
    }

    Function("cancelAlert") {
      let generation = TimerAlerts.next()
      Task { await TimerAlerts.remove(through: generation) }
    }
  }
}

/// The timer alert's generations. Each alert has its own identifier, so an
/// older request can never remove or replace a newer one.
enum TimerAlerts {
  private static let prefix = "build.bent.fitness.workout-timer."
  private static let lock = NSLock()
  // Starts from the clock, so generations keep rising across launches and
  // alerts left from an earlier launch are older than any new one.
  private static var generation = Int(Date().timeIntervalSince1970 * 1000)

  /// Starts a new generation and returns it.
  static func next() -> Int {
    lock.lock()
    defer { lock.unlock() }
    generation += 1
    return generation
  }

  static func isCurrent(_ value: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return generation == value
  }

  static func identifier(_ value: Int) -> String { "\(prefix)\(value)" }

  /// Removes pending and delivered timer alerts from generations up to
  /// `last`. A slow removal never touches an alert a later call scheduled.
  static func remove(through last: Int) async {
    let center = UNUserNotificationCenter.current()
    let pending = await center.pendingNotificationRequests().map(\.identifier)
    let delivered = await center.deliveredNotifications().map(\.request.identifier)
    let ours = { (id: String) -> Bool in
      guard id.hasPrefix(prefix), let value = Int(id.dropFirst(prefix.count)) else { return false }
      return value <= last
    }
    center.removePendingNotificationRequests(withIdentifiers: pending.filter(ours))
    center.removeDeliveredNotifications(withIdentifiers: delivered.filter(ours))
  }
}
