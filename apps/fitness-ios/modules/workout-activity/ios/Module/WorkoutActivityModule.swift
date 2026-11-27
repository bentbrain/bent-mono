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

  var content: WorkoutActivityAttributes.ContentState {
    WorkoutActivityAttributes.ContentState(
      phase: phase, title: title, exercise: exercise, detail: detail, doneTitle: doneTitle, doneDetail: doneDetail,
      completed: completed, total: total, timerStart: timerStart.map(date), timerEnd: timerEnd.map(date))
  }
}

private func date(_ milliseconds: Double) -> Date {
  Date(timeIntervalSince1970: milliseconds / 1000)
}

/// Shows the workout Live Activity and schedules the alert for the end of a
/// rest or hold. The Live Activity has no push updates: the app updates it
/// while it runs, and its countdowns run on their own.
public final class WorkoutActivityModule: Module {
  private static let alertId = "build.bent.fitness.workout-timer"

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
    // app is open, where the logger gives its own haptic.
    AsyncFunction("scheduleAlert") { (title: String, body: String, at: Double) async -> Bool in
      let center = UNUserNotificationCenter.current()
      center.removePendingNotificationRequests(withIdentifiers: [Self.alertId])
      guard date(at).timeIntervalSinceNow >= 1 else { return false }
      let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
      // The permission prompt can take a while, so the time left is read again.
      let remaining = date(at).timeIntervalSinceNow
      guard granted, remaining >= 1 else { return false }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      let trigger = UNTimeIntervalNotificationTrigger(timeInterval: remaining, repeats: false)
      do {
        try await center.add(UNNotificationRequest(identifier: Self.alertId, content: content, trigger: trigger))
        return true
      } catch {
        return false
      }
    }

    Function("cancelAlert") {
      let center = UNUserNotificationCenter.current()
      center.removePendingNotificationRequests(withIdentifiers: [Self.alertId])
      center.removeDeliveredNotifications(withIdentifiers: [Self.alertId])
    }
  }
}
