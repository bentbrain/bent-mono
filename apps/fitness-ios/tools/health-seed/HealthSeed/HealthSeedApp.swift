import SwiftUI

/// A Simulator-only app that writes synthetic weigh-ins and runs to Apple
/// Health. Fitness Sync can see them only when the user allows it to read
/// Health data, because another app wrote them.
@main
struct HealthSeedApp: App {
  @State private var model = SeedModel()

  var body: some Scene {
    WindowGroup {
      VStack(spacing: 24) {
        Text("Health Seed").font(.title)
        Text(model.status)
          .accessibilityIdentifier("status")
          .multilineTextAlignment(.center)
        Button("Seed synthetic samples") { model.run(.seed) }
          .accessibilityIdentifier("seed")
        Button("Remove synthetic samples") { model.run(.clear) }
          .accessibilityIdentifier("clear")
      }
      .padding()
      .task { model.runLaunchAction() }
    }
  }
}

@MainActor
@Observable
final class SeedModel {
  enum Action: String { case seed, clear }

  private(set) var status = "Ready"
  private let seeder = Seeder()

  /// Runs the action named by `-action seed` or `-action clear`, if any.
  func runLaunchAction() {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-action"), index + 1 < arguments.count,
      let action = Action(rawValue: arguments[index + 1])
    else { return }
    run(action)
  }

  func run(_ action: Action) {
    status = "Working"
    Task {
      do {
        switch action {
        case .seed:
          let count = try await seeder.seed(now: Date())
          status = "Seeded \(count) samples"
        case .clear:
          try await seeder.clear()
          status = "Removed synthetic samples"
        }
      } catch {
        status = "Failed: \(error.localizedDescription)"
      }
    }
  }
}
