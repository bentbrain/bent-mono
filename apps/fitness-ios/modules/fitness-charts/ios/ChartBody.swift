import Charts
import SwiftUI

/// The chart's state, shared by the SwiftUI view and the touch handling in `FitnessChartView`.
final class ChartModel: ObservableObject {
  @Published var spec = ChartSpec()
  @Published var selected: Int?
  @Published var layout = ChartLayout() { didSet { updateFit() } }
  @Published var cardSize: CGSize = .zero { didSet { updateFit() } }
  /// Whether the card fits inside the chart. When it doesn't, the card is
  /// hidden and JavaScript shows the details below the chart.
  @Published private(set) var cardFits = true
  var onFitChange: ((Bool) -> Void)?

  private func updateFit() {
    guard cardSize != .zero, layout.size != .zero else { return }
    let fits = ChartSelection.fits(card: cardSize, in: layout.size)
    guard fits != cardFits else { return }
    cardFits = fits
    onFitChange?(fits)
  }
}

private struct LayoutKey: PreferenceKey {
  static var defaultValue = ChartLayout()
  static func reduce(value: inout ChartLayout, nextValue: () -> ChartLayout) { value = nextValue() }
}

private struct CardSizeKey: PreferenceKey {
  static var defaultValue = CGSize.zero
  static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

private func color(_ value: UIColor?, _ fallback: Color) -> Color {
  value.map { Color(uiColor: $0) } ?? fallback
}

/// A line or bar chart drawn with Swift Charts, with a cursor and a popover for the selected point.
struct ChartBody: View {
  @ObservedObject var model: ChartModel

  private var spec: ChartSpec { model.spec }
  private var colors: ChartColors { model.spec.colors }

  var body: some View {
    chart
      .chartOverlay { proxy in
        GeometryReader { geometry in
          Color.clear.preference(key: LayoutKey.self, value: layout(proxy: proxy, geometry: geometry))
        }
      }
      .onPreferenceChange(LayoutKey.self) { model.layout = $0 }
      .overlay(alignment: .topLeading) { popover }
      .onPreferenceChange(CardSizeKey.self) { model.cardSize = $0 }
  }

  @ViewBuilder private var chart: some View {
    switch spec.kind {
    case .line: lineChart
    case .bar: barChart
    }
  }

  // MARK: Line charts

  private var xDomain: ClosedRange<Double> {
    let xs = spec.points.map(\.x) + spec.average.map(\.x)
    guard let low = xs.min(), let high = xs.max() else { return 0...1 }
    return low < high ? low...high : (low - 1)...(high + 1)
  }

  private var yDomain: ClosedRange<Double> {
    spec.yMin < spec.yMax ? spec.yMin...spec.yMax : (spec.yMin - 1)...(spec.yMax + 1)
  }

