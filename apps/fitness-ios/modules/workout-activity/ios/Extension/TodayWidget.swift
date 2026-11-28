import SwiftUI
import WidgetKit

/// One moment of the Today widget's timeline.
struct TodayEntry: TimelineEntry {
  enum Content: Equatable {
    /// The day the account is on, from the app's snapshot.
    case day(TodaySnapshot.Day)
    /// Signed out: no account data, a prompt to sign in.
    case signedOut
    /// The app hasn't written a snapshot yet.
    case missing
    /// The snapshot's days have all passed.
    case outOfDate
  }

  let date: Date
  let content: Content
}

/// The timeline for a snapshot: the current day now, then each later day
/// from its midnight in the account timezone, then a prompt to open the app
/// once the snapshot's last day ends.
enum TodayTimeline {
  static func entries(_ snapshot: TodaySnapshot?, now: Date) -> [TodayEntry] {
    guard let snapshot else { return [TodayEntry(date: now, content: .missing)] }
    guard snapshot.signedIn, let days = snapshot.days?.sorted(by: { $0.start < $1.start }), let last = days.last
    else { return [TodayEntry(date: now, content: .signedOut)] }
    guard now < last.endDate else { return [TodayEntry(date: now, content: .outOfDate)] }
    // The day under way, or the first day when the clock is behind the snapshot.
    let current = days.last { $0.startDate <= now } ?? days.first
    var entries = current.map { [TodayEntry(date: now, content: .day($0))] } ?? []
    entries += days.filter { $0.startDate > now }.map { TodayEntry(date: $0.startDate, content: .day($0)) }
    entries.append(TodayEntry(date: last.endDate, content: .outOfDate))
    return entries
  }
}

struct TodayProvider: TimelineProvider {
  func placeholder(in context: Context) -> TodayEntry {
    TodayEntry(date: Date(), content: .day(.sample))
  }

  func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
    let entry = TodayTimeline.entries(TodayStore.read(), now: Date())[0]
    // The widget gallery shows a sample day until the app has written one.
    completion(context.isPreview && !entry.content.showsAccount ? placeholder(in: context) : entry)
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
    let now = Date()
    let entries = TodayTimeline.entries(TodayStore.read(), now: now)
    // The app reloads the timeline each time it writes a snapshot. A snapshot
    // that can't be read yet, as before the first unlock after a restart, is
    // read again in 15 minutes.
    let unreadable = entries.first?.content == .missing
    completion(Timeline(entries: entries, policy: unreadable ? .after(now.addingTimeInterval(15 * 60)) : .never))
  }
}

/// Today's plan and food on the Home Screen and the Lock Screen.
struct TodayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "TodayWidget", provider: TodayProvider()) { entry in
      TodayWidgetView(entry: entry)
    }
    .configurationDisplayName("Today")
    .description("Today's plan, and calories, protein and tracked nutrients against your targets.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular, .accessoryInline])
  }
}

struct TodayWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: TodayEntry

  var body: some View {
    TodayFamilyView(family: family, content: entry.content)
  }
}

/// The widget for one family, laid out for its size.
struct TodayFamilyView: View {
  @Environment(\.colorScheme) private var scheme
  let family: WidgetFamily
  let content: TodayEntry.Content

  var body: some View {
    let palette = TodayPalette(scheme)
    // The account's plan and food are redacted where iOS hides private
    // content, such as on the Lock Screen while the iPhone is locked.
    let sensitive = content.showsAccount
    switch family {
    case .systemMedium:
      TodayMedium(content: content, palette: palette)
        .privacySensitive(sensitive)
        .todayBackground(palette.card, padded: true)
        .widgetURL(content.link(\.week))
    case .accessoryRectangular:
      TodayRectangular(content: content)
        .privacySensitive(sensitive)
        .todayBackground(Color.clear, padded: false)
        .widgetURL(content.link(\.week))
    case .accessoryCircular:
      TodayCircular(content: content)
        .privacySensitive(sensitive)
        .todayBackground(Color.clear, padded: false)
        .widgetURL(content.link(\.food))
    case .accessoryInline:
      TodayInline(content: content)
        .privacySensitive(sensitive)
        .widgetURL(content.link(\.week))
    default:
      TodaySmall(content: content, palette: palette)
        .privacySensitive(sensitive)
        .todayBackground(palette.card, padded: true)
        .widgetURL(content.link(\.week))
    }
  }
}

// MARK: - Families

struct TodaySmall: View {
  let content: TodayEntry.Content
  let palette: TodayPalette

  var body: some View {
    if case .day(let day) = content {
      VStack(alignment: .leading, spacing: 0) {
        PlanHeader(plan: day.plan, palette: palette)
        Text(day.plan.title)
          .font(.title3.weight(.bold)).lineLimit(2).minimumScaleFactor(0.7)
          .padding(.top, 4)
        if let detail = day.plan.detail {
          Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2).minimumScaleFactor(0.8)
        }
        Spacer(minLength: 6)
        VStack(spacing: 5) {
          AmountRow(amount: day.food.calories, palette: palette)
          AmountRow(amount: day.food.protein, palette: palette)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    } else {
      MessageView(content: content, palette: palette)
    }
  }
}

struct TodayMedium: View {
  let content: TodayEntry.Content
  let palette: TodayPalette

