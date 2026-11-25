import Foundation

/// Background time for one run. The platform layer uses
/// `UIApplication.beginBackgroundTask`; tests use a fake.
public protocol BackgroundTime: Sendable {
  /// Starts background time and returns its ID. `expired` runs if iOS
  /// takes the time back first.
  func begin(expired: @escaping @Sendable () -> Void) async -> Int
  func end(_ id: Int) async
}

/// A completion handler, such as an observer query's, that runs once.
public final class Completion: @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable () -> Void)?

  public init(_ handler: @escaping @Sendable () -> Void) { self.handler = handler }

  /// Runs the handler the first time only.
  public func callAsFunction() {
    lock.lock()
    let handler = self.handler
    self.handler = nil
    lock.unlock()
    handler?()
  }
}

/// What a finished run reports.
public enum RunResult: Sendable, Equatable {
  case finished(RunSummary)
  case stopped(RunStop)
  case failed(String)
  /// There is no active session to sync.
  case idle
}

/// The task a run is running, set once it starts, so expiry can cancel it.
private final class RunHandle: @unchecked Sendable {
  private let lock = NSLock()
  private var task: Task<RunResult, Never>?
  private var cancelled = false

  func set(_ task: Task<RunResult, Never>) {
    lock.lock()
    self.task = task
    let cancel = cancelled
    lock.unlock()
    if cancel { task.cancel() }
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let task = self.task
    lock.unlock()
    task?.cancel()
  }
}

/// Runs one sync at a time. A trigger that arrives during a run asks for
/// another run, which covers its completion handler. Each run takes its own
/// background time before it starts, and completes its handlers exactly
/// once, whether it finishes, fails or runs out of time. A run that runs out
/// of time is cancelled and its write fence closes, so it writes nothing
/// more. Each result names the session the run used.
public actor SyncCoordinator {
  public typealias EngineFactory = @Sendable (SyncSession) async -> SyncEngine?

  private let makeEngine: EngineFactory
  private let session: @Sendable () async throws -> SyncSession?
  private let background: BackgroundTime
  private let onResult: @Sendable (RunResult, SyncSession?) async -> Void

  private var running = false
  private var queued: [Completion] = []
  private var rerun = false
  private var rerunMode: RunMode = .background
  private var rerunForce = false
  private var current: Task<RunResult, Never>?
  private var currentFence: WriteFence?
  /// Set when a run stopped because the device was locked or an upload
  /// should be retried; cleared by the next finished run.
  public private(set) var retryPending = false

  /// `session` throws `HealthAccessError.protectedDataUnavailable` while the
  /// Keychain is locked, which marks a retry for after the unlock.
  public init(
    session: @escaping @Sendable () async throws -> SyncSession?,
    background: BackgroundTime,
    makeEngine: @escaping EngineFactory,
    onResult: @escaping @Sendable (RunResult, SyncSession?) async -> Void = { _, _ in }
  ) {
    self.session = session
    self.background = background
    self.makeEngine = makeEngine
    self.onResult = onResult
  }

  /// Asks for a run. `completion` runs once the run that covers it ends.
  public func trigger(mode: RunMode, force: Bool = false, completion: (@Sendable () -> Void)? = nil) async {
    if let completion { queued.append(Completion(completion)) }
    if mode == .foreground { rerunMode = .foreground }
    if force { rerunForce = true }
    rerun = true
    guard !running else { return }
    running = true
    while rerun {
      rerun = false
      let mode = rerunMode
      let force = rerunForce
      rerunMode = .background
      rerunForce = false
      let handlers = queued
      queued = []
      await runOnce(mode: mode, force: force, handlers: handlers)
    }
    running = false
  }

  /// Cancels the current run, which then writes nothing more.
  public func cancel() {
    currentFence?.close()
    current?.cancel()
  }

  /// Cancels the current run and waits for it to end, for disconnect.
  public func stop() async {
    currentFence?.close()
    current?.cancel()
    _ = await current?.value
    rerun = false
    let handlers = queued
    queued = []
    handlers.forEach { $0() }
  }

  private func runOnce(mode: RunMode, force: Bool, handlers: [Completion]) async {
    // Background time comes first, so expiry covers the whole run.
    let fence = WriteFence()
    let handle = RunHandle()
    let id = await background.begin(expired: {
      fence.close()
      handle.cancel()
      handlers.forEach { $0() }
    })
    currentFence = fence
    defer { currentFence = nil }
    let found: SyncSession?
    do {
      found = try await session()
    } catch {
      retryPending = true
      handlers.forEach { $0() }
      await background.end(id)
      await onResult(.stopped(.locked), nil)
      return
    }
    guard fence.isOpen, let found, let engine = await makeEngine(found) else {
      handlers.forEach { $0() }
      await background.end(id)
      await onResult(fence.isOpen ? .idle : .stopped(.fenced), found)
      return
    }
    let fenced = engine.fenced(by: fence)
    let task = Task<RunResult, Never> {
      do {
        return .finished(try await fenced.run(mode: mode, force: force))
      } catch let stop as RunStop {
        return .stopped(stop)
      } catch {
        return .failed(String(describing: type(of: error)))
      }
    }
    handle.set(task)
    current = task
    let result = await task.value
    current = nil
    switch result {
    case .finished: retryPending = false
    case .stopped(.locked), .stopped(.retry): retryPending = true
    default: break
    }
    handlers.forEach { $0() }
    await background.end(id)
    await onResult(result, found)
  }
}

/// What the app does after a run. A `401 key_invalid` clears the key only if
/// it is still the stored key; a newer key that replaced it stays. Returns
/// whether background delivery should stop.
public enum RunOutcomePolicy {
  public static func apply(
    _ result: RunResult, session: SyncSession?, lifecycle: DeviceLifecycle
  ) async -> Bool {
    guard case .stopped(.keyInvalid) = result, let session else { return false }
    return (try? await lifecycle.markInvalid(session)) ?? false
  }
}
