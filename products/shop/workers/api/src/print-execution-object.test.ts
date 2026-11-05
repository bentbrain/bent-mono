import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";

import { executePrintAssetFamily, PRINT_JOB_LEASE_MS } from "./print-asset-jobs";
import { PrintAssetExecution, type PrintExecutionStorage, type PrintExecutionTransaction, type Wakeup } from "./print-execution-object";

vi.mock("./print-asset-jobs", () => ({
  PRINT_JOB_LEASE_MS: 16 * 60_000,
  executePrintAssetFamily: vi.fn(),
}));

const PRODUCT = "189976ee-4965-45d1-8bae-6ea03a9c14bc";
const SIBLING = "289976ee-4965-45d1-8bae-6ea03a9c14bc";
const REVISION = "401c53ee-dc17-49e5-bc04-1588a589b8b6";
const OTHER_REVISION = "501c53ee-dc17-49e5-bc04-1588a589b8b6";
const NOW = 1_800_000_000_000;
let platform: PlatformProxy<Env> | undefined;

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Transactions commit the wakeup and alarm together. Hooks model a delayed
// output gate, pre-commit failure, and a lost response after a durable commit.
class MemoryStorage implements PrintExecutionStorage {
  wakeup: Wakeup | undefined;
  alarmAt: number | null = null;
  failNextSetAlarm = false;
  nextCommitFailure: "before" | "after" | undefined;
  beforeCommit: (() => Promise<void>) | undefined;
  private transactionTail = Promise.resolve();

  get() { return Promise.resolve(this.wakeup); }
  put(_key: "wakeup", value: Wakeup) { this.wakeup = value; return Promise.resolve(); }
  delete() { const existed = this.wakeup !== undefined; this.wakeup = undefined; return Promise.resolve(existed); }
  getAlarm() { return Promise.resolve(this.alarmAt); }
  setAlarm(time: number) {
    if (this.failNextSetAlarm) { this.failNextSetAlarm = false; return Promise.reject(new Error("Alarm write failed")); }
    this.alarmAt = time;
    return Promise.resolve();
  }
  deleteAlarm() { this.alarmAt = null; return Promise.resolve(); }

  async transaction<T>(action: (transaction: PrintExecutionTransaction) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    const released = deferred();
    this.transactionTail = released.promise;
    await previous;
    try {
      let wakeup = this.wakeup;
      let alarmAt = this.alarmAt;
      const value = await action({
        get: () => Promise.resolve(wakeup),
        put: (_key, next) => { wakeup = next; return Promise.resolve(); },
        delete: () => { const existed = wakeup !== undefined; wakeup = undefined; return Promise.resolve(existed); },
        getAlarm: () => Promise.resolve(alarmAt),
        setAlarm: next => { alarmAt = next; return Promise.resolve(); },
        deleteAlarm: () => { alarmAt = null; return Promise.resolve(); },
      });
      await this.beforeCommit?.();
      const failure = this.nextCommitFailure;
      this.nextCommitFailure = undefined;
      if (failure === "before") throw new Error("Transaction commit failed");
      this.wakeup = wakeup;
      this.alarmAt = alarmAt;
      if (failure === "after") throw new Error("Transaction commit outcome unknown");
      return value;
    } finally {
      released.resolve();
    }
  }
}

function executor(storage: MemoryStorage) {
  if (!platform) throw new Error("Test platform is unavailable");
  return new PrintAssetExecution({ storage }, platform.env);
}
function request(product = PRODUCT, revision = REVISION) {
  return new Request(`https://print-execution.internal/wake?product=${product}&revision=${revision}`, { method: "POST" });
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ environment: "", persist: false });
});
afterAll(async () => platform?.dispose());
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.mocked(executePrintAssetFamily).mockReset().mockResolvedValue(undefined);
});

