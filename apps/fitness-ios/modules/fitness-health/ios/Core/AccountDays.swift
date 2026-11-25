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

  /// The start of an account date given as yyyy-MM-dd. Built from midday,
  /// so a day whose midnight does not exist still starts at its first hour.
  public func start(of day: String) -> Date? {
    let parts = day.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3,
      let midday = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    else { return nil }
    return calendar.startOfDay(for: midday)
  }

  public func start(containing date: Date) -> Date { calendar.startOfDay(for: date) }

  /// The start of the day `days` after the one containing `dayStart`. Each
  /// boundary is the start of its own day, so a daylight-saving change at
  /// midnight never carries an hour of offset into later days.
  public func next(_ dayStart: Date, by days: Int = 1) -> Date {
    let base = calendar.startOfDay(for: dayStart)
    let midday = calendar.date(byAdding: .hour, value: 12, to: base) ?? base.addingTimeInterval(12 * 3600)
    let target = calendar.date(byAdding: .day, value: days, to: midday)
      ?? midday.addingTimeInterval(Double(days) * 86_400)
    return calendar.startOfDay(for: target)
  }
}
