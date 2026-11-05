import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import type { ArtworkPreparationMessage } from "./artwork-preparation-jobs";
import { missingRequiredPrintGeometrySql, requiredPrintGeometryCtesSql } from "./print-asset-recovery-candidates.ts";
import { createPrintAssetQueueContext, ensureConfiguredProductPrintAssets, isPrintMemoryCapacityError } from "./print-assets";
import { dispatchPrintExecution, usesDurablePrintExecution, type PrintExecutionDispatchEnv } from "./print-execution-dispatch";
import { logPrintExecutionTiming } from "./print-execution-timing";

export interface PrintAssetQueueMessage {
  readonly configuredProductId: string;
}

export interface PrintAssetJobEnv extends PrintExecutionDispatchEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly IMAGES: ImagesBinding;
  readonly PRINT_EXECUTION_RELEASE_ID?: string;
  readonly PRINT_ASSET_JOBS?: {
    send(message: PrintAssetQueueMessage | ArtworkPreparationMessage, options?: { delaySeconds: number }): Promise<unknown>;
  };
}

// Longer than the platform's 15-minute queue invocation lifetime: a recovered
// job cannot overlap a surviving consumer from the previous lease.
export const PRINT_JOB_LEASE_MS = 16 * 60_000;
const DELIVERY_LEASE_MS = 60_000;
const RECOVERY_BATCH = 500;

// Materialized inside the claim statement so both sibling rows see the same
// admission decision. Historical completed work is outside the partial index.
const printAdmissionCandidatesSql = `
  WITH live_families AS MATERIALIZED (
    SELECT DISTINCT product.design_revision_id AS revision_id
    FROM print_asset_jobs live_job INDEXED BY print_asset_jobs_running_idx
    CROSS JOIN products product ON product.id = live_job.configured_product_id
    WHERE live_job.status = 'running' AND live_job.next_attempt_at > ?
      AND product.design_revision_id IS NOT NULL
  )
  SELECT product.design_revision_id AS revision_id, min(product.id) AS product_id
  FROM print_asset_jobs candidate INDEXED BY print_asset_jobs_admission_idx
  CROSS JOIN products product ON product.id = candidate.configured_product_id
  WHERE candidate.status <> 'ready' AND product.status = 'active' AND product.design_revision_id IS NOT NULL
    AND (candidate.status = 'dispatched' OR candidate.next_attempt_at <= ?)
    AND product.design_revision_id NOT IN (SELECT revision_id FROM live_families)
  GROUP BY product.design_revision_id
  ORDER BY min(candidate.created_at), product.design_revision_id
  LIMIT max(0, 5 - (SELECT count(*) FROM live_families))
`;

interface ClaimedPrintJob {
  readonly configured_product_id: string;
  readonly attempt_count: number;
  readonly created_at: number;
}

// The row is the durable outbox. Queue acceptance is only a wakeup, never proof
// of completion. Lost sends and expired queue messages are recovered by cron.
export async function enqueuePrintAssetJobs(
  env: PrintAssetJobEnv,
  productIds: readonly string[],
  context?: Pick<ExecutionContext, "waitUntil">,
) {
  const now = Date.now();
  await env.DB.batch(productIds.map(id => env.DB.prepare(`
    INSERT INTO print_asset_jobs (configured_product_id, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (configured_product_id) DO NOTHING
  `).bind(id, now, now, now)));
  console.info("Print outbox persisted", { productCount: productIds.length, durationMs: Date.now() - now });
  // Persist before acknowledging configuration. External delivery can finish
  // within the request's background lifetime; cron recovers an interrupted send.
  const delivery = Promise.allSettled(productIds.map(id => deliverPrintAssetJob(env, id))).then(results => {
    if (results.some(result => result.status === "rejected")) console.warn("Print outbox delivery deferred.");
  });
  if (context) context.waitUntil(delivery);
  else await delivery;
}

