import ExpoModulesCore

/// Line and bar charts drawn with Swift Charts, with touch selection.
public final class FitnessChartsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FitnessCharts")

    View(FitnessChartView.self) {
      Events("onSelectionChange", "onCardFit")

      Prop("chart") { (view: FitnessChartView, chart: ChartSpec) in
        view.update(chart)
      }

      Prop("selection") { (view: FitnessChartView, request: SelectionRequest?) in
        if let request { view.request(request.index) }
      }

      OnViewDidUpdateProps { (view: FitnessChartView) in
        view.propsUpdated()
      }
    }
  }
}