  private var lineChart: some View {
    let line = color(colors.line, .accentColor)
    let selectedPoint = model.selected.flatMap { spec.points.indices.contains($0) ? spec.points[$0] : nil }
    return Chart {
      ForEach(Array(spec.guides.enumerated()), id: \.offset) { _, value in
        RuleMark(y: .value("Guide", value))
          .foregroundStyle(color(colors.guide, .secondary))
          .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 6]))
      }
      if let point = selectedPoint {
        RuleMark(x: .value("Selected", point.x))
          .foregroundStyle(color(colors.cursor, .secondary))
          .lineStyle(StrokeStyle(lineWidth: 1))
      }
      ForEach(Array(spec.points.enumerated()), id: \.offset) { _, point in
        LineMark(x: .value("X", point.x), y: .value("Y", point.y), series: .value("Series", "value"))
          .foregroundStyle(line)
          .lineStyle(StrokeStyle(lineWidth: 3))
          .symbol(.circle)
          .symbolSize(28)
      }
      ForEach(Array(spec.average.enumerated()), id: \.offset) { _, point in
        LineMark(x: .value("X", point.x), y: .value("Y", point.y), series: .value("Series", "average"))
          .foregroundStyle(color(colors.average, .primary))
          .lineStyle(StrokeStyle(lineWidth: 2.5, dash: [8, 5]))
      }
      if let point = selectedPoint {
        PointMark(x: .value("X", point.x), y: .value("Y", point.y))
          .foregroundStyle(color(colors.card, .white))
          .symbolSize(220)
        PointMark(x: .value("X", point.x), y: .value("Y", point.y))
          .foregroundStyle(line)
          .symbolSize(100)
      }
    }
    // Padding keeps the first and last points whole at the plot's edges.
    .chartXScale(domain: xDomain, range: .plotDimension(padding: 6))
    .chartYScale(domain: yDomain)
    .chartXAxis(.hidden)
    .chartYAxis(.hidden)
    .chartLegend(.hidden)
  }

  // MARK: Bar charts

  private var barChart: some View {
    let categories = spec.categories
    let chosen = model.selected.flatMap { categories.indices.contains($0) ? categories[$0] : nil }
    let radius = CGFloat(spec.cornerRadius)
    return Chart {
      if let chosen {
        RuleMark(x: .value("Selected", chosen))
          .foregroundStyle(color(colors.cursor, .secondary))
          .lineStyle(StrokeStyle(lineWidth: 1))
      }
      ForEach(Array(spec.bars.enumerated()), id: \.offset) { _, bar in
        BarMark(x: .value("X", bar.x), y: .value("Y", bar.y))
          .foregroundStyle(color(bar.color, .accentColor))
          .cornerRadius(radius)
          .opacity(chosen == nil || chosen == bar.x ? 1 : 0.45)
      }
      if let target = spec.target {
        RuleMark(y: .value("Target", target))
          .foregroundStyle(color(colors.target, .secondary))
          .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
      }
    }
    // The categories keep their order whichever mark names one first.
    .chartXScale(domain: categories)
    .chartXAxis(spec.showAxes ? .visible : .hidden)
    .chartYAxis(spec.showAxes ? .visible : .hidden)
    .chartLegend(.hidden)
    .animation(spec.animate ? .easeInOut : nil, value: spec.bars.count)
  }

  // MARK: Selection

  private func plotFrame(_ proxy: ChartProxy, _ geometry: GeometryProxy) -> CGRect {
    if #available(iOS 17, *) {
      return proxy.plotFrame.map { geometry[$0] } ?? .zero
    }
    return geometry[proxy.plotAreaFrame]
  }

  /// Where each selectable point is, in the chart view's coordinates.
  private func layout(proxy: ChartProxy, geometry: GeometryProxy) -> ChartLayout {
    let plot = plotFrame(proxy, geometry)
    switch spec.kind {
    case .line:
      return ChartLayout(
        size: geometry.size,
        plot: plot,
        xs: spec.points.map { plot.minX + (proxy.position(forX: $0.x) ?? 0) },
        ys: spec.points.map { plot.minY + (proxy.position(forY: $0.y) ?? 0) }
      )
    case .bar:
      return ChartLayout(
        size: geometry.size,
        plot: plot,
        xs: spec.categories.map { plot.minX + (proxy.position(forX: $0) ?? 0) },
        ys: spec.categories.map { _ in plot.minY }
      )
    }
  }

  @ViewBuilder private var popover: some View {
    if let index = model.selected,
       spec.labels.indices.contains(index),
       model.layout.xs.indices.contains(index),
       model.layout.ys.indices.contains(index) {
      let label = spec.labels[index]
      let anchor = CGPoint(
        x: model.layout.xs[index],
        y: spec.kind == .line ? model.layout.ys[index] : model.layout.plot.minY + model.cardSize.height / 2
      )
      let origin = ChartSelection.place(card: model.cardSize, anchor: anchor, in: model.layout.size)
      // The card wraps within this width and takes the height its text needs.
      PopoverCard(label: label, colors: colors)
        .fixedSize(horizontal: false, vertical: true)
        .background(GeometryReader { Color.clear.preference(key: CardSizeKey.self, value: $0.size) })
        .frame(width: ChartSelection.cardWidth(in: model.layout.size), alignment: .topLeading)
        .offset(x: origin.x, y: origin.y)
        .opacity(model.cardSize == .zero || !model.cardFits ? 0 : 1)
        .allowsHitTesting(false)
    }
  }
}

/// The popover: the point's title, then its detail lines.
private struct PopoverCard: View {
  let label: PointLabel
  let colors: ChartColors

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label.title)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(color(colors.text, .primary))
      Text(label.detail)
        .font(.caption.monospacedDigit())
        .foregroundStyle(color(colors.muted, .secondary))
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(color(colors.card, Color(uiColor: .secondarySystemBackground)))
    )
  }
}
