import ExpoModulesCore
import SwiftUI
import UIKit

/// Hosts the SwiftUI chart and turns touches into a selection, as Apple
/// Health does: a tap selects the nearest point and a second tap on it
/// clears it; a long press, or a sideways drag, follows the finger. The
/// selection stays after the finger lifts. A vertical drag scrolls the page.
final class FitnessChartView: ExpoView, UIGestureRecognizerDelegate {
  private let model = ChartModel()
  private lazy var host = UIHostingController(rootView: ChartBody(model: model))
  private let haptics = UISelectionFeedbackGenerator()
  private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(scrub(_:)))
  /// Sends `{ index }` when a touch or a data change moves the selection; -1 means none.
  let onSelectionChange = EventDispatcher()
  /// Sends `{ fits }` when the card starts or stops fitting inside the chart.
  let onCardFit = EventDispatcher()
  /// A selection JavaScript asked for, applied once all props are set.
  private var requested: Int?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    host.safeAreaRegions = []
    host.view.backgroundColor = .clear
    host.view.isUserInteractionEnabled = false
    host.view.accessibilityElementsHidden = true
    addSubview(host.view)

    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    let press = UILongPressGestureRecognizer(target: self, action: #selector(scrub(_:)))
    press.minimumPressDuration = 0.25
    press.allowableMovement = 12
    pan.delegate = self
    for recognizer in [tap, press, pan] { addGestureRecognizer(recognizer) }
    model.onFitChange = { [weak self] fits in self?.onCardFit(["fits": fits]) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
  }

  func update(_ spec: ChartSpec) {
    model.spec = spec
  }

  /// A selection JavaScript asked for, such as a VoiceOver adjustment; -1 clears it.
  func request(_ index: Int) {
    requested = index
  }

  /// Applies JavaScript's selection, then drops a selection the data no longer has.
  func propsUpdated() {
    if let index = requested {
      requested = nil
      model.selected = index >= 0 && index < model.spec.selectableCount ? index : nil
    }
    if let selected = model.selected, selected >= model.spec.selectableCount {
      model.selected = nil
      onSelectionChange(["index": -1])
    }
  }

  private func nearest(_ recognizer: UIGestureRecognizer) -> Int? {
    let positions = Array(model.layout.xs.prefix(model.spec.selectableCount))
    return ChartSelection.nearest(positions, to: recognizer.location(in: self).x)
  }

  private func select(_ index: Int?) {
    guard index != model.selected else { return }
    model.selected = index
    onSelectionChange(["index": index ?? -1])
    if index != nil {
      haptics.selectionChanged()
      haptics.prepare()
    }
  }

  @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
    guard let index = nearest(recognizer) else { return }
    select(index == model.selected ? nil : index)
  }

  @objc private func scrub(_ recognizer: UIGestureRecognizer) {
    switch recognizer.state {
    case .began:
      haptics.prepare()
      select(nearest(recognizer))
    case .changed:
      select(nearest(recognizer))
    default:
      break
    }
  }

  // MARK: UIGestureRecognizerDelegate

  /// The sideways drag starts only when the finger moves more across than up or down.
  override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
    guard recognizer === pan else { return super.gestureRecognizerShouldBegin(recognizer) }
    let velocity = pan.velocity(in: self)
    return abs(velocity.x) > abs(velocity.y)
  }

  /// A scroll view waits for the sideways drag to fail, so a vertical drag scrolls and a sideways one selects.
  func gestureRecognizer(
    _ recognizer: UIGestureRecognizer,
    shouldBeRequiredToFailBy other: UIGestureRecognizer
  ) -> Bool {
    recognizer === pan && other.view is UIScrollView && other is UIPanGestureRecognizer
  }
}
