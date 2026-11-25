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

/// Runs one sync at a time. A trigger that arrives during a run asks for
/// another run, which covers its completion handler. Each run holds its own
/// background time and completes its handlers exactly once, whether it
/// finishes, fails or runs out of time. A run that runs out of time is
/// cancelled and writes nothing more.
public actor SyncCoordinator {
  public typealias EngineFactory = @Sendable (SyncSession) async -> SyncEngine?

  private let makeEngine: EngineFactory
  private let session: @Sendable () async -> SyncSession?
  private let background: BackgroundTime
  private let onResult: @Sendable (RunResult) async -> Void

  private var running = false
  private var queued: [Completion] = []
  private var rerun = false
  private var rerunMode: RunMode = .background
  private var rerunForce = false
  private var current: Task<RunResult, Never>?
  /// Set when a run stopped because the device was locked or an upload
  /// should be retried; cleared by the next finished run.
  public private(set) var retryPending = false

  public init(
    session: @escaping @Sendable () async -> SyncSession?,
    background: BackgroundTime,
    makeEngine: @escaping EngineFactory,
    onResult: @escaping @Sendable (RunResult) async -> Void = { _ in }
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
    current?.cancel()
  }

  /// Cancels the current run and waits for it to end, for disconnect.
  public func stop() async {
    current?.cancel()
    _ = await current?.value
    rerun = false
    let handlers = queued
    queued = []
    handlers.forEach { $0() }
  }

  private func runOnce(mode: RunMode, force: Bool, handlers: [Completion]) async {
    guard let session = await session(), let engine = await makeEngine(session) else {
      handlers.forEach { $0() }
      await onResult(.idle)
      return
    }
    let task = Task<RunResult, Never> {
      do {
        return .finished(try await engine.run(mode: mode, force: force))
      } catch let stop as RunStop {
        return .stopped(stop)
      } catch {
        return .failed(String(describing: type(of: error)))
      }
    }
    current = task
    let flush: @Sendable () -> Void = {
      task.cancel()
      handlers.forEach { $0() }
    }
    let id = await background.begin(expired: flush)
    let result = await task.value
    current = nil
    switch result {
    case .finished: retryPending = false
    case .stopped(.locked), .stopped(.retry): retryPending = true
    default: break
    }
    handlers.forEach { $0() }
    await background.end(id)
    await onResult(result)
  }
}
