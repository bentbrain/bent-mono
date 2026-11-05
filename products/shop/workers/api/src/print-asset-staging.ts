import { createHash } from "node:crypto";
import { isPrintMemoryCapacityError, printBufferAdmission } from "./print-asset-memory.ts";

export const PRINT_STAGING_PREFIX = "print-assets/staging/v1/";
export const PRINT_STAGING_PART_BYTES = 5 * 1024 * 1024;
export const PRINT_MEMORY_TAIL_BYTES = 512 * 1024;
const STAGING_LEASE_MS = 16 * 60_000;
// The prefix-only R2 lifecycle expires objects/unknown multipart uploads after
// one day. Retain uncertain initialization inventory beyond that fallback.
const UNKNOWN_UPLOAD_RETENTION_MS = 2 * 24 * 60 * 60_000;
interface StagingEnv { readonly DB: D1Database; readonly DESIGN_ARTWORK: R2Bucket }
interface StageRow {
  id: string; attempt_id: string; storage_key: string; upload_id: string | null;
  state: string; created_at: number;
}
interface CleanupTimings {
  cleanupAbortMs: number;
  cleanupHeadMs: number;
  cleanupDeleteMs: number;
  cleanupInventoryMs: number;
}

async function measureCleanup<T>(
  timings: CleanupTimings | undefined, field: keyof CleanupTimings, operation: () => Promise<T>,
) {
  if (!timings) return operation();
  const start = performance.now();
  try { return await operation(); }
  finally { timings[field] += performance.now() - start; }
}
export interface EncodedPrint {
  readonly byteLength: number;
  stream(): Promise<ReadableStream<Uint8Array>>;
}
export interface StagedPrint extends EncodedPrint {
  stream(managedByCaller?: boolean): Promise<ReadableStream<Uint8Array>>;
  readonly sha256: string;
  readonly sha256Bytes: Uint8Array;
}

function validateStage(row: StageRow) {
  if (!/^[a-f0-9-]{36}$/u.test(row.id) || !/^[a-f0-9-]{36}$/u.test(row.attempt_id) ||
    row.storage_key !== `${PRINT_STAGING_PREFIX}${row.attempt_id}/${row.id}.png`) {
    throw new Error("Print staging inventory has an invalid identity.");
  }
}

async function removeStage(env: StagingEnv, row: StageRow, now: number, timings?: CleanupTimings) {
  validateStage(row);
  const uploadId = row.upload_id;
  if (uploadId && row.state !== "completed") {
    // Only positively acknowledged completion makes abort redundant. An
    // uncertain completion must still recover its known upload and object.
    try {
      await measureCleanup(timings, "cleanupAbortMs", () =>
        env.DESIGN_ARTWORK.resumeMultipartUpload(row.storage_key, uploadId).abort());
    }
    catch (error) {
      if (!await measureCleanup(timings, "cleanupHeadMs", () => env.DESIGN_ARTWORK.head(row.storage_key))) throw error;
    }
  }
  await measureCleanup(timings, "cleanupDeleteMs", () => env.DESIGN_ARTWORK.delete(row.storage_key));
  if (!row.upload_id && now - row.created_at < UNKNOWN_UPLOAD_RETENTION_MS) return false;
  await measureCleanup(timings, "cleanupInventoryMs", () =>
    env.DB.prepare("DELETE FROM print_asset_staging WHERE id = ? AND storage_key = ?")
      .bind(row.id, row.storage_key).run());
  return true;
}

