import Foundation

/// An HTTP response from Fitness, or the lack of one.
public struct HTTPReply: Sendable, Equatable {
  public let status: Int
  public let headers: [String: String]
  public let body: Data

  public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
    self.status = status
    self.headers = headers
    self.body = body
  }

  public func header(_ name: String) -> String? {
    headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
  }

  /// `Retry-After` in seconds, given as seconds or as an HTTP date.
  public func retryAfter(now: Date) -> TimeInterval? {
    guard let value = header("Retry-After")?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
    if let seconds = Int(value), seconds >= 0 { return TimeInterval(seconds) }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "GMT")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    guard let date = formatter.date(from: value) else { return nil }
    return max(0, date.timeIntervalSince(now))
  }

  var apiError: ApiError? { try? JSONDecoder().decode(ApiError.self, from: body) }
  var code: String? { apiError?.code }
  var message: String? { apiError?.error }
}

/// What the app does with a reply to an import.
public enum ImportAction: Sendable, Equatable {
  /// The only success: a device reply with one outcome per ref.
  case accepted(DeviceReply)
  /// Too many samples or too large: split the request and send each half.
  case split
  /// The account timezone changed: regroup the backfill's days.
  case timezoneChanged(String)
  /// The request needs a fix in the app. Hold the type until Sync now.
  case needsCorrection(String)
  /// Fitness says the key is no longer valid. Stop and ask to reconnect.
  case keyInvalid
  /// The key's account is no longer invited.
  case notInvited(String)
  /// The key lacks access. Ask to reconnect.
  case reconnect(String)
  /// Anything else: keep the key and the cursor, and retry later.
  case retry(after: TimeInterval?, reason: String)
}

/// What the app does with a reply to an enrollment.
public enum EnrollAction: Sendable, Equatable {
  case enrolled(EnrollResponse)
  /// Wait, then retry with the same token.
  case retrySameToken(after: TimeInterval?, code: String)
  /// The request was malformed: an app bug to surface.
  case bug(String)
  /// Start a fresh sign-in with the same installation.
  case reauthorize(code: String)
  /// Three other iPhones hold keys.
  case deviceLimit(String)
  /// A refusal with its own guidance: insufficient_scope, client_not_allowed,
  /// not_invited or enrollment_unavailable.
  case refused(code: String, message: String)
}

/// What the app does with a reply to `DELETE /api/health/devices/current`.
public enum RevokeAction: Sendable, Equatable {
  /// `204`: the key is revoked.
  case done
  /// `401 key_invalid`: the key is already unusable.
  case alreadyInvalid
  /// Try again later.
  case retry(after: TimeInterval?)
  /// `403 not_device_key`: the key is not a device key.
  case notDeviceKey(String)
}

public enum Classify {
  /// A reply to an import, or nil for a transport failure.
  public static func importReply(
    _ reply: HTTPReply?, submitted: [ImportRequest.Submitted], now: Date
  ) -> ImportAction {
    guard let reply else { return .retry(after: nil, reason: "transport") }
    let after = reply.retryAfter(now: now)
    switch (reply.status, reply.code) {
    case (200, _):
      do {
        return .accepted(try DeviceReply.accept(reply.body, for: submitted))
      } catch {
        return .retry(after: nil, reason: "malformed_reply")
      }
    case (413, _), (400, "too_many_samples"):
      return .split
    case (409, "timezone_changed"):
      if let timezone = reply.apiError?.accountTimezone, !timezone.isEmpty { return .timezoneChanged(timezone) }
      return .retry(after: after, reason: "timezone_changed")
    case (400, _):
      return .needsCorrection(reply.message ?? "Fitness could not read the request.")
    case (401, "key_invalid"):
      return .keyInvalid
    case (403, "not_invited"):
      return .notInvited(reply.message ?? "This account needs an invitation.")
    case (403, _):
      return .reconnect(reply.message ?? "Connect this iPhone again.")
    default:
      // 401 unauthorized, 409 import_conflict, 5xx and anything unexpected
      // leave the key in place, since its status is unknown.
      return .retry(after: after, reason: reply.code ?? "http_\(reply.status)")
    }
  }

  /// A reply to an enrollment, or nil when the reply was lost.
  public static func enrollReply(_ reply: HTTPReply?, now: Date) -> EnrollAction {
    guard let reply else { return .reauthorize(code: "lost_reply") }
    let after = reply.retryAfter(now: now)
    let message = reply.message ?? "Fitness could not connect this iPhone."
    switch (reply.status, reply.code) {
    case (201, _):
      guard let response = try? JSONDecoder().decode(EnrollResponse.self, from: reply.body),
        !response.secret.isEmpty, response.userId.hasPrefix("user_")
      else { return .reauthorize(code: "malformed_reply") }
      return .enrolled(response)
    case (503, "issuance_pending"), (429, "rate_limited"), (503, "auth_unavailable"):
      return .retrySameToken(after: after, code: reply.code ?? "")
    case (400, "invalid_request"):
      return .bug(message)
    case (503, "issuance_failed"), (409, "enrollment_token_used"), (401, _):
      return .reauthorize(code: reply.code ?? "unauthorized")
    case (409, "device_limit"):
      return .deviceLimit(message)
    case (403, let code?), (503, let code?):
      return .refused(code: code, message: message)
    default:
      return .reauthorize(code: reply.code ?? "http_\(reply.status)")
    }
  }

  /// A reply to a disconnect, or nil for a transport failure.
  public static func revokeReply(_ reply: HTTPReply?, now: Date) -> RevokeAction {
    guard let reply else { return .retry(after: nil) }
    switch (reply.status, reply.code) {
    case (204, _): return .done
    case (401, "key_invalid"): return .alreadyInvalid
    case (403, "not_device_key"): return .notDeviceKey(reply.message ?? "This key is not an iPhone sync key.")
    default: return .retry(after: reply.retryAfter(now: now))
    }
  }
}
