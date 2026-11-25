import ExpoModulesCore
import UIKit

/// Starts the sync service with the app, including when HealthKit wakes it
/// in the background, and catches up whenever the app comes forward.
public final class FitnessHealthAppDelegate: ExpoAppDelegateSubscriber {
  private var observers: [NSObjectProtocol] = []

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let service = SyncService.shared
    service.launched()
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: nil
      ) { _ in
        Task { await service.resume() }
      })
    observers.append(
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { _ in
        Task { await service.resume(foreground: true) }
      })
    return true
  }
}
