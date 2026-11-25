import Foundation

/// Whole days in the account timezone. Windows are half-open,
/// `[day start, next day start)`, built with a calendar in that timezone so
/// daylight-saving days have their real length.
public struct AccountDays: Sendable {
  public let timeZone: TimeZone
  private let calendar: Calendar

  public init?(timezone: String) {
    guard let zone = TimeZone(identifier: timezone) else { return nil }
    timeZone = zone
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    self.calendar = calendar
  }

  /// The account date of an instant, as yyyy-MM-dd.
  public func day(_ date: Date) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  /// The start of an account date given as yyyy-MM-dd.
  public func start(of day: String) -> Date? {
    let parts = day.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
  }

  public func start(containing date: Date) -> Date { calendar.startOfDay(for: date) }

  public func next(_ dayStart: Date, by days: Int = 1) -> Date {
    calendar.date(byAdding: .day, value: days, to: dayStart) ?? dayStart.addingTimeInterval(Double(days) * 86_400)
  }
}
