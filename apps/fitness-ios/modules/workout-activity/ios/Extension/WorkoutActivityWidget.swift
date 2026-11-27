import ActivityKit
import SwiftUI
import WidgetKit

@main
struct WorkoutActivityBundle: WidgetBundle {
  var body: some Widget {
    WorkoutActivityWidget()
  }
}

/// The app's primary colour in its light and dark themes (global.css).
private let accent = Color(red: 0.024, green: 0.278, blue: 1.0)
private let accentDark = Color(red: 0.157, green: 0.439, blue: 1.0)

/// The workout Live Activity on the Lock Screen and in the Dynamic Island.
struct WorkoutActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: WorkoutActivityAttributes.self) { context in
      LockScreenView(context: context)
        .activityBackgroundTint(nil)
        .activitySystemActionForegroundColor(accent)
    } dynamicIsland: { context in
      let view = Content(context: context)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label {
            Text(view.leadingTitle).font(.caption.weight(.semibold)).lineLimit(1)
          } icon: {
            Image(systemName: view.symbol)
          }
          .foregroundStyle(accentDark)
          .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          view.countdown(font: .title2.weight(.bold))
            .foregroundStyle(view.counting ? accentDark : .primary)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Text(view.headline).font(.headline).lineLimit(1)
            Text(view.subline).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            if let whole = view.finalTimer {
              HStack(spacing: 4) {
                Text("Hold ends in")
                Text(timerInterval: whole, countsDown: true).monospacedDigit()
              }
              .font(.caption).foregroundStyle(.secondary)
            }
            ProgressView(value: Double(view.state.completed), total: Double(max(view.state.total, 1)))
              .tint(accentDark)
          }
          .padding(.horizontal, 4)
        }
      } compactLeading: {
        Image(systemName: view.symbol).foregroundStyle(accentDark)
      } compactTrailing: {
        view.compact.foregroundStyle(view.counting ? accentDark : .primary)
      } minimal: {
        Image(systemName: view.symbol).foregroundStyle(accentDark)
      }
      .keylineTint(accentDark)
    }
  }
}

/// What a context shows, shared by the Lock Screen and Dynamic Island.
struct Content {
  let context: ActivityViewContext<WorkoutActivityAttributes>
  var state: WorkoutActivityAttributes.ContentState { context.state }

  // The activity goes stale at the end of a rest, or of a whole hold, so
  // staleness alone says the timer is done. While the app is suspended it
  // can't move a hold to its next phase; that phase's countdown stops at
  // 0:00 and the countdown to the end of the whole hold keeps running.

  /// A rest or hold is running.
  var counting: Bool { state.timer != nil && !context.isStale }
  /// The rest or hold ended before the app updated the activity.
  var ended: Bool { state.timerEnd != nil && context.isStale }
  /// The countdown to the end of the whole hold, while it runs.
  var finalTimer: ClosedRange<Date>? { counting ? state.finalTimer : nil }

  var symbol: String {
    switch state.phase {
    case "rest": return ended ? "checkmark.circle.fill" : "timer"
    case "ready", "hold": return ended ? "checkmark.circle.fill" : "stopwatch"
    default: return "dumbbell.fill"
    }
  }
  var leadingTitle: String { ended ? state.doneTitle : state.phase == "lift" ? context.attributes.workoutName : state.title }
  var headline: String { ended ? state.doneTitle : state.exercise }
  var subline: String { ended ? state.doneDetail : state.detail }

  /// The countdown, or the session's elapsed time while lifting.
  @ViewBuilder func countdown(font: Font) -> some View {
    if counting, let timer = state.timer {
      Text(timerInterval: timer, countsDown: true)
        .font(font).monospacedDigit().multilineTextAlignment(.trailing)
    } else if ended {
      Text("0:00").font(font).monospacedDigit()
    } else {
      Text(context.attributes.startedAt, style: .timer)
        .font(font).monospacedDigit().multilineTextAlignment(.trailing)
    }
  }

  /// The compact Dynamic Island's trailing text: the countdown to the end of
  /// the rest or whole hold, or sets done.
  @ViewBuilder var compact: some View {
    if let timer = finalTimer ?? (counting ? state.timer : nil) {
      Text(timerInterval: timer, countsDown: true)
        .monospacedDigit().frame(maxWidth: 44).multilineTextAlignment(.trailing)
    } else if ended {
      Image(systemName: "checkmark")
    } else {
      Text("\(state.completed)/\(state.total)").monospacedDigit()
    }
  }
}

struct LockScreenView: View {
  let context: ActivityViewContext<WorkoutActivityAttributes>
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let view = Content(context: context)
    let tint = scheme == .dark ? accentDark : accent
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Image(systemName: "dumbbell.fill").foregroundStyle(tint)
        Text(context.attributes.workoutName).font(.footnote.weight(.semibold)).lineLimit(1)
        Spacer(minLength: 8)
        Text(context.attributes.startedAt, style: .timer)
          .font(.footnote).monospacedDigit().foregroundStyle(.secondary)
          .multilineTextAlignment(.trailing).frame(maxWidth: 70, alignment: .trailing)
      }
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          if view.counting || view.ended {
            Text(view.ended ? view.state.doneTitle : view.state.title)
              .font(.caption.weight(.semibold)).textCase(.uppercase)
              .foregroundStyle(view.ended ? .secondary : tint)
          }
          Text(view.headline).font(.headline).lineLimit(1)
          Text(view.subline).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
          if let whole = view.finalTimer {
            HStack(spacing: 4) {
              Text("Hold ends in")
              Text(timerInterval: whole, countsDown: true).monospacedDigit()
            }
            .font(.caption).foregroundStyle(.secondary)
          }
        }
        Spacer(minLength: 8)
        if view.counting || view.ended {
          view.countdown(font: .system(size: 40, weight: .heavy))
            .foregroundStyle(view.ended ? .secondary : tint)
            .frame(maxWidth: 130, alignment: .trailing)
        }
      }
      ProgressView(value: Double(view.state.completed), total: Double(max(view.state.total, 1)))
        .tint(tint)
      Text("\(view.state.completed) of \(view.state.total) sets handled")
        .font(.caption).foregroundStyle(.secondary)
    }
    .padding(16)
  }
}