async function forEachCleanup(rows: StageRow[], operation: (row: StageRow) => Promise<void>) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(3, rows.length) }, async () => {
    for (;;) {
      const row = rows[next++];
      if (!row) return;
      await operation(row);
    }
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

export async function cleanupPrintStaging(env: StagingEnv, now = Date.now()) {
  const rows = await env.DB.prepare(`SELECT id, attempt_id, storage_key, upload_id, state, created_at
    FROM print_asset_staging WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 50`)
    .bind(now).all<StageRow>();
  let removed = 0;
  let unresolvedInitialization = 0;
  let failed = 0;
  await forEachCleanup(rows.results, async row => {
    try {
      if (await removeStage(env, row, now)) removed += 1;
      else {
        unresolvedInitialization += 1;
        // Do not let one uncertain initialization starve the bounded sweep.
        await env.DB.prepare("UPDATE print_asset_staging SET expires_at = ? WHERE id = ?")
          .bind(now + 60 * 60_000, row.id).run();
      }
    } catch {
      failed += 1;
      // A persistent failure must not occupy every future bounded sweep.
      await env.DB.prepare("UPDATE print_asset_staging SET expires_at = ? WHERE id = ?")
        .bind(now + 60 * 60_000, row.id).run();
    }
  });
  return { removed, unresolvedInitialization, failed };
}

export function createPrintStagingSession(env: StagingEnv, configuredProductId: string, assetId: string) {
  const attemptId = crypto.randomUUID();
  const owned: StageRow[] = [];
  const activeStreams = new Set<Promise<void>>();
  const memoryInputs = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const memoryTails: { bytes: Uint8Array; release: () => void }[] = [];
  const timings = { inputReadMs: 0, intentMs: 0, createMs: 0, uploadIdMs: 0, uploadMs: 0,
    completeMs: 0, commitMs: 0, readMs: 0, cleanupMs: 0, stagedBytes: 0, stagedOutputs: 0,
    memoryBytes: 0, memoryOutputs: 0, cleanupStreamMs: 0, cleanupAbortMs: 0,
    cleanupHeadMs: 0, cleanupDeleteMs: 0, cleanupInventoryMs: 0 };
  const measure = async <T>(field: "inputReadMs" | "intentMs" | "createMs" | "uploadIdMs" |
    "uploadMs" | "completeMs" | "commitMs" | "readMs", operation: () => Promise<T>) => {
    const start = performance.now();
    try { return await operation(); }
    finally { timings[field] += performance.now() - start; }
  };
  const deadline = Date.now() + 15 * 60_000;
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => {
    for (const input of memoryInputs) input.error(controller.signal.reason);
    memoryInputs.clear();
  }, { once: true });
  const timer = setTimeout(() => { controller.abort(new Error("Print rendering session expired.")); }, 15 * 60_000);
  const assertActive = () => {
    if (controller.signal.aborted || Date.now() >= deadline) throw new Error("Print rendering session expired.");
  };
  const manageInput = (source: Pick<ReadableStream<Uint8Array>, "pipeTo">) => {
    const transfer = new IdentityTransformStream();
    const piping = source.pipeTo(transfer.writable, { signal: controller.signal });
    activeStreams.add(piping);
    void piping.catch(() => undefined).finally(() => activeStreams.delete(piping));
    return transfer.readable;
  };
  return {
    timings,
    assertActive,
    signal: controller.signal,
    async write(stream: ReadableStream<Uint8Array>, maxBytes: number, intermediate = false): Promise<StagedPrint> {
      const now = Date.now();
      const id = crypto.randomUUID();
      const key = `${PRINT_STAGING_PREFIX}${attemptId}/${id}.png`;
      const row: StageRow = { id, attempt_id: attemptId, storage_key: key, upload_id: null,
        state: "initializing", created_at: now };
      let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader | undefined;
      let releaseMemory: (() => void) | undefined;
      let releaseFallback: (() => void) | undefined;
      let releasePipeline: (() => void) | undefined;
      const uploads: Promise<R2UploadedPart>[] = [];
      const cancelOnExpiry = () => { void reader?.cancel().catch(() => undefined); };
      controller.signal.addEventListener("abort", cancelOnExpiry, { once: true });
      try {
        assertActive();
        let read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
        try {
          const byob = stream.getReader({ mode: "byob" });
          reader = byob;
          read = () => byob.read(new Uint8Array(64 * 1024));
        } catch {
          // Custom/fake non-byte streams cannot promise small chunks. Their
          // maximum permitted output must fit before the first read occurs.
          releaseFallback = printBufferAdmission.reserve(maxBytes);
          const ordinary = stream.getReader();
          reader = ordinary;
          read = () => ordinary.read();
        }
        const pending: Uint8Array[] = [];
        if (intermediate) {
          // Optional means never waiting for memory while holding a geometry slot.
          // Retain one fixed allocation, not a growing chunk list or stream tee.
          try { releaseMemory = printBufferAdmission.reserve(PRINT_MEMORY_TAIL_BYTES); }
          catch (error) { if (!isPrintMemoryCapacityError(error)) throw error; }
          if (releaseMemory) {
            const bytes = new Uint8Array(PRINT_MEMORY_TAIL_BYTES);
            let length = 0;
            for (;;) {
              assertActive();
              const next = await measure("inputReadMs", read);
              assertActive();
              if (next.done) {
                if (!length) throw new Error("Rendered print asset is empty.");
                const retained = { bytes: bytes.subarray(0, length), release: releaseMemory };
                memoryTails.push(retained);
                releaseMemory = undefined;
                timings.memoryOutputs += 1; timings.memoryBytes += length;
                const digest = createHash("sha256").update(retained.bytes).digest();
                return { byteLength: length, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join(""), sha256Bytes: new Uint8Array(digest),
                  stream() {
                    assertActive();
                    let sent = false;
                    return Promise.resolve(new ReadableStream<Uint8Array>({
                      start(controller) { memoryInputs.add(controller); },
                      pull(controller) {
                        if (sent) controller.close();
                        else { sent = true; controller.enqueue(retained.bytes); }
                      },
                    }, { highWaterMark: 0 }));
                  },
                };
              }
              if (length + next.value.byteLength > maxBytes) throw new Error("Rendered print asset exceeds the storage limit.");
              if (length + next.value.byteLength > bytes.byteLength) {
                // The prefix and current bounded chunk enter the existing writer;
                // no reread, re-encode or unbounded concatenation on overflow.
                if (length) pending.push(bytes.subarray(0, length));
                pending.push(next.value);
                break;
              }
              bytes.set(next.value, length); length += next.value.byteLength;
            }
          }
        }
        // Record intent before R2 initialization, including an immutable exact key.
        await measure("intentMs", () => env.DB.prepare(`INSERT INTO print_asset_staging
          (id, attempt_id, configured_product_id, asset_id, storage_key, state, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, 'initializing', ?, ?)`)
          .bind(id, attemptId, configuredProductId, assetId, key, now, now + STAGING_LEASE_MS).run());
        owned.push(row);
        const upload = await measure("createMs", () => env.DESIGN_ARTWORK.createMultipartUpload(key, {
          httpMetadata: { contentType: "image/png", cacheControl: "private, no-store" },
          customMetadata: { stagingAttemptId: attemptId, stagingVersion: "1" },
        }));
        row.upload_id = upload.uploadId;
        row.state = "uploading";
        await measure("uploadIdMs", () => env.DB.prepare("UPDATE print_asset_staging SET upload_id = ?, state = 'uploading' WHERE id = ?")
          .bind(upload.uploadId, id).run());
        const parts: R2UploadedPart[] = [];
        let byteLength = 0;
        const digest = createHash("sha256");
        // Buffer references end here before the multipart completion and commit.
        {
          let part = new Uint8Array(PRINT_STAGING_PART_BYTES);
          let alternate: Uint8Array<ArrayBuffer> | null = null;
          const flushParts = async () => {
            const results = await Promise.allSettled(uploads);
            uploads.length = 0;
            for (const result of results) {
              if (result.status === "rejected") throw result.reason;
              parts.push(result.value);
            }
          };
          const queuePart = (bytes: Uint8Array) => {
            const number = parts.length + uploads.length + 1;
            const pending = measure("uploadMs", () => upload.uploadPart(number, bytes));
            // Observe rejection immediately while the next bounded part is read.
            void pending.catch(() => undefined);
            uploads.push(pending);
          };
          let filled = 0;
          for (;;) {
            assertActive();
            const prefix = pending.shift();
            const next = prefix ? { done: false, value: prefix } : await measure("inputReadMs", read);
            assertActive();
            if (next.done) break;
            byteLength += next.value.byteLength;
            if (byteLength > maxBytes) throw new Error("Rendered print asset exceeds the storage limit.");
            digest.update(next.value);
            let offset = 0;
            while (offset < next.value.byteLength) {
              const size = Math.min(part.byteLength - filled, next.value.byteLength - offset);
              part.set(next.value.subarray(offset, offset + size), filled);
              filled += size;
              offset += size;
              if (filled === part.byteLength) {
                assertActive();
                if (parts.length === 0 && uploads.length === 0) {
                  // Admit an optional second buffer only once a full part needs
                  // uploading. Small outputs consume no additional shared bytes.
                  try { releasePipeline = printBufferAdmission.reserve(PRINT_STAGING_PART_BYTES); }
                  catch (error) { if (!isPrintMemoryCapacityError(error)) throw error; }
                  if (releasePipeline) alternate = new Uint8Array(PRINT_STAGING_PART_BYTES);
                }
                queuePart(part);
                if (uploads.length === (alternate ? 2 : 1)) await flushParts();
                // Only the other admitted buffer can be filled during upload.
                // Both acknowledgements precede reuse of either buffer.
                if (alternate) { const previous = part; part = alternate; alternate = previous; }
                filled = 0;
              }
            }
          }
          if (byteLength === 0) throw new Error("Rendered print asset is empty.");
          if (filled) queuePart(part.subarray(0, filled));
          await flushParts();
        }
        assertActive();
        const completed = await measure("completeMs", () => upload.complete(parts));
        assertActive();
        row.state = "completed";
        await measure("commitMs", () => env.DB.prepare("UPDATE print_asset_staging SET state = 'completed' WHERE id = ?")
          .bind(id).run());
        if (completed.size !== byteLength) throw new Error("Staged print asset has an invalid length.");
        timings.stagedOutputs += 1; timings.stagedBytes += byteLength;
        const sha256Bytes = new Uint8Array(digest.digest());
        const sha256 = Array.from(sha256Bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        return {
          byteLength, sha256, sha256Bytes,
          async stream(managedByCaller = false) {
            assertActive();
            const object = await measure("readMs", () => env.DESIGN_ARTWORK.get(key));
            if (object?.size !== byteLength) {
              await object?.body.cancel();
              throw new Error("Staged print asset is unavailable.");
            }
            try { assertActive(); }
            catch (error) { await object.body.cancel(); throw error; }
            if (managedByCaller) return object.body;
            // Images may hold this input while executing remotely. A native
            // identity pipe lets session expiry cancel its R2 source even if
            // the provider has locked the readable side.
            return manageInput(object.body);
          },
        };
      } catch (error) {
        if (reader) await reader.cancel().catch(() => undefined);
        else await stream.cancel().catch(() => undefined);
        throw error;
      } finally {
        controller.signal.removeEventListener("abort", cancelOnExpiry);
        // A failed read/part must not release its memory or let disposal abort
        // the upload while another admitted part still owns bytes.
        await Promise.allSettled(uploads);
        releasePipeline?.();
        reader?.releaseLock(); releaseFallback?.(); releaseMemory?.();
      }
    },
    async dispose() {
      const cleanupStart = performance.now();
      clearTimeout(timer);
      controller.abort();
      await Promise.allSettled(activeStreams);
      activeStreams.clear();
      timings.cleanupStreamMs += performance.now() - cleanupStart;
      for (const retained of memoryTails) {
        retained.bytes = new Uint8Array(0); retained.release();
      }
      memoryTails.length = 0;
      let failed = 0;
      let unresolvedInitialization = 0;
      await forEachCleanup(owned, async row => {
        try { if (!await removeStage(env, row, Date.now(), timings)) unresolvedInitialization += 1; }
        catch { failed += 1; }
      });
      owned.length = 0;
      timings.cleanupMs += performance.now() - cleanupStart;
      if (failed || unresolvedInitialization) {
        console.warn("Print staging cleanup deferred", { failed, unresolvedInitialization });
      }
    },
  };
}

// FixedLengthStream establishes the storage length without buffering. R2 checks
// the supplied SHA against the copied bytes before this immutable object exists.
export async function publishStagedPrint(bucket: R2Bucket, key: string, rendered: StagedPrint, signal: AbortSignal) {
  signal.throwIfAborted();
  const source = await rendered.stream(true);
  if (signal.aborted) { await source.cancel(); signal.throwIfAborted(); }
  const transfer = new FixedLengthStream(rendered.byteLength);
  const copyController = new AbortController();
  const abortCopy = () => { copyController.abort(signal.reason); };
  signal.addEventListener("abort", abortCopy, { once: true });
  try {
    const copying = source.pipeTo(transfer.writable, { signal: copyController.signal }).catch(async (error: unknown) => {
      // A rejected pump must also wake R2's reader; otherwise its put can wait
      // indefinitely for bytes from a source that has already failed.
      await transfer.writable.abort(error).catch(() => undefined);
      throw error;
    });
    const storing = bucket.put(key, transfer.readable, {
      httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { sha256: rendered.sha256 },
      sha256: rendered.sha256Bytes,
    }).catch((error: unknown) => { copyController.abort(error); throw error; });
    const results = await Promise.allSettled([copying, storing]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", abortCopy); }
}
