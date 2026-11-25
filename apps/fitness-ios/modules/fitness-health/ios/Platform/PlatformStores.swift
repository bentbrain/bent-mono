import CryptoKit
import Foundation
import Security
import UIKit

/// The installation ID and the credentials item in the Keychain, readable
/// after the first unlock and never leaving this device.
final class KeychainCredentials: CredentialStore, @unchecked Sendable {
  private let service: String
  private let lock = NSLock()

  init(service: String) { self.service = service }

  enum KeychainError: Error { case status(OSStatus) }

  private func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  private func read(_ account: String) throws -> Data? {
    var item = query(account)
    item[kSecReturnData as String] = true
    item[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(item as CFDictionary, &result)
    switch status {
    case errSecSuccess: return result as? Data
    case errSecItemNotFound: return nil
    case errSecInteractionNotAllowed: throw HealthAccessError.protectedDataUnavailable
    default: throw KeychainError.status(status)
    }
  }

  /// Replaces the item in one update, or adds it.
  private func write(_ account: String, _ data: Data) throws {
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query(account).merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    if status == errSecInteractionNotAllowed { throw HealthAccessError.protectedDataUnavailable }
    guard status == errSecSuccess else { throw KeychainError.status(status) }
  }

  func installationId() throws -> UUID {
    lock.lock()
    defer { lock.unlock() }
    if let data = try read("installation"), let text = String(data: data, encoding: .utf8),
      let id = UUID(uuidString: text)
    {
      return id
    }
    let id = UUID()
    try write("installation", Data(id.uuidString.utf8))
    return id
  }

  func load() throws -> CredentialDocument {
    lock.lock()
    defer { lock.unlock() }
    guard let data = try read("credentials") else { return CredentialDocument() }
    return try JSONDecoder().decode(CredentialDocument.self, from: data)
  }

  func save(_ document: CredentialDocument) throws {
    lock.lock()
    defer { lock.unlock() }
    try write("credentials", JSONEncoder().encode(document))
  }
}

/// Sync state files under Application Support/sync/<namespace>/, one
/// namespace per account and origin, excluded from backups and readable
/// after the first unlock.
final class SyncStateFiles: StateDirectory, @unchecked Sendable {
  let root: URL

  init(root: URL) { self.root = root }

  static func standard() throws -> SyncStateFiles {
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return SyncStateFiles(root: support.appendingPathComponent("sync", isDirectory: true))
  }

  static func namespace(_ credential: DeviceCredential) -> String {
    let digest = SHA256.hash(data: Data("\(credential.userId)\n\(credential.apiOrigin)".utf8))
    return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
  }

  func storage(for credential: DeviceCredential) -> StateStorage {
    let directory = root.appendingPathComponent(Self.namespace(credential), isDirectory: true)
    return FileStateStorage(directory: directory) { file in try Self.protect(file) }
  }

  /// Applies file protection after each atomic replace, and checks that the
  /// directories are excluded from backups.
  static func protect(_ file: URL) throws {
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
    var directory = file.deletingLastPathComponent()
    for _ in 0..<2 {
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      let check = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
      guard check.isExcludedFromBackup == true else { throw CocoaError(.fileWriteUnknown) }
      directory = directory.deletingLastPathComponent()
    }
  }

  func clear(keeping credential: DeviceCredential?) throws {
    let keep = credential.map(Self.namespace)
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return }
    for name in names where name != keep {
      try FileManager.default.removeItem(at: root.appendingPathComponent(name))
    }
  }
}

/// HTTP over an ephemeral session that refuses redirects to another origin.
final class PinnedTransport: NSObject, HTTPTransport, URLSessionTaskDelegate, @unchecked Sendable {
  private let origin: URL
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()

  init(origin: URL) { self.origin = origin }

  func send(_ request: URLRequest) async -> HTTPReply? {
    guard FitnessAPI.sameOrigin(request.url, origin) else { return nil }
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse, FitnessAPI.sameOrigin(http.url, origin) else { return nil }
      var headers: [String: String] = [:]
      for (name, value) in http.allHeaderFields {
        if let name = name as? String, let value = value as? String { headers[name] = value }
      }
      return HTTPReply(status: http.statusCode, headers: headers, body: data)
    } catch {
      return nil
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // A redirect off the origin is not followed; the 3xx is the reply.
    completionHandler(FitnessAPI.sameOrigin(request.url, origin) ? request : nil)
  }
}

/// Background time from UIKit for each run.
@MainActor
final class UIKitBackgroundTime: BackgroundTime, @unchecked Sendable {
  /// Tasks still open, so each is ended exactly once.
  private var open = Set<Int>()

  nonisolated init() {}

  nonisolated func begin(expired: @escaping @Sendable () -> Void) async -> Int {
    await MainActor.run {
      let task = TaskID()
      let id = UIApplication.shared.beginBackgroundTask(withName: "Fitness sync") { [weak self] in
        expired()
        self?.finish(task.value)
      }
      task.value = id.rawValue
      if id != .invalid { open.insert(id.rawValue) }
      return id.rawValue
    }
  }

  nonisolated func end(_ id: Int) async {
    await MainActor.run { finish(id) }
  }

  /// The task's ID, set once UIKit returns it.
  private final class TaskID: @unchecked Sendable {
    var value = UIBackgroundTaskIdentifier.invalid.rawValue
  }

  private func finish(_ id: Int) {
    guard open.remove(id) != nil else { return }
    UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id))
  }
}
