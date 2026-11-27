import CoreGraphics

/// Where each selectable point sits in the chart view, as Swift Charts laid it out.
struct ChartLayout: Equatable {
  var size: CGSize = .zero
  var plot: CGRect = .zero
  var xs: [CGFloat] = []
  var ys: [CGFloat] = []
}

enum ChartSelection {
  /// The index of the position closest to `x`, the first on a tie, or nil without positions.
  static func nearest(_ positions: [CGFloat], to x: CGFloat) -> Int? {
    var best: Int?
    for (index, position) in positions.enumerated() {
      guard let current = best else {
        best = index
        continue
      }
      if abs(position - x) < abs(positions[current] - x) { best = index }
    }
    return best
  }

  /// The widest the popover gets: at most 240 points, and never wider than the chart.
  static func cardWidth(in size: CGSize) -> CGFloat {
    max(0, min(240, size.width))
  }

  /// Whether a card of this size fits inside the chart, so it can show over the plot.
  static func fits(card: CGSize, in size: CGSize) -> Bool {
    card.height <= size.height && card.width <= size.width
  }

  /// The popover's top-left corner: beside the anchor, on the right when it
  /// fits and otherwise on the left, level with the anchor, and inside the
  /// chart when the card is smaller than it.
  static func place(card: CGSize, anchor: CGPoint, in size: CGSize, gap: CGFloat = 10) -> CGPoint {
    func clamp(_ value: CGFloat, _ upper: CGFloat) -> CGFloat { max(0, min(value, max(0, upper))) }
    let right = anchor.x + gap
    let left = right + card.width <= size.width ? right : anchor.x - gap - card.width
    return CGPoint(x: clamp(left, size.width - card.width), y: clamp(anchor.y - card.height / 2, size.height - card.height))
  }
}
