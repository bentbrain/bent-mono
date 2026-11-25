import Foundation

/// The two kinds of Health sample the app sends.
public enum SampleKind: String, Codable, CodingKeyRepresentable, Sendable, CaseIterable {
  case weight
  case run

  /// The ref prefix Fitness expects: `w:` for weigh-ins and `r:` for runs.
  public var refPrefix: String { self == .weight ? "w" : "r" }
}

/// What the app knows about a run's distance.
public enum RunDistance: Codable, Sendable, Equatable {
  /// A distance in kilometres.
  case km(Double)
  /// Health was checked and has no distance for the run.
  case none
  /// Health could not be checked, so the distance is not known yet.
  case unknown
}

/// One Health sample, as the sync engine handles it.
public enum HealthSample: Sendable, Equatable {
  case weight(id: UUID, date: Date, kg: Double)
  case run(id: UUID, start: Date, end: Date, seconds: Double, distance: RunDistance)

  public var id: UUID {
    switch self {
    case let .weight(id, _, _): id
    case let .run(id, _, _, _, _): id
    }
  }

  public var kind: SampleKind {
    if case .weight = self { return .weight }
    return .run
  }

  /// The instant Fitness dates the sample by.
  public var start: Date {
    switch self {
    case let .weight(_, date, _): date
    case let .run(_, start, _, _, _): start
    }
  }

  public var ref: String { Refs.make(kind, id) }
}

public enum Refs {
  /// `w:<uuid>` or `r:<uuid>`, in lower case.
  public static func make(_ kind: SampleKind, _ id: UUID) -> String {
    "\(kind.refPrefix):\(id.uuidString.lowercased())"
  }

  /// The canonical form of a ref, or nil when it is not one.
  public static func canonical(_ ref: String) -> String? {
    let parts = ref.split(separator: ":", maxSplits: 1)
    guard parts.count == 2, parts[0].count == 1, let id = UUID(uuidString: String(parts[1])) else { return nil }
    return "\(parts[0].lowercased()):\(id.uuidString.lowercased())"
  }
}

/// Timestamps as Fitness reads them: ISO 8601 with milliseconds and the
/// device's offset, such as `2026-11-20T06:10:00.000+10:00`.
public struct Timestamps: Sendable {
  public let timeZone: TimeZone

  public init(timeZone: TimeZone) { self.timeZone = timeZone }

  public func string(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = timeZone
    return formatter.string(from: date)
  }
}

// MARK: - Request

/// The body of a device sync request to `POST /api/health/import`.
public struct ImportRequest: Encodable, Sendable, Equatable {
  public struct WeightPoint: Encodable, Sendable, Equatable {
    public let ref: String
    public let date: String
    public let qty: Double
  }

  public struct Metric: Encodable, Sendable, Equatable {
    public let name: String
    public let units: String
    public let data: [WeightPoint]
  }

  public struct Quantity: Encodable, Sendable, Equatable {
    public let qty: Double
    public let units: String
  }

  public struct Workout: Encodable, Sendable, Equatable {
    public let ref: String
    public let name: String
    public let start: String
    public let end: String
    public let duration: Double
    public let distance: Quantity?

    private enum CodingKeys: String, CodingKey { case ref, name, start, end, duration, distance }

    public func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(ref, forKey: .ref)
      try container.encode(name, forKey: .name)
      try container.encode(start, forKey: .start)
      try container.encode(end, forKey: .end)
      try container.encode(duration, forKey: .duration)
      // A run without a distance leaves the key out.
      try container.encodeIfPresent(distance, forKey: .distance)
    }
  }

  public struct Payload: Encodable, Sendable, Equatable {
    public let metrics: [Metric]
    public let workouts: [Workout]
  }

  public let data: Payload
  public let expectedTimezone: String?

  /// The samples this request sends, in request order.
  public let submitted: [Submitted]

  public struct Submitted: Sendable, Equatable, Hashable {
    public let ref: String
    public let kind: SampleKind
  }

  private enum CodingKeys: String, CodingKey { case data, expectedTimezone }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(data, forKey: .data)
    try container.encodeIfPresent(expectedTimezone, forKey: .expectedTimezone)
  }

  /// Builds a request from samples in the order given. Weigh-ins are sent in
  /// kg, runs as `Running` with their duration in seconds and any distance in
  /// km. A run whose distance is unknown cannot be sent.
  public init(samples: [HealthSample], timestamps: Timestamps, expectedTimezone: String?) throws {
    var points: [WeightPoint] = []
    var workouts: [Workout] = []
    var submitted: [Submitted] = []
    for sample in samples {
      switch sample {
      case let .weight(id, date, kg):
        points.append(WeightPoint(ref: Refs.make(.weight, id), date: timestamps.string(date), qty: kg))
      case let .run(id, start, end, seconds, distance):
        let quantity: Quantity?
        switch distance {
        case let .km(km): quantity = Quantity(qty: km, units: "km")
        case .none: quantity = nil
        case .unknown: throw WireError.unknownDistance
        }
        workouts.append(
          Workout(
            ref: Refs.make(.run, id), name: "Running", start: timestamps.string(start),
            end: timestamps.string(end), duration: seconds, distance: quantity))
      }
      submitted.append(Submitted(ref: sample.ref, kind: sample.kind))
    }
    data = Payload(
      metrics: points.isEmpty ? [] : [Metric(name: "weight_body_mass", units: "kg", data: points)],
      workouts: workouts)
    self.expectedTimezone = expectedTimezone
    self.submitted = submitted
  }

  public func encoded() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(self)
  }
}

