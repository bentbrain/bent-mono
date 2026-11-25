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
  private let marker: SyncMarker
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
    marker = SyncMarker(directory: states.root.deletingLastPathComponent())
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
      // Throws while the Keychain is locked, which marks a retry.
      session: { try await lifecycle.currentSession() },
      background: UIKitBackgroundTime(),
      makeEngine: { session in
        guard let api, let storage = await lifecycle.storage() else { return nil }
        return SyncEngine(
          source: source, api: api, storage: storage, check: LifecycleCheck(lifecycle: lifecycle), session: session)
      },
      onResult: { [weak self] result, session in await self?.finished(result, session: session) })
  }

  struct LifecycleCheck: SessionCheck {
    let lifecycle: DeviceLifecycle
    func isCurrent(_ session: SyncSession) async -> Bool { await lifecycle.isCurrent(session) }
    func commit(_ session: SyncSession, _ write: @Sendable () throws -> Bool) async throws -> Bool {
      try await lifecycle.commit(session, write)
    }
  }

  // MARK: Launch and triggers

  /// At launch: observers are registered when sync is on, as the marker
  /// file records, so a wake from HealthKit reaches the coordinator even
  /// before the first unlock. Keychain, file and network work waits for
  /// protected data. Nothing registers while consent is pending.
  func launched() {
    if marker.isOn { registerObservers() }
    guard UIApplication.shared.isProtectedDataAvailable else { return }
    Task { await self.resume() }
  }

  /// Protected data became available, or the app came to the foreground.
  func resume(foreground: Bool = false) async {
    try? await lifecycle.resumeCleanup()
    await lifecycle.revokePending()
    let session: SyncSession?
    do {
      session = try await lifecycle.currentSession()
    } catch {
      // Locked: keep everything and try again after the unlock.
      return
    }
    guard session != nil else {
      marker.turnOff()
      return
    }
    marker.turnOn()
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

  /// Logs an enrollment's outcome by kind and code only.
  func logEnrollment(_ outcome: [String: Any]) {
    let kind = outcome["kind"] as? String ?? "unknown"
    let detail = (outcome["code"] as? String) ?? (outcome["action"] as? String) ?? ""
    log.info("enroll_outcome kind=\(kind, privacy: .public) code=\(detail, privacy: .public)")
  }

  // MARK: Results

  /// After a run. A `401 key_invalid` clears the key the run used only if it
  /// is still the stored key, and only then does delivery stop.
  private func finished(_ result: RunResult, session: SyncSession?) async {
    switch result {
    case let .finished(summary):
      log.info("sync_finished samples=\(summary.counts.values.reduce(0, +), privacy: .public)")
    case let .stopped(stop):
      log.info("sync_stopped code=\(String(describing: stop), privacy: .public)")
    case let .failed(name):
      log.error("sync_failed error=\(name, privacy: .public)")
    case .idle:
      break
    }
    if await RunOutcomePolicy.apply(result, session: session, lifecycle: lifecycle) {
      marker.turnOff()
      await stopObservers()
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

  func confirm(cutoff: Date, enrollmentId: String) async throws {
    _ = try await lifecycle.confirm(cutoff: cutoff, enrollmentId: enrollmentId)
    marker.turnOn()
    registerObservers()
  }

  func decline(enrollmentId: String) async throws -> Int {
    try await lifecycle.decline(enrollmentId: enrollmentId)
  }

  /// The Health step is done: the first sync starts.
  func startFirstSync() async throws {
    try await lifecycle.startFirstSync()
    await coordinator.trigger(mode: .foreground, force: true)
  }

  func syncNow() async {
    await coordinator.trigger(mode: .foreground, force: true)
  }

  /// Disconnects: the key stops being used and the sync state is cleared
  /// first, then the run and observers stop, then the key is revoked.
  func disconnect() async throws -> Int {
    try await lifecycle.deactivate()
    marker.turnOff()
    await coordinator.stop()
    await stopObservers()
    return await lifecycle.revokePending()
  }

  /// The earliest readable weigh-in and run since the cutoff, and, where
  /// Health reports a limited history window, the earliest date it allows.
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
    let windows = await source.limitedHistoryStarts()
    for (kind, start) in windows {
      result["\(kind.rawValue)AllowedFrom"] = start.timeIntervalSince1970 * 1000
    }
    return result
  }

  // MARK: Status

  func status() async -> [String: Any] {
    var status: [String: Any] = [
      "healthAvailable": HKHealthStore.isHealthDataAvailable(),
      "origin": origin.absoluteString,
      "retryPending": await coordinator.retryPending,
    ]
    let document: CredentialDocument
    do {
      document = try await lifecycle.document()
    } catch {
      // The Keychain is locked until the first unlock.
      status["state"] = "locked"
      status["pendingRevocations"] = 0
      return status
    }
    status["pendingRevocations"] = document.pending.count
    status["manualRevocations"] = document.manualRevocations
    guard let active = document.active else {
      status["state"] = document.keyInvalid ? "invalid" : "signedOut"
      return status
    }
    status["state"] = active.state.rawValue
    status["email"] = active.email
    status["accountTimezone"] = active.accountTimezone
    // Consent and the status screen's choices name the enrollment shown.
    status["enrollmentId"] = active.enrollmentId
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
    // The runs the status screen offers to send without a distance; its
    // choice names exactly these.
    let waiting = state.runsAwaitingDistanceAccess
    status["runsAwaitingDistanceAccess"] = waiting.count
    status["distanceWaitingRuns"] = waiting
    status["unreadableRetired"] = state.unreadableRetired
    status["paused"] = Dictionary(uniqueKeysWithValues: state.paused.map { ($0.key.rawValue, $0.value) })
    status["awaitingHealthStep"] = state.awaitingHealthStep
    status["backfilling"] = !state.incrementalEnabled
    status["backfillStarted"] = state.backfill != nil || state.anchors != nil
    status["backfillThrough"] = state.backfill?.through ?? NSNull()
    return status
  }
}

/// A file that records whether sync is on, readable before the first
/// unlock so launch can register observers. It holds no Health data or key.
final class SyncMarker: @unchecked Sendable {
  private let file: URL

  init(directory: URL) { file = directory.appendingPathComponent("sync-enabled") }

  var isOn: Bool { FileManager.default.fileExists(atPath: file.path) }

  func turnOn() {
    guard !isOn else { return }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? Data().write(to: file, options: [.atomic, .noFileProtection])
  }

  func turnOff() {
    try? FileManager.default.removeItem(at: file)
  }
}