  var body: some View {
    if case .day(let day) = content {
      HStack(alignment: .top, spacing: 14) {
        link(day.links.week) {
          VStack(alignment: .leading, spacing: 0) {
            PlanHeader(plan: day.plan, palette: palette)
            Text(day.plan.title)
              .font(.title3.weight(.bold)).lineLimit(2).minimumScaleFactor(0.75)
              .padding(.top, 6)
            if let detail = day.plan.detail {
              Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3).minimumScaleFactor(0.8)
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
          }
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        link(day.links.food) {
          FoodColumn(food: day.food, palette: palette)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
      }
    } else {
      MessageView(content: content, palette: palette)
    }
  }

  /// A part of the widget that opens its own place in the app.
  @ViewBuilder private func link<Label: View>(_ url: String, @ViewBuilder label: () -> Label) -> some View {
    if let destination = URL(string: url) {
      Link(destination: destination, label: label)
    } else {
      label()
    }
  }
}

/// Calories, protein and each tracked nutrient, with bars where there is room.
struct FoodColumn: View {
  let food: TodaySnapshot.Food
  let palette: TodayPalette

  var body: some View {
    let amounts = [food.calories, food.protein] + food.nutrients
    ViewThatFits(in: .vertical) {
      VStack(spacing: amounts.count > 3 ? 4 : 7) {
        ForEach(Array(amounts.enumerated()), id: \.offset) { _, amount in
          AmountRow(amount: amount, palette: palette)
        }
      }
      VStack(spacing: 2) {
        ForEach(Array(amounts.enumerated()), id: \.offset) { _, amount in
          AmountRow(amount: amount, palette: palette, bar: false)
        }
      }
    }
  }
}

struct TodayRectangular: View {
  let content: TodayEntry.Content

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      if case .day(let day) = content {
        Label {
          Text(day.plan.title).font(.headline).lineLimit(1)
        } icon: {
          Image(systemName: day.plan.symbol)
        }
        .widgetAccentable()
        Text(day.plan.summary)
          .font(.caption).lineLimit(1).minimumScaleFactor(0.8)
        Text("\(day.food.calories.fraction) kcal · \(day.food.protein.fraction) g protein")
          .font(.caption).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
      } else {
        Label("bent Fitness", systemImage: "figure.strengthtraining.traditional")
          .font(.headline).lineLimit(1).widgetAccentable()
        Text(content.message).font(.caption).lineLimit(2).minimumScaleFactor(0.8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct TodayCircular: View {
  let content: TodayEntry.Content

  var body: some View {
    if case .day(let day) = content {
      let calories = day.food.calories
      let target = max(calories.target ?? 0, 1)
      Gauge(value: min(calories.value, target), in: 0...target) {
        Image(systemName: "flame.fill")
      } currentValueLabel: {
        Text(calories.value.whole).monospacedDigit().minimumScaleFactor(0.5)
      }
      .gaugeStyle(.accessoryCircular)
      .widgetAccentable()
      .accessibilityLabel("\(calories.fraction) kcal")
    } else {
      ZStack {
        AccessoryWidgetBackground()
        Image(systemName: "figure.strengthtraining.traditional").font(.title3).widgetAccentable()
      }
      .accessibilityLabel(content.message)
    }
  }
}

struct TodayInline: View {
  let content: TodayEntry.Content

  var body: some View {
    if case .day(let day) = content {
      Label("\(day.plan.title) · \(day.food.calories.value.whole) kcal", systemImage: day.plan.symbol)
    } else {
      Label(content.shortMessage, systemImage: "figure.strengthtraining.traditional")
    }
  }
}

// MARK: - Parts

/// "Today" with the session's state, such as "Today · Planned", "Today · Done" or, on a rest day, "Today".
struct PlanHeader: View {
  let plan: TodaySnapshot.Plan
  let palette: TodayPalette

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: plan.symbol)
        .font(.caption.weight(.semibold))
        .foregroundStyle(palette.state(plan.state))
        .widgetAccentable()
      Text(plan.state == "rest" ? "Today" : "Today · \(plan.status)")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(plan.state == "done" ? palette.done : Color.secondary)
        .lineLimit(1)
    }
  }
}

/// "Calories 1125/2400 kcal" with a bar of progress to the target.
struct AmountRow: View {
  let amount: TodaySnapshot.Amount
  let palette: TodayPalette
  var bar = true

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(amount.label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        Spacer(minLength: 2)
        Text(amount.reading).font(.caption2.weight(.semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
      }
      if bar, let progress = amount.progress {
        ProgressBar(progress: progress, fill: palette.tone(amount.tone), track: palette.track)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// A bar of progress to a target. Where iOS redacts private content, only the track shows.
struct ProgressBar: View {
  @Environment(\.redactionReasons) private var redaction
  let progress: Double
  let fill: Color
  let track: Color

  var body: some View {
    let shown = redaction.contains(.privacy) ? 0 : progress
    GeometryReader { proxy in
      ZStack(alignment: .leading) {
        Capsule().fill(track)
        Capsule().fill(fill).frame(width: max(proxy.size.width * shown, shown > 0 ? 4 : 0)).widgetAccentable()
      }
    }
    .frame(height: 4)
    .accessibilityHidden(true)
  }
}

/// The widget without a day to show: signed out, not opened yet, or out of date.
struct MessageView: View {
  let content: TodayEntry.Content
  let palette: TodayPalette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Image(systemName: "figure.strengthtraining.traditional")
        .font(.title3.weight(.semibold)).foregroundStyle(palette.accent).widgetAccentable()
      Text("bent Fitness").font(.headline).lineLimit(1)
      Text(content.message).font(.caption).foregroundStyle(.secondary).lineLimit(4).minimumScaleFactor(0.8)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

// MARK: - Values

/// The app's semantic colours (global.css) for the light or dark theme.
struct TodayPalette {
  let accent: Color
  let done: Color
  let missed: Color
  let card: Color
  let track: Color

  init(_ scheme: ColorScheme) {
    let dark = scheme == .dark
    accent = dark ? Color(red: 0.157, green: 0.439, blue: 1.0) : Color(red: 0.024, green: 0.278, blue: 1.0)
    done = dark ? Color(red: 0.188, green: 0.820, blue: 0.345) : Color(red: 0.082, green: 0.502, blue: 0.239)
    missed = dark ? Color(red: 1.0, green: 0.541, blue: 0.298) : Color(red: 0.851, green: 0.282, blue: 0.059)
    card = dark ? Color(red: 0.110, green: 0.110, blue: 0.118) : .white
    track = dark ? Color(red: 0.227, green: 0.227, blue: 0.235) : Color(red: 0.890, green: 0.902, blue: 0.929)
  }

  func tone(_ tone: String) -> Color {
    switch tone {
    case "done": return done
    case "missed": return missed
    default: return accent
    }
  }

  func state(_ state: String) -> Color {
    switch state {
    case "done": return done
    case "rest": return Color.secondary
    default: return accent
    }
  }
}

extension TodayEntry.Content {
  /// Whether the widget shows the account's plan and food.
  var showsAccount: Bool {
    if case .day = self { return true }
    return false
  }

  var message: String {
    switch self {
    case .signedOut: return "Sign in to see today's plan and food."
    case .outOfDate: return "Open bent Fitness to update today's plan."
    default: return "Open bent Fitness to see today's plan and food."
    }
  }

  var shortMessage: String {
    self == .signedOut ? "Sign in to bent Fitness" : "Open bent Fitness"
  }

  /// The link to the day's place in the app, or none without a day.
  func link(_ path: KeyPath<TodaySnapshot.Links, String>) -> URL? {
    guard case .day(let day) = self else { return nil }
    return URL(string: day.links[keyPath: path])
  }
}

extension TodaySnapshot.Plan {
  /// The line under the session's name on the Lock Screen: its length or the
  /// next session while planned or resting, otherwise its state.
  var summary: String {
    switch state {
    case "planned", "rest": return detail ?? status
    case "inProgress": return detail.map { "\(status) · \($0)" } ?? status
    default: return status
    }
  }

  var symbol: String {
    switch state {
    case "done": return "checkmark.circle.fill"
    case "inProgress": return "figure.strengthtraining.traditional"
    default:
      switch kind {
      case "strength": return "dumbbell.fill"
      case "run": return "figure.run"
      default: return "bed.double.fill"
      }
    }
  }
}

extension TodaySnapshot.Amount {
  /// "1125/2400", or "40" without a target.
  var fraction: String {
    target.map { "\(value.whole)/\($0.whole)" } ?? value.whole
  }

  /// "1125/2400 kcal", "57/120 g", or "40 g" without a target.
  var reading: String { "\(fraction) \(unit)" }
}

extension Double {
  /// The value as a whole number, such as 1125.
  var whole: String { String(Int(rounded())) }
}

extension TodaySnapshot.Day {
  /// A synthetic day for the widget gallery and placeholders.
  static let sample = TodaySnapshot.Day(
    day: "2026-01-05", start: 0, end: 0,
    plan: TodaySnapshot.Plan(
      kind: "strength", title: "Strength A", detail: "6 exercises · about 45 min", state: "planned", status: "Planned"),
    food: TodaySnapshot.Food(
      calories: TodaySnapshot.Amount(label: "Calories", unit: "kcal", value: 1125, target: 2400, tone: "default"),
      protein: TodaySnapshot.Amount(label: "Protein", unit: "g", value: 57, target: 120, tone: "default"),
      nutrients: []),
    links: TodaySnapshot.Links(week: "", food: ""))
}

extension View {
  /// The widget's background: the container background from iOS 17, and
  /// padding with the background before it.
  @ViewBuilder func todayBackground(_ color: Color, padded: Bool) -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(color, for: .widget)
    } else if padded {
      padding().background(color)
    } else {
      self
    }
  }
}