describe("durable print alarm scheduling", () => {
  it("keeps storage exceptions private while retaining the failed invocation", async () => {
    const storage = new MemoryStorage();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("PRIVATE_PROVIDER_MESSAGE", { cause: new Error("PRIVATE_CAUSE") });
    vi.spyOn(storage, "transaction").mockRejectedValueOnce(failure);
    const rejected = executor(storage).fetch(request());
    await expect(rejected).rejects.toThrow(/^Application execution failed\. Diagnostic reference: [a-f0-9-]{36}$/);
    await expect(rejected).rejects.not.toHaveProperty("cause");
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_");
    expect(log).toHaveBeenCalledWith("Print executor execution failed.", expect.objectContaining({ operation: "wakeup", errorType: "Error" }));
    expect(storage.wakeup).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
  });

  it("acknowledges only after wakeup and alarm commit together", async () => {
    const storage = new MemoryStorage();
    const gate = deferred();
    const entered = deferred();
    storage.beforeCommit = async () => { entered.resolve(); await gate.promise; };
    let responded = false;
    const pending = executor(storage).fetch(request()).then(response => { responded = true; return response; });
    await entered.promise;
    expect(responded).toBe(false);
    expect(storage.wakeup).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
    gate.resolve();
    expect((await pending).status).toBe(202);
    expect(storage.wakeup).toMatchObject({ productId: PRODUCT, revisionId: REVISION });
    expect(storage.alarmAt).toBe(NOW);
    expect(executePrintAssetFamily).not.toHaveBeenCalled();
  });

  it("does not acknowledge a failed transaction, and safely retries a lost commit response", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    storage.nextCommitFailure = "before";
    await expect(object.fetch(request())).rejects.toThrow("Application execution failed. Diagnostic reference:");
    expect(storage.wakeup).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
    storage.nextCommitFailure = "after";
    await expect(object.fetch(request())).rejects.toThrow("Application execution failed. Diagnostic reference:");
    const committedGeneration = storage.wakeup?.generation;
    expect(storage.alarmAt).toBe(NOW);
    expect((await object.fetch(request())).status).toBe(202);
    expect(storage.wakeup?.generation).not.toBe(committedGeneration);
    expect(storage.alarmAt).toBe(NOW);
  });

  it("rejects a different revision without changing the durable intent", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    const initial = storage.wakeup;
    expect((await object.fetch(request(PRODUCT, OTHER_REVISION))).status).toBe(409);
    expect(storage.wakeup).toEqual(initial);
  });

  it("prearms recovery before any print work starts", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    vi.mocked(executePrintAssetFamily).mockImplementation(() => {
      expect(storage.alarmAt).toBe(NOW + PRINT_JOB_LEASE_MS);
      expect(storage.wakeup?.productId).toBe(PRODUCT);
      return Promise.resolve(undefined);
    });
    await object.alarm();
    expect(vi.mocked(executePrintAssetFamily).mock.calls.map(([, product, execution]) => ({ product, execution }))).toEqual([{
      product: PRODUCT, execution: { provider: "durable-object", executorEnteredAtMs: NOW, revisionId: REVISION },
    }]);
    expect(storage.wakeup).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
  });

  it("does not start printing if crash recovery cannot be armed", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    storage.failNextSetAlarm = true;
    await expect(object.alarm()).rejects.toThrow("Application execution failed. Diagnostic reference:");
    expect(executePrintAssetFamily).not.toHaveBeenCalled();
    expect(storage.wakeup).toBeDefined();
  });

  it("preserves a concurrent wake generation when an older alarm finishes", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    const originalGeneration = storage.wakeup?.generation;
    const entered = deferred();
    const release = deferred();
    vi.mocked(executePrintAssetFamily).mockImplementationOnce(async () => { entered.resolve(); await release.promise; return undefined; });
    const alarm = object.alarm();
    await entered.promise;
    expect((await object.fetch(request(SIBLING))).status).toBe(202);
    const latestGeneration = storage.wakeup?.generation;
    expect(latestGeneration).not.toBe(originalGeneration);
    release.resolve();
    await alarm;
    expect(storage.wakeup).toMatchObject({ productId: SIBLING, generation: latestGeneration });
    expect(storage.alarmAt).toBe(NOW);
    await object.alarm();
    expect(vi.mocked(executePrintAssetFamily).mock.calls.at(-1)?.[1]).toBe(SIBLING);
    expect(storage.wakeup).toBeUndefined();
  });

  it("respects the executor's running lease deadline after recovery", async () => {
    const storage = new MemoryStorage();
    await executor(storage).fetch(request());
    const leaseEndsAt = NOW + PRINT_JOB_LEASE_MS + 500;
    vi.mocked(executePrintAssetFamily).mockResolvedValue(leaseEndsAt);
    await executor(storage).alarm();
    expect(storage.alarmAt).toBe(leaseEndsAt);
    expect(storage.wakeup).toBeDefined();
  });

  it("backs off an unknown D1 commit, then defers to the surviving lease", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    vi.mocked(executePrintAssetFamily).mockRejectedValueOnce(new Error("D1 outcome unknown"));
    await object.alarm();
    expect(storage.alarmAt).toBe(NOW + 15_000);
    const leaseEndsAt = NOW + PRINT_JOB_LEASE_MS;
    vi.mocked(executePrintAssetFamily).mockResolvedValue(leaseEndsAt);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 15_000);
    await executor(storage).alarm();
    expect(storage.alarmAt).toBe(leaseEndsAt);
    expect(storage.wakeup).toBeDefined();
  });

  it("retains prearmed recovery when final cleanup fails before commit", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    storage.nextCommitFailure = "before";
    await expect(object.alarm()).rejects.toThrow("Application execution failed. Diagnostic reference:");
    expect(storage.alarmAt).toBe(NOW + PRINT_JOB_LEASE_MS);
    expect(storage.wakeup).toBeDefined();
    await executor(storage).alarm();
    expect(storage.wakeup).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
  });

  it("treats duplicate alarm delivery after an unknown cleanup commit as a no-op", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    storage.nextCommitFailure = "after";
    await expect(object.alarm()).rejects.toThrow("Application execution failed. Diagnostic reference:");
    expect(storage.wakeup).toBeUndefined();
    expect(storage.alarmAt).toBeNull();
    await executor(storage).alarm();
    expect(executePrintAssetFamily).toHaveBeenCalledTimes(1);
  });

  it("backs off capacity admission without duplicate wakeups resetting the delay", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    vi.mocked(executePrintAssetFamily).mockResolvedValue(0);
    for (const delay of [1000, 2000, 4000, 5000, 5000]) {
      await object.alarm();
      expect(storage.alarmAt).toBe(NOW + delay);
      await object.fetch(request(SIBLING));
      expect(storage.alarmAt).toBe(NOW + delay);
    }
    expect(executePrintAssetFamily).toHaveBeenCalledTimes(5);
  });

  it("keeps a concurrent duplicate behind known capacity or running-lease waits", async () => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    for (const retryAt of [0, NOW + PRINT_JOB_LEASE_MS]) {
      const entered = deferred();
      const release = deferred();
      vi.mocked(executePrintAssetFamily).mockImplementationOnce(async () => {
        entered.resolve(); await release.promise; return retryAt;
      });
      const alarm = object.alarm();
      await entered.promise;
      await object.fetch(request(SIBLING));
      release.resolve();
      await alarm;
      expect(storage.alarmAt).toBe(retryAt || NOW + 1000);
      expect(storage.wakeup?.productId).toBe(SIBLING);
    }
  });

  it.each([0, NOW - 1, NOW + 200])("avoids a tight retry loop for due time %s", async retryAt => {
    const storage = new MemoryStorage();
    const object = executor(storage);
    await object.fetch(request());
    vi.mocked(executePrintAssetFamily).mockResolvedValue(retryAt);
    await object.alarm();
    expect(storage.alarmAt).toBe(NOW + 1_000);
  });
});
