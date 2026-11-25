import Foundation
import HealthKit
import os
import UIKit

/// The app's one sync service: the device lifecycle, the coordinator and
/// the HealthKit observers. Logs carry codes and counts only.
final class SyncService: @unchecked Sendable {
  static let shared = SyncService()

  let origin: URL
  let health = HKHealthStore()
  let lifecycle: DeviceLifecycle
  private(set) var coordinator: SyncCoordinator!
  private let source: HealthKitSource
  private let log = Logger(subsystem: "build.bent.fitness", category: "sync")
  private let lock = NSLock()
  private var observers: [HKObserverQuery] = []
  /// Called with each finished run, for the JavaScript status screen.
  var onResult: (@Sendable ([String: Any]) -> Void)?

  private init() {
    let configured = Bundle.main.object(forInfoDictionaryKey: "FitnessOrigin") as? String
    origin = URL(string: configured ?? "https://fitness.bent.build") ?? URL(string: "https://fitness.bent.build")!
    source = HealthKitSource(store: health)
    let transport = PinnedTransport(origin: origin)
    let pinned = origin
    let states = (try? SyncStateFiles.standard())
      ?? SyncStateFiles(root: FileManager.default.temporaryDirectory.appendingPathComponent("sync"))
    lifecycle = DeviceLifecycle(
      credentials: KeychainCredentials(service: "\(Bundle.main.bundleIdentifier ?? "build.bent.fitness").sync"),
      states: states, origin: origin,
      deviceName: { await MainActor.run { UIDevice.current.name } },
      makeAPI: { url in
        // Revocations for keys from another origin use their own origin.
        let transport = FitnessAPI.sameOrigin(url, pinned) ? transport : PinnedTransport(origin: url)
        return try? FitnessAPI(origin: url, transport: transport)
      })
    let lifecycle = self.lifecycle
    let source = self.source
    let api = try? FitnessAPI(origin: origin, transport: transport)
    coordinator = SyncCoordinator(
      session: { await lifecycle.session() },
      background: UIKitBackgroundTime(),
      makeEngine: { session in
        guard let api, let storage = await lifecycle.storage() else { return nil }
        return SyncEngine(
          source: source, api: api, storage: storage, check: LifecycleCheck(lifecycle: lifecycle), session: session)
      },
      onResult: { [weak self] result in await self?.finished(result) })
  }

  struct LifecycleCheck: SessionCheck {
    let lifecycle: DeviceLifecycle
    func isCurrent(_ session: SyncSession) async -> Bool { await lifecycle.isCurrent(session) }
  }

  // MARK: Launch and triggers

  /// At launch: observers are registered whatever the state, so a wake from
  /// HealthKit always reaches the coordinator, which checks for a session.
  /// Keychain, file and network work waits for protected data.
  func launched() {
    registerObservers()
    guard UIApplication.shared.isProtectedDataAvailable else { return }
    Task { await self.resume() }
  }

  /// Protected data became available, or the app came to the foreground.
  func resume(foreground: Bool = false) async {
    try? await lifecycle.resumeCleanup()
    await lifecycle.revokePending()
    guard await lifecycle.session() != nil else { return }
    registerObservers()
    await enableBackgroundDelivery()
    let retry = await coordinator.retryPending
    if foreground || retry {
      await coordinator.trigger(mode: foreground ? .foreground : .background)
    }
  }

