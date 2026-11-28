import ExpoModulesCore
import Foundation
import WidgetKit

/// Writes the Today widget's snapshot to the App Group container and asks
/// WidgetKit to reload the widget's timeline.
public final class WorkoutWidgetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WorkoutWidget")

    // Rejects JSON the widget can't read, and a missing App Group.
    AsyncFunction("save") { (json: String) throws in
      try TodayStore.write(Data(json.utf8))
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