async function deliverPrintAssetJob(env: PrintAssetJobEnv, id: string) {
  if (!env.PRINT_ASSET_JOBS) return;
  const now = Date.now();
  const claimed = await env.DB.prepare(`
    UPDATE print_asset_jobs SET status = 'dispatched', lease_id = NULL, next_attempt_at = ?, updated_at = ?
    WHERE configured_product_id = ? AND status <> 'ready' AND next_attempt_at <= ?
    RETURNING configured_product_id
  `).bind(now + DELIVERY_LEASE_MS, now, id, now).first();
  if (!claimed) return;
  try {
    if (usesDurablePrintExecution(env)) {
      const deliveries = await Promise.allSettled([
        env.PRINT_ASSET_JOBS.send({ configuredProductId: id }),
        dispatchPrintExecution(env, id),
      ]);
      if (deliveries.every(result => result.status === "rejected")) throw new Error("Print delivery unavailable.");
    } else {
      await env.PRINT_ASSET_JOBS.send({ configuredProductId: id });
    }
    // Accepted messages get time to drain before another wakeup is sent.
    // A consumer that already claimed/completed the row wins this race.
    await env.DB.prepare(`UPDATE print_asset_jobs SET next_attempt_at = ?
      WHERE configured_product_id = ? AND status = 'dispatched' AND next_attempt_at = ?`)
      .bind(now + PRINT_JOB_LEASE_MS, id, now + DELIVERY_LEASE_MS).run();
  } catch {
    // Preserve the delivery lease to avoid a tight loop against a failed queue.
    console.warn("Print queue delivery deferred", { productId: id });
  }
}

// Adopt at most three previously failed legacy products per sweep. Start from
// the retry inventory rather than scanning every historical design each minute.
// A durable job owns future retries; legacy backoff does not delay the first handoff, but a live legacy
// render claim must expire before ownership can transfer.
async function adoptLegacyPrintAssetJobs(env: PrintAssetJobEnv) {
  const control = await env.DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'native_video_release_control'",
  ).first();
  if (!control) return;
  const now = Date.now();
  const adopted = await env.DB.prepare(`
    WITH ${requiredPrintGeometryCtesSql}
    INSERT INTO print_asset_jobs (configured_product_id, next_attempt_at, created_at, updated_at)
    SELECT products.id, ?, ?, ?
    FROM print_asset_retries AS retries
    CROSS JOIN products ON products.id = retries.configured_product_id
    JOIN products AS base ON base.id = products.base_product_id
      AND base.status = 'active' AND base.design_id IS NULL
    WHERE products.status = 'active' AND products.design_id IS NOT NULL
      AND products.design_revision_id IS NOT NULL
      AND products.projection_version IN ('legacy-shirt-v1', 'safe-margin-v1')
      AND EXISTS (SELECT 1 FROM native_video_release_control WHERE singleton = 1 AND paused = 0)
      AND NOT EXISTS (SELECT 1 FROM print_asset_jobs WHERE configured_product_id = products.id)
      AND (retries.claim_id IS NULL OR retries.next_attempt_at <= ?)
      AND ${missingRequiredPrintGeometrySql}
    ORDER BY retries.configured_product_id
    LIMIT 3
    ON CONFLICT (configured_product_id) DO NOTHING
    RETURNING configured_product_id
  `).bind(now, now, now, now).all<{ configured_product_id: string }>();
  if (adopted.results.length) {
    await env.DB.batch(adopted.results.map(row => env.DB.prepare(
      "DELETE FROM print_asset_retries WHERE configured_product_id = ?",
    ).bind(row.configured_product_id)));
    console.info("Legacy print jobs recovered", { productCount: adopted.results.length });
  }
}

export async function recoverPrintAssetJobs(env: PrintAssetJobEnv) {
  if (!env.PRINT_ASSET_JOBS) return;
  await adoptLegacyPrintAssetJobs(env);
  const due = await env.DB.prepare(`
    SELECT configured_product_id FROM print_asset_jobs
    WHERE status <> 'ready' AND next_attempt_at <= ?
    ORDER BY next_attempt_at, configured_product_id LIMIT ?
  `).bind(Date.now(), RECOVERY_BATCH).all<{ configured_product_id: string }>();
  // Small send batches bound connections and memory even during a backlog.
  for (let index = 0; index < due.results.length; index += 5) {
    await Promise.all(due.results.slice(index, index + 5)
      .map(row => deliverPrintAssetJob(env, row.configured_product_id)));
  }
}

export async function consumePrintAssetQueue(batch: MessageBatch, env: PrintAssetJobEnv) {
  const executorEnteredAtMs = Date.now();
  for (const message of batch.messages) {
    if (!isPrintMessage(message.body)) { message.ack(); continue; }
    const id = message.body.configuredProductId;
    if (usesDurablePrintExecution(env)) {
      try {
        await dispatchPrintExecution(env, id);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 15 });
      }
      continue;
    }
    const controlTable = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'native_video_release_control'").first();
    if (controlTable) {
      const control = await env.DB.prepare("SELECT paused FROM native_video_release_control WHERE singleton = 1")
        .first<{ paused: number }>();
      if (control?.paused !== 0) {
        message.retry({ delaySeconds: 15 });
        continue;
      }
    }
    const retryAt = await executePrintAssetFamily(env, id, {
      provider: "queue", executorEnteredAtMs,
      queueMessageTimestampMs: message.timestamp.getTime(), deliveryId: message.id,
    });
    if (retryAt !== undefined) message.retry({ delaySeconds: Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) });
    else message.ack();
  }
}

