import Foundation
@testable import FitnessHealthCore

/// Sync state in memory, for tests.
public final class MemoryStateStorage: StateStorage, @unchecked Sendable {
  private let lock = NSLock()
  private var state: SyncState?
  /// Fails the next saves, to simulate a crash before the write.
  public var failSaves = 0
  public private(set) var saves = 0

  public init(_ state: SyncState? = nil) { self.state = state }

  public func load() throws -> SyncState? {
    lock.lock()
    defer { lock.unlock() }
    return state
  }

  public func save(_ state: SyncState) throws {
    lock.lock()
    defer { lock.unlock() }
    if failSaves > 0 {
      failSaves -= 1
      throw CocoaError(.fileWriteUnknown)
    }
    saves += 1
    self.state = state
  }

  public func clear() throws {
    lock.lock()
    defer { lock.unlock() }
    state = nil
  }
}
