import ExpoModulesCore
import HealthKit

/// The JavaScript interface to the sync service. The OAuth token passed to
/// `enroll` is used for one request and not kept.
public final class FitnessHealthModule: Module {
  private var service: SyncService { SyncService.shared }

  public func definition() -> ModuleDefinition {
    Name("FitnessHealth")

    Events("onStatus")

    OnStartObserving {
      let listener = Listener(module: self)
      SyncService.shared.onResult = { status in listener.send(status) }
    }

    OnStopObserving {
      SyncService.shared.onResult = nil
    }

    Function("healthDataAvailable") { () -> Bool in
      HKHealthStore.isHealthDataAvailable()
    }

    AsyncFunction("getStatus") { () async -> [String: Any] in
      await self.service.status()
    }

    AsyncFunction("enroll") { (token: String, revokeLater: Bool) async throws -> [String: Any] in
      let outcome = try await self.service.lifecycle.enroll(token: token, revokeLater: revokeLater)
      let encoded = EnrollOutcomeJSON.encode(outcome)
      self.service.logEnrollment(encoded)
      return encoded
    }

    AsyncFunction("confirmConsent") { (cutoffMs: Double) async throws in
      try await self.service.confirm(cutoff: Date(timeIntervalSince1970: cutoffMs / 1000))
    }

    AsyncFunction("declineConsent") { () async throws -> Int in
      try await self.service.lifecycle.decline()
    }

    AsyncFunction("requestHealthAccess") { () async throws in
      try await self.service.requestHealthAccess()
    }

    AsyncFunction("readableHistory") { () async -> [String: Any] in
      await self.service.readableHistory()
    }

    AsyncFunction("syncNow") { () async -> [String: Any] in
      await self.service.syncNow()
      return await self.service.status()
    }

    AsyncFunction("disconnect") { () async throws -> Int in
      try await self.service.disconnect()
    }

    AsyncFunction("retryRevocations") { () async -> Int in
      await self.service.lifecycle.revokePending()
    }

    AsyncFunction("setCutoff") { (cutoffMs: Double) async throws in
      try await self.service.lifecycle.setCutoff(Date(timeIntervalSince1970: cutoffMs / 1000))
    }

    AsyncFunction("resyncFromEarliest") { () async throws in
      try await self.service.lifecycle.resyncFromEarliest()
    }
  }
}

/// Sends status events to the module while it is alive.
private final class Listener: @unchecked Sendable {
  weak var module: FitnessHealthModule?
  init(module: FitnessHealthModule) { self.module = module }
  func send(_ status: [String: Any]) { module?.sendEvent("onStatus", status) }
}

/// Enrollment outcomes as plain values for JavaScript.
enum EnrollOutcomeJSON {
  static func encode(_ outcome: EnrollOutcome) -> [String: Any] {
    switch outcome {
    case let .consentPending(email, timezone):
      return ["kind": "consentPending", "email": email, "accountTimezone": timezone]
    case let .pendingRevocations(count):
      return ["kind": "pendingRevocations", "count": count]
    case .superseded:
      return ["kind": "superseded"]
    case let .failed(action):
      switch action {
      case .enrolled: return ["kind": "failed", "action": "bug", "message": "Unexpected enrollment state."]
      case let .retrySameToken(after, code):
        return ["kind": "failed", "action": "retrySameToken", "code": code, "retryAfter": after ?? NSNull()]
      case let .bug(message): return ["kind": "failed", "action": "bug", "message": message]
      case let .reauthorize(code): return ["kind": "failed", "action": "reauthorize", "code": code]
      case let .deviceLimit(message): return ["kind": "failed", "action": "deviceLimit", "message": message]
      case let .refused(code, message):
        return ["kind": "failed", "action": "refused", "code": code, "message": message]
      }
    }
  }
}
