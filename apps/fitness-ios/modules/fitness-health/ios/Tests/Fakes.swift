import Foundation
@testable import FitnessHealthCore

/// A lock-protected box for test fakes shared across tasks.
final class Locked<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value
  init(_ value: Value) { self.value = value }
  func with<T>(_ body: (inout Value) throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body(&value)
  }
  var get: Value { with { $0 } }
}

/// HealthKit in memory. Every added or deleted sample gets the next
/// sequence number, which anchors are made of.
final class FakeHealth: HealthSource, @unchecked Sendable {
  struct Entry {
    var sample: HealthSample
    var sequence: Int
  }
  struct Deletion {
    var id: UUID
    var kind: SampleKind
    var sequence: Int
  }
  private struct Store {
    var entries: [Entry] = []
    var deletions: [Deletion] = []
    var sequence = 0
    var hidden: Set<UUID> = []
    var failures = 0
    var locked = false
    var lookupsFail = false
    var queries = 0
  }
  private let store = Locked(Store())

  func add(_ samples: HealthSample...) { add(samples) }
  func add(_ samples: [HealthSample]) {
    store.with { store in
      for sample in samples {
        store.sequence += 1
        store.entries.append(Entry(sample: sample, sequence: store.sequence))
      }
    }
  }
  func delete(_ id: UUID) {
    store.with { store in
      guard let index = store.entries.firstIndex(where: { $0.sample.id == id }) else { return }
      let kind = store.entries[index].sample.kind
      store.entries.remove(at: index)
      store.sequence += 1
      store.deletions.append(Deletion(id: id, kind: kind, sequence: store.sequence))
    }
  }
  /// Hides samples, as HealthKit does when read access is off.
  func hide(_ ids: Set<UUID>) { store.with { $0.hidden = ids } }
  func failNext(_ count: Int) { store.with { $0.failures = count } }
  func lock(_ locked: Bool) { store.with { $0.locked = locked } }
  func failLookups(_ fail: Bool) { store.with { $0.lookupsFail = fail } }
  var queries: Int { store.get.queries }

  private func begin() throws {
    try store.with { store in
      store.queries += 1
      if store.locked { throw HealthAccessError.protectedDataUnavailable }
      if store.failures > 0 {
        store.failures -= 1
        throw CocoaError(.featureUnsupported)
      }
    }
  }

  private static func number(_ anchor: Data?) -> Int {
    guard let anchor, let text = String(data: anchor, encoding: .utf8) else { return 0 }
    return Int(text) ?? 0
  }

  func page(_ kind: SampleKind, cutoff: Date, anchor: Data?, limit: Int) async throws -> AnchoredPage {
    try begin()
    return store.with { store in
      let after = Self.number(anchor)
      let added = store.entries
        .filter { $0.sample.kind == kind && $0.sequence > after && $0.sample.start >= cutoff }
        .filter { !store.hidden.contains($0.sample.id) }
        .sorted { $0.sequence < $1.sequence }
      let page = Array(added.prefix(limit))
      let full = added.count > limit
      let end = full ? (page.last?.sequence ?? after) : store.sequence
      let deleted = store.deletions.filter { $0.kind == kind && $0.sequence > after && $0.sequence <= end }
      return AnchoredPage(
        samples: page.map(\.sample), deleted: deleted.map(\.id), anchor: Data(String(end).utf8), more: full)
    }
  }

  func samples(_ kind: SampleKind, start: Date, end: Date) async throws -> [HealthSample] {
    try begin()
    return store.with { store in
      store.entries.map(\.sample)
        .filter { $0.kind == kind && $0.start >= start && $0.start < end && !store.hidden.contains($0.id) }
        .sorted { $0.start < $1.start }
    }
  }

  func samples(_ kind: SampleKind, ids: [UUID]) async throws -> [HealthSample] {
    try begin()
    if store.get.lookupsFail { throw CocoaError(.featureUnsupported) }
    let wanted = Set(ids)
    return store.with { store in
      store.entries.map(\.sample).filter { $0.kind == kind && wanted.contains($0.id) && !store.hidden.contains($0.id) }
    }
  }
}

/// Fitness's import route in memory: each ref is decided once, like the
/// ledger, and a backfill naming another timezone is refused.
final class FakeFitness: HTTPTransport, @unchecked Sendable {
  enum Script {
    /// Process the request normally.
    case pass
    /// Reply with this instead.
    case reply(HTTPReply)
    /// Process the request, then lose the reply.
    case loseReply
    /// Fail before the request reaches Fitness.
    case transport
  }
  struct Received {
    var refs: [String]
    var expectedTimezone: String?
    var body: [String: Any]
  }
  private struct State {
    var ledger: [String: OutcomeCode] = [:]
    var timezone = "Australia/Brisbane"
    var scripts: [Script] = []
    var received: [Received] = []
    var maxSamples = Int.max
    var today: String?
    var onRequest: (@Sendable (Int) -> Void)?
  }
  private let state = Locked(State())

  var timezone: String {
    get { state.get.timezone }
    set { state.with { $0.timezone = newValue } }
  }
  var received: [Received] { state.get.received }
  var sentRefs: [String] { received.flatMap(\.refs) }
  func script(_ scripts: Script...) { state.with { $0.scripts += scripts } }
  func limit(_ samples: Int) { state.with { $0.maxSamples = samples } }
  /// Fitness's "today" in the account timezone; later samples are `future`.
  func today(_ day: String?) { state.with { $0.today = day } }
  func onRequest(_ body: (@Sendable (Int) -> Void)?) { state.with { $0.onRequest = body } }

