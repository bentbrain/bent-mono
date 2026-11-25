import Foundation

/// Why a sample is held back instead of sent.
public enum DeferralReason: String, Codable, Sendable {
  /// Its start is after now.
  case future
  /// A run that ended less than 6 hours ago without a distance.
  case awaitingDistance
  /// Fitness skipped it as dated after today in the account timezone.
  case serverFuture
  /// A run with no readable distance while the app cannot tell whether it
  /// may read distance. It waits until a distance appears or the user
  /// chooses to send runs without one.
  case distanceAccess
}

/// A sample held back until it becomes eligible.
public struct DeferredItem: Codable, Sendable, Equatable {
  public var kind: SampleKind
  public var reason: DeferralReason
  /// When a lookup of this UUID first succeeded but found nothing. Cleared
  /// whenever the sample is read again; the item is retired 30 days after.
  public var firstEmptyAt: Date?

  public init(kind: SampleKind, reason: DeferralReason, firstEmptyAt: Date? = nil) {
    self.kind = kind
    self.reason = reason
    self.firstEmptyAt = firstEmptyAt
  }
}

/// A backfill in progress. Its snapshot is taken once and reused when the
/// backfill resumes or rewinds.
public struct Backfill: Codable, Sendable, Equatable {
  /// The cutoff this snapshot covers, as an absolute instant.
  public var cutoff: Date
  /// The anchored query's end, per type, when the snapshot was taken.
  public var snapshotAnchors: [SampleKind: Data]
  /// Samples the snapshot saw that were not yet eligible.
  public var snapshotDeferred: [String: DeferredItem]
  /// Deferred UUIDs that were sent, deleted or retired during the backfill,
  /// so installing the baseline does not bring them back.
  public var resolved: Set<String>
  /// The last account date whose every request succeeded, as yyyy-MM-dd.
  public var through: String?
  /// The account timezone the days were grouped in.
  public var timezone: String

  public init(
    cutoff: Date, snapshotAnchors: [SampleKind: Data], snapshotDeferred: [String: DeferredItem],
    timezone: String
  ) {
    self.cutoff = cutoff
    self.snapshotAnchors = snapshotAnchors
    self.snapshotDeferred = snapshotDeferred
    resolved = []
    through = nil
    self.timezone = timezone
  }
}

/// Counts from one sync run: codes per type, with no dates or values.
public struct RunSummary: Codable, Sendable, Equatable {
  public var at: Date
  public var counts: [String: Int]
  public var error: String?

  public init(at: Date, counts: [String: Int] = [:], error: String? = nil) {
    self.at = at
    self.counts = counts
    self.error = error
  }
}

/// Everything the sync engine keeps between runs for one account and
/// origin. It holds sample UUIDs, anchors and counts, never Health values.
public struct SyncState: Codable, Sendable, Equatable {
  public var version = 1
  /// The selected cutoff: samples starting before it are not sent.
  public var cutoff: Date
  /// The earliest cutoff ever selected, for "Resync from earliest start".
  public var earliestCutoff: Date
  /// The account timezone from the latest reply.
  public var accountTimezone: String
  /// The incremental anchors, per type, once a backfill has installed them.
  public var anchors: [SampleKind: Data]?
  public var backfill: Backfill?
  public var deferred: [String: DeferredItem] = [:]
  /// Items retired because they could not be read for 30 days.
  public var unreadableRetired = 0
  /// Types held after a `400` until the user chooses Sync now.
  public var paused: [SampleKind: String] = [:]
  public var lastSyncAt: Date?
  public var lastError: String?
  /// Runs sent with no distance after waiting for one.
  public var runsWithoutDistance = 0
  /// The latest runs' counts, newest last, at most 30.
  public var history: [RunSummary] = []
  /// Consent is confirmed but the Health step has not started the first
  /// sync yet, so nothing runs.
  public var awaitingHealthStep = false
  /// Runs waiting for distance access that the user chose to send without
  /// a distance, by sample UUID. Each is removed once Fitness has it; runs
  /// that wait later need their own choice.
  public var approvedWithoutDistance: Set<String> = []

  public init(cutoff: Date, accountTimezone: String) {
    self.cutoff = cutoff
    earliestCutoff = cutoff
    self.accountTimezone = accountTimezone
  }

  /// Incremental sync runs only after a backfill installs its baseline.
  public var incrementalEnabled: Bool { anchors != nil && backfill == nil }

  public mutating func record(_ summary: RunSummary) {
    history.append(summary)
    if history.count > 30 { history.removeFirst(history.count - 30) }
  }
}

/// Where the sync state is kept. Writes replace the whole file atomically.
public protocol StateStorage: Sendable {
  func load() throws -> SyncState?
  func save(_ state: SyncState) throws
  func clear() throws
}

/// How the platform keeps the state private: the directory is prepared
/// (excluded from backups) before the first write, every write uses these
/// options, and `verify` checks the written file.
public struct FileProtection: Sendable {
  public var writeOptions: Data.WritingOptions
  public var prepareDirectory: @Sendable (URL) throws -> Void
  public var verify: @Sendable (URL) throws -> Void

  public init(
    writeOptions: Data.WritingOptions = [.atomic],
    prepareDirectory: @escaping @Sendable (URL) throws -> Void = { _ in },
    verify: @escaping @Sendable (URL) throws -> Void = { _ in }
  ) {
    self.writeOptions = writeOptions.union(.atomic)
    self.prepareDirectory = prepareDirectory
    self.verify = verify
  }
}

/// A state file under a directory. Each write replaces the file atomically,
/// with the file's protection given as it is written.
public final class FileStateStorage: StateStorage, @unchecked Sendable {
  public let file: URL
  private let protection: FileProtection
  private let lock = NSLock()

  public init(directory: URL, protection: FileProtection = FileProtection()) {
    file = directory.appendingPathComponent("state.json")
    self.protection = protection
  }

  public func load() throws -> SyncState? {
    lock.lock()
    defer { lock.unlock() }
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    return try JSONDecoder().decode(SyncState.self, from: Data(contentsOf: file))
  }

  public func save(_ state: SyncState) throws {
    lock.lock()
    defer { lock.unlock() }
    let directory = file.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try protection.prepareDirectory(directory)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    try encoder.encode(state).write(to: file, options: protection.writeOptions)
    try protection.verify(file)
  }

  /// Removes the state. A missing state is fine; any other failure throws.
  public func clear() throws {
    lock.lock()
    defer { lock.unlock() }
    do {
      try FileManager.default.removeItem(at: file.deletingLastPathComponent())
    } catch CocoaError.fileNoSuchFile {
      return
    } catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
      return
    }
  }
}