interface PrintFamilyExecution {
  readonly provider: "queue" | "durable-object";
  readonly executorEnteredAtMs: number;
  readonly queueMessageTimestampMs?: number;
  readonly deliveryId?: string;
  readonly revisionId?: string;
}

export async function executePrintAssetFamily(env: PrintAssetJobEnv, id: string, execution: PrintFamilyExecution): Promise<number | undefined> {
    const now = Date.now();
    const leaseId = crypto.randomUUID();
    const bounded = execution.provider === "durable-object";
    if (bounded && !execution.revisionId) throw new Error("Print execution requires an immutable revision.");
    const releaseId = env.PRINT_EXECUTION_RELEASE_ID;
    if (bounded) {
      if (!releaseId || !/^native-\d+$/.test(releaseId)) throw new Error("Print executor release identity is unavailable.");
      const control = await env.DB.prepare(`SELECT paused, current_release_id,
        (SELECT json_extract(payload, '$.worker.printExecutor.releaseId') FROM native_video_release_events
          WHERE release_id = current_release_id AND stage = 'verified') AS executor_generation
        FROM native_video_release_control WHERE singleton = 1`)
        .first<{ paused: number; current_release_id: string | null; executor_generation: string | null }>();
      if (!control) throw new Error("Print executor release control is unavailable.");
      if (control.paused !== 0) return now + 15_000;
      // A rollback has a new application release ID but may restore a historical
      // executor generation. Only its immutable, verified release event can
      // authorize that generation. A restored queue API omits it and retires
      // stale alarms while preserving the D1 outbox for queue recovery.
      if (control.executor_generation !== releaseId) return undefined;
    }
    const releaseFence = bounded ? `AND EXISTS (SELECT 1 FROM native_video_release_control control
      JOIN native_video_release_events event ON event.release_id = control.current_release_id AND event.stage = 'verified'
      WHERE control.singleton = 1 AND control.paused = 0
        AND json_extract(event.payload, '$.worker.printExecutor.releaseId') = ?)` : "";
    const admission = bounded ? `WITH eligible_families AS MATERIALIZED (${printAdmissionCandidatesSql})` : "";
    const priorityFence = bounded ? "AND sibling.design_revision_id IN (SELECT revision_id FROM eligible_families)" : "";
    const claimed = await env.DB.prepare(`
      ${admission}
      UPDATE print_asset_jobs SET status = 'running', lease_id = ?, next_attempt_at = ?,
        attempt_count = min(attempt_count + 1, 16), updated_at = ?
      WHERE configured_product_id IN (
        SELECT sibling.id FROM products AS sibling
        JOIN print_asset_jobs AS sibling_job ON sibling_job.configured_product_id = sibling.id
        WHERE sibling.design_revision_id = (
          SELECT design_revision_id FROM products WHERE id = ?
            AND (? IS NULL OR design_revision_id = ?)
        )
        AND (sibling_job.status = 'dispatched' OR
          (sibling_job.status IN ('pending', 'running') AND sibling_job.next_attempt_at <= ?))
        ${priorityFence}
        ORDER BY (sibling.id = ?) DESC, sibling.id LIMIT 2
      ) AND
        (status = 'dispatched' OR (status IN ('pending', 'running') AND next_attempt_at <= ?))
      ${releaseFence}
      RETURNING configured_product_id, attempt_count, created_at
    `).bind(...(bounded ? [now, now] : []), leaseId, now + PRINT_JOB_LEASE_MS, now, id, execution.revisionId ?? null,
      execution.revisionId ?? null, now, id, now,
      ...(bounded ? [releaseId ?? null] : [])).all<ClaimedPrintJob>();
    const claimedAtMs = Date.now();
    if (claimed.results.length === 0) {
      if (!bounded) return undefined;
      // An old outbox row may have lost its original alarm. Reserving priority
      // without restoring its wakeup would strand available execution slots.
      await wakeEligiblePrintFamilies(env, execution.revisionId);
      return nextPrintFamilyAttempt(env.DB, id, execution.revisionId);
    }
    // A quiet queue may run only one consumer. Claim the two products from the
    // same immutable revision together, retaining separate durable job leases.
    // Existing single-product messages remain valid through rollout/rollback.
    const context = createPrintAssetQueueContext(env, 4);
    const results = await Promise.allSettled(claimed.results.map(async job => {
      const productId = job.configured_product_id;
      const preparationStartedAtMs = Date.now();
      const timing = { schemaVersion: 1, event: "print_job_timing", productId, attemptId: leaseId,
        attempt: job.attempt_count, jobCreatedAtMs: job.created_at, claimStartedAtMs: now,
        claimedAtMs, preparationStartedAtMs, triggerProductId: id, ...execution };
      console.info("Print job started", { productId, attempt: job.attempt_count, waitMs: now - job.created_at });
      try {
        const active = await env.DB.prepare("SELECT id FROM products WHERE id = ? AND status = 'active'")
          .bind(productId).first();
        if (active) await ensureConfiguredProductPrintAssets(env, productId, "queue", context);
        const committed = await env.DB.prepare(`UPDATE print_asset_jobs SET status = 'ready', lease_id = NULL, updated_at = ?
          WHERE configured_product_id = ? AND lease_id = ?`)
          .bind(Date.now(), productId, leaseId).run();
        const finishedAtMs = Date.now();
        logPrintExecutionTiming({ ...timing, schemaVersion: 1, event: "print_job_timing", finishedAtMs,
          outcome: committed.meta.changes !== 1 ? "superseded" : active ? "ready" : "inactive",
          ...(committed.meta.changes === 1 && active ? { readyCommittedAtMs: finishedAtMs } : {}) });
        return undefined;
      } catch (error) {
        const capacityDeferred = isPrintMemoryCapacityError(error);
        const delaySeconds = capacityDeferred ? 0 : Math.min(15 * 2 ** (job.attempt_count - 1), 3600);
        await env.DB.prepare(`UPDATE print_asset_jobs SET status = 'pending', lease_id = NULL,
          attempt_count = max(0, attempt_count - ?), next_attempt_at = ?, updated_at = ?
          WHERE configured_product_id = ? AND lease_id = ?`)
          .bind(capacityDeferred ? 1 : 0, Date.now() + delaySeconds * 1000, Date.now(), productId, leaseId).run();
        const log = capacityDeferred ? console.warn : console.error;
        log("Print job deferred", { productId, attempt: job.attempt_count, delaySeconds, ...safeErrorDetails(error) });
        logPrintExecutionTiming({ ...timing, schemaVersion: 1, event: "print_job_timing",
          outcome: capacityDeferred ? "deferred" : "failed", finishedAtMs: Date.now() });
        return delaySeconds;
      }
    })).finally(() => { context.dispose(); });
    let delay: number | undefined;
    for (const result of results) {
      if (result.status === "rejected") throw new Error("Print job state could not be committed.", { cause: result.reason });
      if (result.value !== undefined) delay = Math.min(delay ?? result.value, result.value);
    }
    // Retrying this wakeup must also recover a failed sibling when its original
    // message arrived during the shared lease and was already acknowledged.
    return bounded ? nextPrintFamilyAttempt(env.DB, id, execution.revisionId)
      : delay === undefined ? undefined : Date.now() + delay * 1000;
}