  func send(_ request: URLRequest) async -> HTTPReply? {
    let script: Script? = state.with { $0.scripts.isEmpty ? nil : $0.scripts.removeFirst() }
    if case .transport = script { return nil }
    if case let .reply(reply) = script { return reply }
    let reply = handle(request)
    let count = state.get.received.count
    state.get.onRequest?(count)
    if case .loseReply = script { return nil }
    return reply
  }

  private func handle(_ request: URLRequest) -> HTTPReply {
    guard request.url?.path == "/api/health/import",
      request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true,
      let body = request.httpBody,
      let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      let data = json["data"] as? [String: Any]
    else { return HTTPReply(status: 400, body: Data(#"{"error":"bad","code":"invalid_device_request"}"#.utf8)) }
    let metrics = (data["metrics"] as? [[String: Any]]) ?? []
    let points = metrics.flatMap { ($0["data"] as? [[String: Any]]) ?? [] }
    let workouts = (data["workouts"] as? [[String: Any]]) ?? []
    let expected = json["expectedTimezone"] as? String
    return state.with { state in
      let entries = points.map { ($0["ref"] as? String ?? "", SampleKind.weight, $0["date"] as? String ?? "") }
        + workouts.map { ($0["ref"] as? String ?? "", SampleKind.run, $0["start"] as? String ?? "") }
      state.received.append(Received(refs: entries.map(\.0), expectedTimezone: expected, body: json))
      if entries.count > state.maxSamples {
        return HTTPReply(
          status: 400, body: Data(#"{"error":"Too many","code":"too_many_samples"}"#.utf8))
      }
      if let expected, expected != state.timezone {
        return HTTPReply(
          status: 409,
          body: Data(
            #"{"error":"changed","code":"timezone_changed","accountTimezone":"\#(state.timezone)"}"#.utf8))
      }
      var outcomes: [[String: String]] = []
      for (ref, kind, date) in entries {
        let code: OutcomeCode
        if let today = state.today, date.prefix(10) > today {
          code = .future
        } else if state.ledger[ref] != nil {
          code = .alreadyImported
        } else {
          code = .new
          state.ledger[ref] = .new
        }
        outcomes.append(["ref": ref, "type": kind.rawValue, "result": code.result.rawValue, "code": code.rawValue])
      }
      let reply: [String: Any] = ["kind": "device", "accountTimezone": state.timezone, "outcomes": outcomes]
      return HTTPReply(status: 200, body: (try? JSONSerialization.data(withJSONObject: reply)) ?? Data())
    }
  }
}

struct AlwaysCurrent: SessionCheck {
  func isCurrent(_ session: SyncSession) async -> Bool { true }
}

final class SwitchableCheck: SessionCheck, @unchecked Sendable {
  let current = Locked(true)
  func isCurrent(_ session: SyncSession) async -> Bool { current.get }
}

final class FakeBackground: BackgroundTime, @unchecked Sendable {
  private let state = Locked((next: 0, open: Set<Int>(), expire: [Int: @Sendable () -> Void]()))
  func begin(expired: @escaping @Sendable () -> Void) async -> Int {
    state.with { state in
      state.next += 1
      state.open.insert(state.next)
      state.expire[state.next] = expired
      return state.next
    }
  }
  func end(_ id: Int) async { _ = state.with { $0.open.remove(id) } }
  var open: Set<Int> { state.get.open }
  /// Takes the time back, as iOS does when it runs out.
  func expireAll() {
    let handlers = state.with { state in
      let handlers = state.expire.filter { state.open.contains($0.key) }.map(\.value)
      state.open.removeAll()
      return handlers
    }
    handlers.forEach { $0() }
  }
}

/// A clock tests can move.
final class TestClock: @unchecked Sendable {
  let time: Locked<Date>
  init(_ date: Date) { time = Locked(date) }
  var now: Date { time.get }
  func advance(_ seconds: TimeInterval) { time.with { $0 = $0.addingTimeInterval(seconds) } }
}

enum Sample {
  static func id(_ n: Int) -> UUID {
    UUID(uuidString: String(format: "%08X-1111-4222-8333-444455556666", n))!
  }
  static func weight(_ n: Int, _ date: Date, kg: Double = 80) -> HealthSample {
    .weight(id: id(n), date: date, kg: kg)
  }
  static func run(_ n: Int, _ start: Date, minutes: Double = 30, km: RunDistance = .km(5)) -> HealthSample {
    .run(id: id(n), start: start, end: start.addingTimeInterval(minutes * 60), seconds: minutes * 60, distance: km)
  }
}

/// ISO 8601 dates for tests.
func date(_ text: String) -> Date {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter.date(from: text)!
}

struct Harness {
  let health = FakeHealth()
  let fitness = FakeFitness()
  let storage: MemoryStateStorage
  let clock: TestClock
  var check: SessionCheck = AlwaysCurrent()
  var deviceTimeZone = TimeZone(identifier: "Australia/Brisbane")!
  var limits = SyncLimits()

  init(now: Date, cutoff: Date, timezone: String = "Australia/Brisbane") {
    clock = TestClock(now)
    storage = MemoryStateStorage(SyncState(cutoff: cutoff, accountTimezone: timezone))
    fitness.timezone = timezone
  }

  func engine() throws -> SyncEngine {
    let clock = self.clock
    let api = try FitnessAPI(
      origin: URL(string: "https://fitness.example.test")!, transport: fitness, clock: { clock.now })
    return SyncEngine(
      source: health, api: api, storage: storage, check: check, session: SyncSession(key: "ak_test", generation: 1),
      deviceTimeZone: deviceTimeZone, limits: limits, now: { clock.now })
  }

  var state: SyncState { (try? storage.load()) ?? SyncState(cutoff: Date(), accountTimezone: "UTC") }
}
