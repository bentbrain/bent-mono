import Foundation
import HealthKit

/// Reads weigh-ins and running workouts from HealthKit.
final class HealthKitSource: HealthSource, @unchecked Sendable {
  let store: HKHealthStore

  static let bodyMass = HKQuantityType(.bodyMass)
  static let distance = HKQuantityType(.distanceWalkingRunning)
  static let workouts = HKObjectType.workoutType()
  /// The types the app reads. It never writes to Health.
  static let readTypes: Set<HKObjectType> = [bodyMass, workouts, distance]

  init(store: HKHealthStore) { self.store = store }

  private struct AnchoredResult: @unchecked Sendable {
    let samples: [HKSample]
    let deleted: [HKDeletedObject]
    let next: HKQueryAnchor?
  }

  static func type(_ kind: SampleKind) -> HKSampleType {
    kind == .weight ? bodyMass : workouts
  }

  private static func predicate(_ kind: SampleKind, start: Date, end: Date?) -> NSPredicate {
    let dates = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    guard kind == .run else { return dates }
    return NSCompoundPredicate(andPredicateWithSubpredicates: [dates, HKQuery.predicateForWorkouts(with: .running)])
  }

  /// Maps HealthKit's locked-database error so runs wait for an unlock.
  static func mapped(_ error: Error) -> Error {
    if let error = error as? HKError, error.code == .errorDatabaseInaccessible {
      return HealthAccessError.protectedDataUnavailable
    }
    return error
  }

  func page(_ kind: SampleKind, cutoff: Date, anchor: Data?, limit: Int) async throws -> AnchoredPage {
    let start = try anchor.flatMap {
      try NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0)
    }
    let result: AnchoredResult = try await withCheckedThrowingContinuation { continuation in
      let query = HKAnchoredObjectQuery(
        type: Self.type(kind), predicate: Self.predicate(kind, start: cutoff, end: nil), anchor: start,
        limit: limit
      ) { _, samples, deleted, next, error in
        if let error {
          continuation.resume(throwing: Self.mapped(error))
        } else {
          continuation.resume(returning: AnchoredResult(samples: samples ?? [], deleted: deleted ?? [], next: next))
        }
      }
      store.execute(query)
    }
    guard let next = result.next else { throw HealthAccessError.protectedDataUnavailable }
    let data = try NSKeyedArchiver.archivedData(withRootObject: next, requiringSecureCoding: true)
    return AnchoredPage(
      samples: try await convert(result.samples), deleted: result.deleted.map(\.uuid), anchor: data,
      more: result.samples.count + result.deleted.count >= limit)
  }

  func samples(_ kind: SampleKind, start: Date, end: Date) async throws -> [HealthSample] {
    try await convert(query(Self.type(kind), Self.predicate(kind, start: start, end: end)))
  }

  func samples(_ kind: SampleKind, ids: [UUID]) async throws -> [HealthSample] {
    guard !ids.isEmpty else { return [] }
    return try await convert(query(Self.type(kind), HKQuery.predicateForObjects(with: Set(ids))))
  }

  /// Whether any walking and running distance is readable. Health hides
  /// whether read access was denied, so none readable is ambiguous.
  func distanceReadable() async throws -> Bool {
    !(try await query(Self.distance, HKQuery.predicateForSamples(withStart: nil, end: nil), limit: 1)).isEmpty
  }

  /// The earliest date Health lets the app read, per type, when the user
  /// shared limited history. Empty where Health reports no such window.
  func limitedHistoryStarts() async -> [SampleKind: Date] {
    #if compiler(>=6.4)
      if #available(iOS 27.0, *) {
        let types: Set<HKObjectType> = [Self.bodyMass, Self.workouts]
        let dates: [HKObjectType: Date]? = await withCheckedContinuation { continuation in
          store.getEarliestAuthorizedSampleDate(for: types) { dates, _ in continuation.resume(returning: dates) }
        }
        var result: [SampleKind: Date] = [:]
        if let weight = dates?[Self.bodyMass] { result[.weight] = weight }
        if let runs = dates?[Self.workouts] { result[.run] = runs }
        return result
      }
    #endif
    return [:]
  }

  /// The earliest readable sample of a type since `start`, if any.
  func earliest(_ kind: SampleKind, since start: Date) async throws -> Date? {
    try await query(Self.type(kind), Self.predicate(kind, start: start, end: nil), limit: 1).first?.startDate
  }

  private func query(_ type: HKSampleType, _ predicate: NSPredicate, limit: Int = HKObjectQueryNoLimit)
    async throws -> [HKSample]
  {
    try await withCheckedThrowingContinuation { continuation in
      let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
      let query = HKSampleQuery(
        sampleType: type, predicate: predicate, limit: limit, sortDescriptors: [sort]
      ) { _, samples, error in
        if let error {
          continuation.resume(throwing: Self.mapped(error))
        } else {
          continuation.resume(returning: samples ?? [])
        }
      }
      store.execute(query)
    }
  }

  private func convert(_ samples: [HKSample]) async throws -> [HealthSample] {
    var converted: [HealthSample] = []
    for sample in samples {
      if let quantity = sample as? HKQuantitySample, quantity.quantityType == Self.bodyMass {
        converted.append(
          .weight(
            id: quantity.uuid, date: quantity.startDate,
            kg: quantity.quantity.doubleValue(for: .gramUnit(with: .kilo))))
      } else if let workout = sample as? HKWorkout, workout.workoutActivityType == .running {
        converted.append(
          .run(
            id: workout.uuid, start: workout.startDate, end: workout.endDate,
            seconds: workout.duration, distance: await distance(of: workout)))
      }
    }
    return converted
  }

  /// The workout's distance statistics, then its associated distance
  /// samples, then its total distance.
  private func distance(of workout: HKWorkout) async -> RunDistance {
    let km = HKUnit.meterUnit(with: .kilo)
    return await Distance.resolve(
      statistics: workout.statistics(for: Self.distance)?.sumQuantity()?.doubleValue(for: km),
      associated: { [self] in
        let samples = try await query(Self.distance, HKQuery.predicateForObjects(from: workout))
        let total = samples.compactMap { ($0 as? HKQuantitySample)?.quantity.doubleValue(for: km) }.reduce(0, +)
        return samples.isEmpty ? nil : total
      },
      total: legacyTotal(workout))
  }

  /// Older workouts record their distance only in `totalDistance`.
  @available(iOS, deprecated: 18.0)
  private func legacyTotal(_ workout: HKWorkout) -> Double? {
    workout.totalDistance?.doubleValue(for: .meterUnit(with: .kilo))
  }
}
