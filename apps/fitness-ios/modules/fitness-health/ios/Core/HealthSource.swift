import Foundation

/// One page of an anchored query: samples added since the anchor, UUIDs
/// deleted since it, and the anchor to resume from.
public struct AnchoredPage: Sendable {
  public var samples: [HealthSample]
  public var deleted: [UUID]
  public var anchor: Data
  /// Whether the page was full, so another may follow.
  public var more: Bool

  public init(samples: [HealthSample], deleted: [UUID], anchor: Data, more: Bool) {
    self.samples = samples
    self.deleted = deleted
    self.anchor = anchor
    self.more = more
  }
}

/// Health data as the sync engine reads it. The HealthKit implementation is
/// in the platform layer; tests use a fake.
public protocol HealthSource: Sendable {
  /// Samples of a type starting at or after `cutoff`, added after `anchor`,
  /// up to `limit` of them. A nil anchor starts from the beginning.
  func page(_ kind: SampleKind, cutoff: Date, anchor: Data?, limit: Int) async throws -> AnchoredPage
  /// Samples of a type starting in `[start, end)`, sorted by start.
  func samples(_ kind: SampleKind, start: Date, end: Date) async throws -> [HealthSample]
  /// The readable samples among these UUIDs.
  func samples(_ kind: SampleKind, ids: [UUID]) async throws -> [HealthSample]
  /// Whether Health shows the app any walking and running distance. Health
  /// does not say whether read access was denied, so without any readable
  /// distance a run's missing distance is ambiguous.
  func distanceReadable() async throws -> Bool
}

/// Errors that mean the device is locked and Health data is unavailable.
public enum HealthAccessError: Error, Equatable {
  case protectedDataUnavailable
}

public enum Distance {
  /// A run's distance from, in order: the workout's distance statistics; the
  /// sum of distance samples associated with it; its total distance. A zero
  /// counts as absent. When a lookup fails, the distance is unknown, so a
  /// transient failure never becomes a 0 km run.
  public static func resolve(
    statistics: Double?,
    associated: () async throws -> Double?,
    total: Double?
  ) async -> RunDistance {
    if let statistics, statistics > 0 { return .km(statistics) }
    do {
      if let sum = try await associated(), sum > 0 { return .km(sum) }
    } catch {
      return .unknown
    }
    if let total, total > 0 { return .km(total) }
    return .none
  }
}
