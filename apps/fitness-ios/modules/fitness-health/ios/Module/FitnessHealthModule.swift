import ExpoModulesCore
import HealthKit

public final class FitnessHealthModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FitnessHealth")

    Function("healthDataAvailable") { () -> Bool in
      HKHealthStore.isHealthDataAvailable()
    }
  }
}
