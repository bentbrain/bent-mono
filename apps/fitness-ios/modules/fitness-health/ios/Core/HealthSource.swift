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
  /// What Health says about the dates the app can read walking and running
  /// distance for. Health does not say whether read access was denied, so a
  /// run's missing distance is ambiguous unless this covers its start.
  func distanceAccess() async throws -> DistanceAccess
}

/// What Health answered when asked for the earliest date it lets the app
/// read walking and running distance from (iOS 27 and later).
public enum DistanceStartAnswer: Sendable, Equatable {
  /// The lookup does not exist: before iOS 27, or in a build made with an
  /// SDK that does not have it.
  case unavailable
  /// The lookup failed.
  case failed
  /// Health answered with this date, or left distance out of its answer.
  case answered(Date?)
}

/// The dates the app is known to be able to read distance for. A run with
/// no distance is taken to have none only when its start is covered; a
/// readable sample from another time proves nothing about it.
public struct DistanceAccess: Sendable, Equatable {
  /// The earliest date Health is known to let the app read distance from,
  /// or nil when that is not known.
  public var readableFrom: Date?

  public init(readableFrom: Date?) { self.readableFrom = readableFrom }

  /// Coverage from Health's answer. Only a reported date counts; an
  /// unavailable or failed lookup, or an answer without distance, leaves
  /// coverage unknown.
  public init(_ answer: DistanceStartAnswer) {
    if case let .answered(date) = answer {
      readableFrom = date
    } else {
      readableFrom = nil
    }
  }

  /// Whether the app is known to read distance for a run that started at `start`.
  public func covers(_ start: Date) -> Bool {
    guard let readableFrom else { return false }
    return readableFrom <= start
  }
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
