import ExpoModulesCore
import UIKit

/// Whether the chart draws lines or bars.
enum ChartKind: String, Enumerable {
  case line
  case bar
}

/// A point on a line chart.
struct LinePoint: Record {
  @Field var x: Double = 0
  @Field var y: Double = 0
}

/// One bar, or one part of a stacked bar when bars share an `x`.
struct BarPoint: Record {
  @Field var x: String = ""
  @Field var y: Double = 0
  @Field var color: UIColor?
}

/// What the popover says for one point or bar.
struct PointLabel: Record {
  @Field var title: String = ""
  @Field var detail: String = ""
}

/// A selection JavaScript asks for, such as a VoiceOver adjustment. Each
/// request has a new `id`, so asking for the same index again applies it.
struct SelectionRequest: Record {
  @Field var index: Int = -1
  @Field var id: Int = 0
}

/// The chart's colours, from the app's theme tokens.
struct ChartColors: Record {
  @Field var line: UIColor?
  @Field var average: UIColor?
  @Field var guide: UIColor?
  @Field var target: UIColor?
  @Field var cursor: UIColor?
  @Field var card: UIColor?
  @Field var text: UIColor?
  @Field var muted: UIColor?
}

/// Everything JavaScript sends to draw one chart.
struct ChartSpec: Record {
  @Field var kind: ChartKind = .line
  // Line charts.
  @Field var points: [LinePoint] = []
  @Field var average: [LinePoint] = []
  @Field var guides: [Double] = []
  @Field var yMin: Double = 0
  @Field var yMax: Double = 1
  // Bar charts.
  @Field var bars: [BarPoint] = []
  @Field var target: Double?
  @Field var showAxes: Bool = false
  @Field var cornerRadius: Double = 3
  @Field var animate: Bool = false
  /// One label for each point of a line chart, or each `x` of a bar chart in order.
  @Field var labels: [PointLabel] = []
  @Field var colors: ChartColors = ChartColors()

  /// The bar chart's categories, in the order they first appear.
  var categories: [String] {
    var seen = Set<String>()
    return bars.compactMap { seen.insert($0.x).inserted ? $0.x : nil }
  }

  /// How many points or categories can be selected.
  var selectableCount: Int {
    min(labels.count, kind == .line ? points.count : categories.count)
  }
}
