import Foundation
import HealthKit

/// Writes the synthetic Simulator sample set. Every sample carries a sync
/// identifier, so seeding again replaces the earlier copies.
struct Seeder: Sendable {
  enum SeedError: LocalizedError {
    case unavailable
    case denied

    var errorDescription: String? {
      switch self {
      case .unavailable: "Health data is unavailable on this device."
      case .denied: "Allow Health Seed to write weight, workouts and distance."
      }
    }
  }

  private struct WeighIn {
    let id: String
    let date: Date
    let kg: Double
  }

  private let store = HKHealthStore()
  private let bodyMass = HKQuantityType(.bodyMass)
  private let distance = HKQuantityType(.distanceWalkingRunning)
  private let workout = HKObjectType.workoutType()

  private var types: Set<HKSampleType> { [bodyMass, distance, workout] }

  private func authorize() async throws {
    guard HKHealthStore.isHealthDataAvailable() else { throw SeedError.unavailable }
    try await store.requestAuthorization(toShare: types, read: [])
    for type in types where store.authorizationStatus(for: type) != .sharingAuthorized {
      throw SeedError.denied
    }
  }

  /// Writes the sample set around `now` and returns how many samples it wrote.
  func seed(now: Date) async throws -> Int {
    try await authorize()
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: now)
    func at(_ days: Int, _ hour: Int, _ minute: Int = 0) -> Date {
      let day = calendar.date(byAdding: .day, value: days, to: today) ?? today
      return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    var count = 0
    let weighIns = [
      WeighIn(id: "weight.1", date: at(-3, 6, 10), kg: 80.4),
      WeighIn(id: "weight.2", date: at(-3, 18, 0), kg: 81.0),
      WeighIn(id: "weight.3", date: at(-2, 6, 5), kg: 80.1),
      WeighIn(id: "weight.4", date: at(-1, 6, 0), kg: 79.9),
      WeighIn(id: "weight.future", date: at(2, 6, 0), kg: 79.5),
    ]
    let samples = weighIns.map { weighIn in
      HKQuantitySample(
        type: bodyMass,
        quantity: HKQuantity(unit: .gramUnit(with: .kilo), doubleValue: weighIn.kg),
        start: weighIn.date,
        end: weighIn.date,
        metadata: syncMetadata(weighIn.id)
      )
    }
    try await store.save(samples)
    count += samples.count

    count += try await saveRun("run.outdoor", start: at(-3, 7), minutes: 30, km: 5.0, indoor: false)
    count += try await saveRun("run.treadmill", start: at(-2, 7), minutes: 25, km: 4.2, indoor: true)
    count += try await saveRun("run.nodistance", start: at(-1, 7), minutes: 20, km: nil, indoor: false)
    count += try await saveLateDistanceRun(start: at(-1, 18), minutes: 22, km: 3.1)
    return count
  }

  /// Removes every sample this app wrote.
  func clear() async throws {
    try await authorize()
    let mine = HKQuery.predicateForObjects(from: HKSource.default())
    for type in types {
      _ = try await store.deleteObjects(of: type, predicate: mine)
    }
  }

  private func syncMetadata(_ id: String) -> [String: Any] {
    [HKMetadataKeySyncIdentifier: "healthseed.\(id)", HKMetadataKeySyncVersion: 1]
  }

  private func distanceSample(km: Double, start: Date, end: Date, id: String) -> HKQuantitySample {
    HKQuantitySample(
      type: distance,
      quantity: HKQuantity(unit: .meterUnit(with: .kilo), doubleValue: km),
      start: start,
      end: end,
      metadata: syncMetadata(id)
    )
  }

  /// A run recorded with HKWorkoutBuilder, with its distance samples if any.
  private func saveRun(_ id: String, start: Date, minutes: Double, km: Double?, indoor: Bool)
    async throws -> Int
  {
    let configuration = HKWorkoutConfiguration()
    configuration.activityType = .running
    configuration.locationType = indoor ? .indoor : .outdoor
    let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: nil)
    let end = start.addingTimeInterval(minutes * 60)
    try await builder.beginCollection(at: start)
    var count = 1
    if let km {
      let half = start.addingTimeInterval(minutes * 30)
      try await builder.addSamples([
        distanceSample(km: km / 2, start: start, end: half, id: "\(id).distance.1"),
        distanceSample(km: km / 2, start: half, end: end, id: "\(id).distance.2"),
      ])
      count += 2
    }
    var metadata = syncMetadata(id)
    metadata[HKMetadataKeyIndoorWorkout] = indoor
    try await builder.addMetadata(metadata)
    try await builder.endCollection(at: end)
    _ = try await builder.finishWorkout()
    return count
  }

  /// A run saved without distance, with a distance sample attached afterwards,
  /// as some sources do once they finish processing.
  private func saveLateDistanceRun(start: Date, minutes: Double, km: Double) async throws -> Int {
    let id = "run.latedistance"
    let configuration = HKWorkoutConfiguration()
    configuration.activityType = .running
    configuration.locationType = .outdoor
    let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: nil)
    let end = start.addingTimeInterval(minutes * 60)
    try await builder.beginCollection(at: start)
    try await builder.addMetadata(syncMetadata(id))
    try await builder.endCollection(at: end)
    guard let saved = try await builder.finishWorkout() else { return 0 }
    let late = distanceSample(km: km, start: start, end: end, id: "\(id).distance")
    try await store.save(late)
    try await attach([late], to: saved)
    return 2
  }

  private func attach(_ samples: [HKSample], to workout: HKWorkout) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      store.add(samples, to: workout) { _, error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
    }
  }
}
