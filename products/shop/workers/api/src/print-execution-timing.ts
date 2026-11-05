/** Operation timestamps, never log-collector arrival times. No artwork or owner data. */
export interface PrintExecutionTiming {
  readonly schemaVersion: 1;
  readonly event: "print_job_timing";
  readonly provider: "queue" | "durable-object";
  readonly productId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly outcome: "ready" | "failed" | "superseded" | "inactive" | "deferred";
  readonly jobCreatedAtMs: number;
  readonly executorEnteredAtMs: number;
  readonly claimStartedAtMs: number;
  readonly claimedAtMs: number;
  readonly preparationStartedAtMs: number;
  /** Emitted only after the fenced ready update succeeds and affects the row. */
  readonly readyCommittedAtMs?: number;
  readonly finishedAtMs: number;
  /** Cloudflare's message timestamp; not the sender's send-response timestamp. */
  readonly queueMessageTimestampMs?: number;
  readonly deliveryId?: string;
  readonly triggerProductId?: string;
}

export function logPrintExecutionTiming(timing: PrintExecutionTiming): void {
  console.info("Print execution timing", timing);
}
