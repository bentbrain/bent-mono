import Foundation

/// Sends one HTTP request. Returns nil when no reply arrived, such as on a
/// network failure or a refused redirect.
public protocol HTTPTransport: Sendable {
  func send(_ request: URLRequest) async -> HTTPReply?
}

/// The Fitness device routes, pinned to one origin.
public struct FitnessAPI: Sendable {
  public let origin: URL
  private let transport: HTTPTransport
  private let clock: @Sendable () -> Date

  /// `origin` must be an origin: a scheme, host and optional port, no path.
  public init(origin: URL, transport: HTTPTransport, clock: @escaping @Sendable () -> Date = { Date() }) throws {
    guard let scheme = origin.scheme, ["https", "http"].contains(scheme), origin.host != nil,
      origin.path.isEmpty || origin.path == "/", origin.query == nil
    else { throw APIError.invalidOrigin }
    if scheme == "http", !["127.0.0.1", "localhost"].contains(origin.host ?? "") { throw APIError.invalidOrigin }
    self.origin = origin
    self.transport = transport
    self.clock = clock
  }

  public enum APIError: Error { case invalidOrigin }

  /// Whether a URL is on the pinned origin.
  public static func sameOrigin(_ url: URL?, _ origin: URL) -> Bool {
    guard let url else { return false }
    return url.scheme?.lowercased() == origin.scheme?.lowercased()
      && url.host?.lowercased() == origin.host?.lowercased()
      && (url.port ?? defaultPort(url.scheme)) == (origin.port ?? defaultPort(origin.scheme))
  }

  private static func defaultPort(_ scheme: String?) -> Int? {
    switch scheme?.lowercased() {
    case "https": 443
    case "http": 80
    default: nil
    }
  }

  private func request(_ path: String, method: String, bearer: String, body: Data?) -> URLRequest {
    var request = URLRequest(url: origin.appendingPathComponent(path))
    request.httpMethod = method
    request.timeoutInterval = 60
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = false
    request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(FitnessHealthCore.userAgent, forHTTPHeaderField: "User-Agent")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    return request
  }

  public func importSamples(_ body: ImportRequest, key: String) async -> ImportAction {
    let data: Data
    do {
      data = try body.encoded()
    } catch {
      return .needsCorrection("The samples could not be encoded.")
    }
    let reply = await transport.send(request("api/health/import", method: "POST", bearer: key, body: data))
    return Classify.importReply(reply, submitted: body.submitted, now: clock())
  }

  public func enroll(token: String, installationId: UUID, deviceName: String, sequence: Int) async -> EnrollAction {
    let body = try? JSONSerialization.data(
      withJSONObject: [
        "installationId": installationId.uuidString.lowercased(), "deviceName": deviceName,
        "enrollmentSequence": sequence,
      ] as [String: Any],
      options: [.sortedKeys])
    let reply = await transport.send(request("api/health/devices", method: "POST", bearer: token, body: body))
    return Classify.enrollReply(reply, now: clock())
  }

  public func revoke(key: String) async -> RevokeAction {
    let reply = await transport.send(request("api/health/devices/current", method: "DELETE", bearer: key, body: nil))
    return Classify.revokeReply(reply, now: clock())
  }
}

public enum DeviceName {
  /// A device name Fitness accepts: trimmed, 1 to 60 UTF-16 code units as
  /// JavaScript counts them, with no control or format characters. Falls
  /// back to "iPhone".
  public static func clean(_ name: String) -> String {
    let allowed = name.unicodeScalars.filter { scalar in
      let category = scalar.properties.generalCategory
      return category != .control && category != .format
    }
    let trimmed = String(String.UnicodeScalarView(allowed)).trimmingCharacters(in: .whitespacesAndNewlines)
    var limited = Substring(trimmed)
    while limited.utf16.count > 60 { limited = limited.dropLast() }
    limited = Substring(limited.trimmingCharacters(in: .whitespacesAndNewlines))
    return limited.isEmpty ? "iPhone" : String(limited)
  }
}
