import Foundation

/// What the Today widget shows, as the app writes it (src/logic/widget.ts).
/// The app module and the widget extension both compile this file.
public struct TodaySnapshot: Codable, Equatable {
  /// The format version. The extension reads version 1.
  public var version: Int
  /// "signedIn" or "signedOut". A signed-out snapshot has no days.
  public var status: String
  public var timezone: String?
  public var days: [Day]?

  public static let currentVersion = 1

  public struct Day: Codable, Equatable {
    /// The calendar day in the account timezone, such as 2026-11-28.
    public var day: String
    /// When the day starts and ends, in milliseconds since 1970.
    public var start: Double
    public var end: Double
    public var plan: Plan
    public var food: Food
    public var links: Links

    public var startDate: Date { Date(timeIntervalSince1970: start / 1000) }
    public var endDate: Date { Date(timeIntervalSince1970: end / 1000) }
  }

  public struct Plan: Codable, Equatable {
    /// "strength", "run" or "rest".
    public var kind: String
    public var title: String
    public var detail: String?
    /// "planned", "done", "inProgress", "rest" or "missed".
    public var state: String
    public var status: String
  }

  public struct Food: Codable, Equatable {
    public var calories: Amount
    public var protein: Amount
    public var nutrients: [Amount]
  }

  public struct Amount: Codable, Equatable {
    public var label: String
    /// "kcal" or "g".
    public var unit: String
    public var value: Double
    public var target: Double?
    /// "default", "done" or "missed".
    public var tone: String

    /// How far the value is through its target, from 0 to 1, or nil without a target.
    public var progress: Double? {
      guard let target, target > 0 else { return nil }
      return min(max(value / target, 0), 1)
    }
  }

  public struct Links: Codable, Equatable {
    public var week: String
    public var food: String
  }

  public var signedIn: Bool { status == "signedIn" }
}

/// The snapshot file in the App Group container that the app and the widget
/// extension share. The file is protected until first unlock, and its folder
/// is excluded from backups, as the app's other local data is.
public enum TodayStore {
  enum StoreError: Error {
    case noAppGroup
    case unreadable
    case notExcludedFromBackup
  }

  /// The App Group both Info.plists name.
  static var groupIdentifier: String? {
    Bundle.main.object(forInfoDictionaryKey: "FitnessAppGroup") as? String
  }

  static func file() throws -> URL {
    guard let group = groupIdentifier,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw StoreError.noAppGroup }
    return container
      .appendingPathComponent("Library/Application Support/widget", isDirectory: true)
      .appendingPathComponent("today.json", isDirectory: false)
  }

  /// The snapshot the app last wrote, or nil when there is none or it can't be read.
  public static func read() -> TodaySnapshot? {
    guard let url = try? file(), let data = try? Data(contentsOf: url) else { return nil }
    return try? decode(data)
  }

  /// Decodes a snapshot of the version this build reads.
  public static func decode(_ data: Data) throws -> TodaySnapshot {
    let snapshot = try JSONDecoder().decode(TodaySnapshot.self, from: data)
    guard snapshot.version == TodaySnapshot.currentVersion else { throw StoreError.unreadable }
    return snapshot
  }

  /// Replaces the snapshot with `data`, after checking that the widget can read it.
  public static func write(_ data: Data) throws {
    _ = try decode(data)
    let url = try file()
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try excludeFromBackup(directory)
    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  /// Excludes a directory from backups and checks that it is.
  static func excludeFromBackup(_ directory: URL) throws {
    var url = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    let check = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
    guard check.isExcludedFromBackup == true else { throw StoreError.notExcludedFromBackup }
  }
}
