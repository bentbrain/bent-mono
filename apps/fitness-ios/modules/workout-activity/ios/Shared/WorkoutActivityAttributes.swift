import ActivityKit
import Foundation

/// The workout Live Activity's data. The app module and the widget extension
/// both compile this file, so ActivityKit matches their types by name.
public struct WorkoutActivityAttributes: ActivityAttributes {
  /// The changing part: the current set, and the rest or hold counting down.
  public struct ContentState: Codable, Hashable {
    /// "lift", "rest", "ready" or "hold".
    public var phase: String
    public var title: String
    public var exercise: String
    public var detail: String
    public var doneTitle: String
    public var doneDetail: String
    public var completed: Int
    public var total: Int
    public var timerStart: Date?
    public var timerEnd: Date?
    /// When a whole hold ends, after its get-ready and switch phases.
    public var finalEnd: Date?

    public init(
      phase: String, title: String, exercise: String, detail: String, doneTitle: String, doneDetail: String,
      completed: Int, total: Int, timerStart: Date?, timerEnd: Date?, finalEnd: Date?
    ) {
      self.phase = phase
      self.title = title
      self.exercise = exercise
      self.detail = detail
      self.doneTitle = doneTitle
      self.doneDetail = doneDetail
      self.completed = completed
      self.total = total
      self.timerStart = timerStart
      self.timerEnd = timerEnd
      self.finalEnd = finalEnd
    }

    /// The countdown's interval, when a rest or hold is running.
    public var timer: ClosedRange<Date>? {
      guard let start = timerStart, let end = timerEnd, start < end else { return nil }
      return start...end
    }

    /// The countdown to the end of a whole hold.
    public var finalTimer: ClosedRange<Date>? {
      guard let start = timerStart, let end = finalEnd, start < end else { return nil }
      return start...end
    }
  }

  public var workoutId: String
  public var workoutName: String
  public var startedAt: Date

  public init(workoutId: String, workoutName: String, startedAt: Date) {
    self.workoutId = workoutId
    self.workoutName = workoutName
    self.startedAt = startedAt
  }
}