public enum WireError: Error, Equatable {
  case unknownDistance
  case malformedReply(String)
}

// MARK: - Replies

public enum OutcomeResult: String, Codable, Sendable { case added, kept, skipped }

public enum OutcomeCode: String, Codable, Sendable, CaseIterable {
  case new
  case alreadyImported = "already_imported"
  case matchedExisting = "matched_existing"
  case removedInFitness = "removed_in_fitness"
  case dateHasWeighin = "date_has_weighin"
  case duplicateInRequest = "duplicate_in_request"
  case future
  case outOfRange = "out_of_range"

  /// The result each code belongs to.
  public var result: OutcomeResult {
    switch self {
    case .new: .added
    case .future, .outOfRange: .skipped
    default: .kept
    }
  }
}

public struct DeviceOutcome: Codable, Sendable, Equatable {
  public let ref: String
  public let type: SampleKind
  public let result: OutcomeResult
  public let code: OutcomeCode
}

/// The reply to a device sync request.
public struct DeviceReply: Codable, Sendable, Equatable {
  public let kind: String
  public let accountTimezone: String
  public let outcomes: [DeviceOutcome]

  /// Decodes a reply and checks it: the device kind, each code with its
  /// result, and exactly one outcome per submitted (ref, type).
  public static func accept(_ data: Data, for submitted: [ImportRequest.Submitted]) throws -> DeviceReply {
    let reply: DeviceReply
    do {
      reply = try JSONDecoder().decode(DeviceReply.self, from: data)
    } catch {
      throw WireError.malformedReply("The reply is not a device reply.")
    }
    guard reply.kind == "device" else { throw WireError.malformedReply("The reply is not a device reply.") }
    for outcome in reply.outcomes where outcome.code.result != outcome.result {
      throw WireError.malformedReply("An outcome pairs \(outcome.result.rawValue) with \(outcome.code.rawValue).")
    }
    try checkBijection(submitted: submitted, outcomes: reply.outcomes)
    return reply
  }

  static func checkBijection(submitted: [ImportRequest.Submitted], outcomes: [DeviceOutcome]) throws {
    func key(_ ref: String, _ kind: SampleKind) -> String { "\(kind.rawValue) \(Refs.canonical(ref) ?? ref)" }
    var expected = Set<String>()
    for entry in submitted where !expected.insert(key(entry.ref, entry.kind)).inserted {
      throw WireError.malformedReply("A ref was submitted twice.")
    }
    guard outcomes.count == submitted.count else {
      throw WireError.malformedReply("The reply has \(outcomes.count) outcomes for \(submitted.count) refs.")
    }
    for outcome in outcomes where expected.remove(key(outcome.ref, outcome.type)) == nil {
      throw WireError.malformedReply("An outcome has no matching ref.")
    }
    if !expected.isEmpty { throw WireError.malformedReply("A ref has no outcome.") }
  }
}

/// An error reply. `error` is safe to show; `code` is stable.
public struct ApiError: Codable, Sendable, Equatable {
  public let error: String
  public let code: String?
  public let accountTimezone: String?
}

/// The reply to `POST /api/health/devices`.
public struct EnrollResponse: Codable, Sendable, Equatable {
  public let secret: String
  public let accountTimezone: String
  public let userId: String
  public let email: String
}