  func registerObservers() {
    lock.lock()
    defer { lock.unlock() }
    guard observers.isEmpty, HKHealthStore.isHealthDataAvailable() else { return }
    for type in [HealthKitSource.bodyMass, HealthKitSource.workouts] as [HKSampleType] {
      let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
        guard let self, error == nil else {
          completion()
          return
        }
        let done: @Sendable () -> Void = { completion() }
        Task { await self.coordinator.trigger(mode: .background, completion: done) }
      }
      health.execute(query)
      observers.append(query)
    }
  }

  func enableBackgroundDelivery() async {
    for type in [HealthKitSource.bodyMass, HealthKitSource.workouts] as [HKObjectType] {
      do {
        try await health.enableBackgroundDelivery(for: type, frequency: .immediate)
      } catch {
        log.error("background_delivery_failed code=\((error as NSError).code, privacy: .public)")
      }
    }
  }

  func stopObservers() async {
    let current: [HKObserverQuery] = {
      lock.lock()
      defer { lock.unlock() }
      let current = observers
      observers = []
      return current
    }()
    current.forEach(health.stop)
    try? await health.disableAllBackgroundDelivery()
  }

  // MARK: Results

  private func finished(_ result: RunResult) async {
    switch result {
    case let .finished(summary):
      log.info("sync_finished samples=\(summary.counts.values.reduce(0, +), privacy: .public)")
    case let .stopped(stop):
      log.info("sync_stopped code=\(String(describing: stop), privacy: .public)")
      if stop == .keyInvalid, let session = await lifecycle.session() {
        try? await lifecycle.markInvalid(session)
        await stopObservers()
      }
    case let .failed(name):
      log.error("sync_failed error=\(name, privacy: .public)")
    case .idle:
      break
    }
    onResult?(await status())
  }

  // MARK: Actions

  /// Asks for read access, then registers fresh observers and background
  /// delivery, since ones registered before access was answered can stop.
  func requestHealthAccess() async throws {
    try await health.requestAuthorization(toShare: [], read: HealthKitSource.readTypes)
    await stopObservers()
    registerObservers()
    await enableBackgroundDelivery()
  }

  func confirm(cutoff: Date) async throws {
    _ = try await lifecycle.confirm(cutoff: cutoff)
    registerObservers()
  }

  func syncNow() async {
    await coordinator.trigger(mode: .foreground, force: true)
  }

  func disconnect() async throws -> Int {
    await coordinator.stop()
    await stopObservers()
    return try await lifecycle.disconnect()
  }

  /// The earliest readable weigh-in and run since the cutoff, so the app can
  /// show what history Health shares with it.
  func readableHistory() async -> [String: Any] {
    guard let storage = await lifecycle.storage(), let state = try? storage.load() else { return [:] }
    var result: [String: Any] = ["cutoff": state.cutoff.timeIntervalSince1970 * 1000]
    for kind in SampleKind.allCases {
      do {
        let earliest = try await source.earliest(kind, since: state.cutoff)
        result[kind.rawValue] = earliest.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull()
      } catch {
        result[kind.rawValue] = NSNull()
        result["error"] = "health_query_failed"
      }
    }
    return result
  }

  // MARK: Status

  func status() async -> [String: Any] {
    let document = (try? await lifecycle.document()) ?? CredentialDocument()
    var status: [String: Any] = [
      "healthAvailable": HKHealthStore.isHealthDataAvailable(),
      "origin": origin.absoluteString,
      "pendingRevocations": document.pending.count,
      "retryPending": await coordinator.retryPending,
    ]
    guard let active = document.active else {
      status["state"] = "signedOut"
      return status
    }
    status["state"] = active.state.rawValue
    status["email"] = active.email
    status["accountTimezone"] = active.accountTimezone
    guard active.state == .active, let state = try? await lifecycle.storage()?.load() else { return status }
    var totals: [String: Int] = [:]
    for run in state.history {
      for (code, count) in run.counts { totals[code, default: 0] += count }
    }
    status["accountTimezone"] = state.accountTimezone
    status["cutoff"] = state.cutoff.timeIntervalSince1970 * 1000
    status["earliestCutoff"] = state.earliestCutoff.timeIntervalSince1970 * 1000
    status["lastSyncAt"] = state.lastSyncAt.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull()
    status["lastError"] = state.lastError ?? NSNull()
    status["counts"] = totals
    status["runsWithoutDistance"] = state.runsWithoutDistance
    status["deferred"] = state.deferred.count
    status["unreadableRetired"] = state.unreadableRetired
    status["paused"] = Dictionary(uniqueKeysWithValues: state.paused.map { ($0.key.rawValue, $0.value) })
    status["backfilling"] = !state.incrementalEnabled
    status["backfillStarted"] = state.backfill != nil || state.anchors != nil
    status["backfillThrough"] = state.backfill?.through ?? NSNull()
    return status
  }
}
