import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { executePrintAssetFamily, PRINT_JOB_LEASE_MS, type PrintAssetJobEnv } from "./print-asset-jobs";
import { diagnosticRuntimeError } from "./observability";

export interface Wakeup {
  readonly productId: string;
  readonly revisionId: string;
  readonly generation: string;
  readonly capacityDeferrals?: number;
}

export interface PrintExecutionTransaction {
  get(key: "wakeup"): Promise<Wakeup | undefined>;
  put(key: "wakeup", value: Wakeup): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface PrintExecutionStorage extends PrintExecutionTransaction {
  transaction<T>(action: (transaction: PrintExecutionTransaction) => Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// One object per immutable revision. It owns durable scheduling, not readiness.
// Alarms run independently of the request that requested the work. The shared
// D1 claim bounds all executors, including independent objects, to five families.
export class PrintAssetExecution {
  constructor(
    private readonly state: { storage: PrintExecutionStorage },
    private readonly env: PrintAssetJobEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    return this.observeExecution("wakeup", () => this.acceptWakeup(request));
  }

  private async acceptWakeup(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const productId = url.searchParams.get("product") ?? "";
    const revisionId = url.searchParams.get("revision") ?? "";
    if (request.method !== "POST" || url.pathname !== "/wake" || !UUID.test(productId) || !UUID.test(revisionId)) {
      return new Response(null, { status: 400 });
    }
    const accepted = await this.state.storage.transaction(async transaction => {
      const current = await transaction.get("wakeup");
      if (current && current.revisionId !== revisionId) return false;
      await transaction.put("wakeup", { productId, revisionId, generation: crypto.randomUUID(),
        capacityDeferrals: current?.capacityDeferrals ?? 0 });
      if (await transaction.getAlarm() === null) await transaction.setAlarm(Date.now());
      return true;
    });
    return new Response(null, { status: accepted ? 202 : 409 });
  }

  async alarm(): Promise<void> {
    return this.observeExecution("alarm", () => this.runAlarm());
  }

  private async observeExecution<T>(operation: string, run: () => Promise<T>): Promise<T> {
    const executionId = crypto.randomUUID();
    try {
      return await run();
    } catch (error) {
      console.error("Print executor execution failed.", { operation, executionId, ...safeErrorDetails(error) });
      throw diagnosticRuntimeError(error, executionId);
    }
  }

  private async runAlarm(): Promise<void> {
    const enteredAt = Date.now();
    const wakeup = await this.state.storage.get("wakeup");
    if (!wakeup) return;
    // Arm recovery before starting work. A terminated alarm must not strand its
    // intent, and the retry cannot overlap a surviving 15-minute invocation.
    await this.state.storage.setAlarm(enteredAt + PRINT_JOB_LEASE_MS);
    let retryAt: number | undefined;
    try {
      retryAt = await executePrintAssetFamily(this.env, wakeup.productId, {
        provider: "durable-object", executorEnteredAtMs: enteredAt, revisionId: wakeup.revisionId,
      });
    } catch (error) {
      console.error("Print executor will retry from its durable intent.", { productId: wakeup.productId, revisionId: wakeup.revisionId, ...safeErrorDetails(error) });
      retryAt = Date.now() + 15_000;
    }
    await this.state.storage.transaction(async transaction => {
      const current = await transaction.get("wakeup");
      if (!current) return;
      // A new wake must retain known backoff/lease deadlines as well as its
      // generation. Duplicate queue delivery cannot create a capacity busy loop.
      if (retryAt === 0) {
        const capacityDeferrals = Math.min((current.capacityDeferrals ?? 0) + 1, 4);
        await transaction.put("wakeup", { ...current, capacityDeferrals });
        await transaction.setAlarm(Date.now() + Math.min(1000 * 2 ** (capacityDeferrals - 1), 5000));
      } else if (retryAt !== undefined) {
        await transaction.setAlarm(Math.max(Date.now() + 1_000, retryAt));
      } else if (current.generation !== wakeup.generation) {
        // Completion cannot erase work accepted during the previous execution.
        await transaction.setAlarm(Date.now());
      } else {
        await transaction.delete("wakeup");
        await transaction.deleteAlarm();
      }
    });
  }
}