async function wakeEligiblePrintFamilies(env: PrintAssetJobEnv, currentRevisionId: string | undefined) {
  const now = Date.now();
  const candidates = await env.DB.prepare(printAdmissionCandidatesSql).bind(now, now)
    .all<{ revision_id: string; product_id: string }>();
  const outcomes = await Promise.allSettled(candidates.results
    .filter(candidate => candidate.revision_id !== currentRevisionId)
    .map(candidate => dispatchPrintExecution({ ...env, PRINT_EXECUTION_MODE: "durable-object" }, candidate.product_id)));
  if (outcomes.some(outcome => outcome.status === "rejected")) {
    // The caller retains its bounded alarm retry; the D1 outbox remains durable.
    console.warn("Older print family wakeup deferred");
  }
}

async function nextPrintFamilyAttempt(db: D1Database, productId: string, revisionId: string | undefined) {
  const row = await db.prepare(`SELECT coalesce(
      max(CASE WHEN job.status = 'running' AND job.next_attempt_at > ? THEN job.next_attempt_at END),
      min(CASE WHEN job.status = 'dispatched' THEN 0 ELSE job.next_attempt_at END)) AS next_at
    FROM print_asset_jobs job JOIN products product ON product.id = job.configured_product_id
    WHERE product.design_revision_id = (SELECT design_revision_id FROM products WHERE id = ?)
      AND (? IS NULL OR product.design_revision_id = ?) AND job.status <> 'ready'`)
    .bind(Date.now(), productId, revisionId ?? null, revisionId ?? null).first<{ next_at: number | null }>();
  if (row?.next_at === null || row?.next_at === undefined) return undefined;
  return row.next_at <= Date.now() ? 0 : row.next_at;
}

function isPrintMessage(value: unknown): value is PrintAssetQueueMessage {
  return typeof value === "object" && value !== null && "configuredProductId" in value &&
    typeof value.configuredProductId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.configuredProductId);
}
