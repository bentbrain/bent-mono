import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { createPrintBufferAdmission, isPrintMemoryCapacityError, PrintMemoryCapacityError, printBufferAdmission } from "./print-asset-memory";
import { createPrintAssetQueueContext } from "./print-assets";
import { cleanupPrintStaging, createPrintStagingSession, PRINT_MEMORY_TAIL_BYTES, PRINT_STAGING_PART_BYTES, PRINT_STAGING_PREFIX } from "./print-asset-staging";

let platform: PlatformProxy<Env> | undefined;
function env() { if (!platform) throw new Error("Test platform missing."); return platform.env; }
beforeAll(async () => {
  vi.stubGlobal("IdentityTransformStream", TransformStream);
  platform = await getPlatformProxy<Env>({ configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
    persist: false, remoteBindings: false });
  const sql = await readFile(new URL("../drizzle/0038_print_staging.sql", import.meta.url), "utf8");
  await env().DB.batch(sql.split("--> statement-breakpoint").map(statement => env().DB.prepare(statement)));
}, 30_000);
beforeEach(async () => {
  await env().DB.prepare("DELETE FROM print_asset_staging").run();
  const objects = await env().DESIGN_ARTWORK.list({ prefix: PRINT_STAGING_PREFIX });
  if (objects.objects.length) await env().DESIGN_ARTWORK.delete(objects.objects.map(object => object.key));
  expect(printBufferAdmission.occupied).toBe(0);
});
afterAll(async () => { await platform?.dispose(); });

it("refuses before exceeding the shared budget and releases once through nested errors", () => {
  const pool = createPrintBufferAdmission(100);
  const release = pool.reserve(70);
  expect(() => pool.reserve(31)).toThrow(PrintMemoryCapacityError);
  expect(pool.occupied).toBe(70);
  release(); release();
  expect(pool.occupied).toBe(0);
  expect(isPrintMemoryCapacityError(new Error("batch", { cause: new Error("asset", { cause: new PrintMemoryCapacityError() }) }))).toBe(true);
  const cycle = new Error("cycle"); cycle.cause = cycle;
  expect(isPrintMemoryCapacityError(cycle)).toBe(false);
});

it("streams uniform multipart parts, hashes exactly and removes all staging objects", async () => {
  const input = new Uint8Array(PRINT_STAGING_PART_BYTES * 2 + 97);
  input.forEach((_, index) => { input[index] = index % 251; });
  const partSizes: number[] = [];
  const original = env().DESIGN_ARTWORK;
  const bucket = new Proxy(original, {
    get(target, property) {
      if (property === "createMultipartUpload") return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
        const upload = await target.createMultipartUpload(...args);
        return new Proxy(upload, { get(inner, key) {
          if (key === "uploadPart") return async (number: number, value: Uint8Array) => {
            partSizes.push(value.byteLength);
            return inner.uploadPart(number, value);
          };
          const reflected: unknown = Reflect.get(inner, key); return reflected;
        } });
      };
      const reflected: unknown = Reflect.get(target, property); return reflected;
    },
  });
  const session = createPrintStagingSession({ ...env(), DESIGN_ARTWORK: bucket }, "product", "asset");
  const response = new Response(input);
  if (!response.body) throw new Error("Missing body");
  const output = await session.write(response.body, input.length);
  expect(partSizes).toEqual([PRINT_STAGING_PART_BYTES, PRINT_STAGING_PART_BYTES, 97]);
  expect(output.sha256).toBe(createHash("sha256").update(input).digest("hex"));
  const storedBytes = new Uint8Array(await new Response(await output.stream()).arrayBuffer());
  expect(storedBytes.byteLength).toBe(input.byteLength);
  // Deep equality enumerates ten million typed-array keys and exhausts CI's
  // heap. TypedArray.every checks every byte without allocating those keys.
  expect(storedBytes.every((byte, index) => byte === input[index])).toBe(true);
  expect(printBufferAdmission.occupied).toBe(0);
  await session.dispose();
  expect((await original.list({ prefix: PRINT_STAGING_PREFIX })).objects).toHaveLength(0);
  expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(0);
}, 30_000);

it("cancels oversize output and aborts its known multipart upload", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel });
  const session = createPrintStagingSession(env(), "product", "asset");
  await expect(session.write(stream, 32)).rejects.toThrow("storage limit");
  expect(cancel).toHaveBeenCalledOnce();
  expect(printBufferAdmission.occupied).toBe(0);
  await session.dispose();
  expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(0);
});

it("cancels an Images output when durable staging intent cannot be recorded", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel });
  const db = new Proxy(env().DB, { get(target, key) {
    if (key === "prepare") return () => { throw new Error("D1 unavailable"); };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DB: db }, "product", "asset");
  await expect(session.write(stream, 32)).rejects.toThrow("D1 unavailable");
  expect(cancel).toHaveBeenCalledOnce();
  expect(printBufferAdmission.occupied).toBe(0);
  await session.dispose();
});

it("retains a lost initialization acknowledgement for lifecycle fallback", async () => {
  const bucket = new Proxy(env().DESIGN_ARTWORK, { get(target, key) {
    if (key === "createMultipartUpload") return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
      await target.createMultipartUpload(...args);
      throw new Error("Lost init acknowledgement");
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DESIGN_ARTWORK: bucket }, "deleted-product", "deleted-asset");
  const response = new Response(new Uint8Array([1]));
  if (!response.body) throw new Error("Missing body");
  await expect(session.write(response.body, 32)).rejects.toThrow("Lost init acknowledgement");
  await session.dispose();
  const row = await env().DB.prepare("SELECT state, upload_id FROM print_asset_staging").first();
  expect(row).toEqual({ state: "initializing", upload_id: null });
  expect(await cleanupPrintStaging(env(), Date.now() + 17 * 60_000)).toEqual({ removed: 0, failed: 0, unresolvedInitialization: 1 });
  expect(await cleanupPrintStaging(env(), Date.now() + 3 * 24 * 60 * 60_000)).toEqual({ removed: 1, failed: 0, unresolvedInitialization: 0 });
});

it("does not sweep an active stage and later recovers completed abandoned stages", async () => {
  const session = createPrintStagingSession(env(), "product", "asset");
  const response = new Response(new Uint8Array([1, 2, 3]));
  if (!response.body) throw new Error("Missing body");
  await session.write(response.body, 32);
  expect(await cleanupPrintStaging(env())).toEqual({ removed: 0, failed: 0, unresolvedInitialization: 0 });
  expect(await cleanupPrintStaging(env(), Date.now() + 17 * 60_000)).toEqual({ removed: 1, failed: 0, unresolvedInitialization: 0 });
  await session.dispose();
});

it("lets independent admitted families progress while extra geometry waits on its own slot", async () => {
  const sourceBytes = new Uint8Array([1, 2, 3]);
  const sha = createHash("sha256").update(sourceBytes).digest("hex");
  await env().DESIGN_ARTWORK.put("test-source", sourceBytes);
  const contexts = [createPrintAssetQueueContext(env()), createPrintAssetQueueContext(env()), createPrintAssetQueueContext(env())];
  await Promise.all(contexts.map(context => context.readSource({ artwork_key: "test-source", artwork_sha256: sha, byte_size: sourceBytes.length })));
  const releasePressure = printBufferAdmission.reserve(96 * 1024 * 1024 - printBufferAdmission.occupied);
  let releaseFirst: (() => void) | undefined;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started: string[] = [];
  const first = contexts[0]; const second = contexts[1]; const third = contexts[2];
  if (!first || !second || !third) throw new Error("Missing contexts");
  const work = [first.runGeometry(async () => { started.push("first"); await held; }),
    first.runGeometry(() => { started.push("first-next"); return Promise.resolve(); }),
    second.runGeometry(() => { started.push("second"); return Promise.resolve(); }),
    third.runGeometry(() => { started.push("third"); return Promise.resolve(); })];
  await Promise.resolve();
  expect(started).toEqual(["first", "second", "third"]);
  expect(() => { first.dispose(); }).toThrow("before renders settled");
  releaseFirst?.();
  await Promise.all(work);
  expect(started).toEqual(["first", "second", "third", "first-next"]);
  contexts.forEach(context => { context.dispose(); });
  releasePressure();
  expect(printBufferAdmission.occupied).toBe(0);
});


it("recovers a lost completion acknowledgement by removing the known exact staged object", async () => {
  const bucket = new Proxy(env().DESIGN_ARTWORK, { get(target, key) {
    if (key === "createMultipartUpload") return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
      const upload = await target.createMultipartUpload(...args);
      return new Proxy(upload, { get(inner, property) {
        if (property === "complete") return async (parts: R2UploadedPart[]) => {
          await inner.complete(parts);
          throw new Error("Lost completion acknowledgement");
        };
        const reflected: unknown = Reflect.get(inner, property); return reflected;
      } });
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DESIGN_ARTWORK: bucket }, "product", "asset");
  const response = new Response(new Uint8Array([1, 2, 3]));
  if (!response.body) throw new Error("Missing body");
  await expect(session.write(response.body, 32)).rejects.toThrow("Lost completion acknowledgement");
  expect((await env().DESIGN_ARTWORK.list({ prefix: PRINT_STAGING_PREFIX })).objects).toHaveLength(1);
  await session.dispose();
  expect((await env().DESIGN_ARTWORK.list({ prefix: PRINT_STAGING_PREFIX })).objects).toHaveLength(0);
  expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(0);
});

it("rejects late reads and output before the staging cleanup lease expires", async () => {
  const start = Date.now();
  const session = createPrintStagingSession(env(), "product", "asset");
  const response = new Response(new Uint8Array([1, 2, 3]));
  if (!response.body) throw new Error("Missing body");
  const staged = await session.write(response.body, 32);
  const now = vi.spyOn(Date, "now").mockReturnValue(start + 15 * 60_000 + 1);
  const cancel = vi.fn();
  try {
    await expect(staged.stream()).rejects.toThrow("session expired");
    await expect(session.write(new ReadableStream({ cancel }), 32)).rejects.toThrow("session expired");
    expect(cancel).toHaveBeenCalledOnce();
    expect(() => { session.assertActive(); }).toThrow("session expired");
  } finally { now.mockRestore(); await session.dispose(); }
});

it("skips abort for positively completed uploads and cleans independent stages with bounded overlap", async () => {
  const abort = vi.fn();
  let active = 0;
  let peak = 0;
  let releaseDeletes: (() => void) | undefined;
  const deletesAllowed = new Promise<void>(resolve => { releaseDeletes = resolve; });
  let threeStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { threeStarted = resolve; });
  const bucket = new Proxy(env().DESIGN_ARTWORK, { get(target, key) {
    if (key === "resumeMultipartUpload") return (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
      abort(); return target.resumeMultipartUpload(...args);
    };
    if (key === "delete") return async (...args: Parameters<R2Bucket["delete"]>) => {
      active += 1; peak = Math.max(peak, active);
      if (active === 3) threeStarted?.();
      try { await deletesAllowed; await target.delete(...args); }
      finally { active -= 1; }
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DESIGN_ARTWORK: bucket }, "product", "asset");
  for (let i = 0; i < 7; i++) {
    const response = new Response(new Uint8Array([1, 2, i]));
    if (!response.body) throw new Error("Missing body");
    await session.write(response.body, 32);
  }
  const cleanup = session.dispose();
  try {
    await Promise.race([started, new Promise<void>(resolve => setTimeout(resolve, 100))]);
    expect(peak).toBe(3);
    expect(abort).not.toHaveBeenCalled();
  } finally { releaseDeletes?.(); await cleanup; }
  expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(0);
});


it.each([1, PRINT_MEMORY_TAIL_BYTES, PRINT_MEMORY_TAIL_BYTES + 1])("keeps only bounded small intermediates in memory and preserves exact overflow bytes (%i)", async size => {
  const input = new Uint8Array(size);
  input.forEach((_, index) => { input[index] = index % 251; });
  const session = createPrintStagingSession(env(), "product", "asset");
  try {
    const response = new Response(input);
    if (!response.body) throw new Error("Missing body");
    const output = await session.write(response.body, size, true);
    expect(output.sha256).toBe(createHash("sha256").update(input).digest("hex"));
    const bytes = new Uint8Array(await new Response(await output.stream()).arrayBuffer());
    expect(bytes.length).toBe(input.length);
    expect(bytes.every((byte, index) => byte === input[index])).toBe(true);
    const small = size <= PRINT_MEMORY_TAIL_BYTES;
    expect(printBufferAdmission.occupied).toBe(small ? PRINT_MEMORY_TAIL_BYTES : 0);
    expect(session.timings.memoryOutputs).toBe(small ? 1 : 0);
    expect(session.timings.stagedOutputs).toBe(small ? 0 : 1);
    expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(small ? 0 : 1);
  } finally { await session.dispose(); }
  expect(printBufferAdmission.occupied).toBe(0);
});

it("falls back immediately when optional tail memory is occupied and retains no extra reservation", async () => {
  const input = new Uint8Array([1, 2, 3]);
  // Node Response bodies need an ingress reservation of maxBytes. Leave that
  // mandatory capacity available but no optional tail buffer.
  const releasePressure = printBufferAdmission.reserve(96 * 1024 * 1024 - input.length);
  const session = createPrintStagingSession(env(), "product", "asset");
  try {
    const response = new Response(input);
    if (!response.body) throw new Error("Missing body");
    const output = await session.write(response.body, input.length, true);
    expect(output.sha256).toBe(createHash("sha256").update(input).digest("hex"));
    expect(session.timings.memoryOutputs).toBe(0);
    expect(session.timings.stagedOutputs).toBe(1);
  } finally { await session.dispose(); releasePressure(); }
  expect(printBufferAdmission.occupied).toBe(0);
});

it("holds optional tails until locked provider inputs are cancelled and invalidates old output handles", async () => {
  const session = createPrintStagingSession(env(), "product", "asset");
  const response = new Response(new Uint8Array([1, 2, 3]));
  if (!response.body) throw new Error("Missing body");
  const output = await session.write(response.body, 32, true);
  const stream = await output.stream();
  const reader = stream.getReader();
  expect(printBufferAdmission.occupied).toBe(PRINT_MEMORY_TAIL_BYTES);
  await session.dispose();
  reader.releaseLock();
  expect(printBufferAdmission.occupied).toBe(0);
  expect(() => output.stream()).toThrow("session expired");
});

it("cleans other completed stages after one exact deletion fails, retaining only the failed inventory", async () => {
  let deleted = 0;
  const bucket = new Proxy(env().DESIGN_ARTWORK, { get(target, key) {
    if (key === "delete") return (...args: Parameters<R2Bucket["delete"]>) => {
      if (++deleted === 1) return Promise.reject(new Error("Deletion unavailable"));
      return target.delete(...args);
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DESIGN_ARTWORK: bucket }, "product", "asset");
  for (let i = 0; i < 4; i++) {
    const response = new Response(new Uint8Array([1, 2, i]));
    if (!response.body) throw new Error("Missing body");
    await session.write(response.body, 32);
  }
  await session.dispose();
  expect(deleted).toBe(4);
  expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(1);
  expect(await cleanupPrintStaging(env(), Date.now() + 17 * 60_000)).toEqual({ removed: 1, failed: 0, unresolvedInitialization: 0 });
});

it.each([false, true])("distinguishes storage and inventory cleanup time while retaining failed deletion evidence (%s)", async failDeletion => {
  let clock = 0;
  const bucket = new Proxy(env().DESIGN_ARTWORK, { get(target, key) {
    if (key === "delete") return (...args: Parameters<R2Bucket["delete"]>) => {
      clock += 40;
      if (failDeletion) return Promise.reject(new Error("Deletion unavailable"));
      return target.delete(...args);
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const db = new Proxy(env().DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      if (sql.startsWith("DELETE FROM print_asset_staging")) clock += 70;
      return target.prepare(sql);
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DB: db, DESIGN_ARTWORK: bucket }, "product", "asset");
  const response = new Response(new Uint8Array([1, 2, 3]));
  if (!response.body) throw new Error("Missing body");
  await session.write(response.body, 32);
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    await session.dispose();
    expect(session.timings).toMatchObject({ cleanupMs: failDeletion ? 40 : 110,
      cleanupStreamMs: 0, cleanupAbortMs: 0, cleanupHeadMs: 0,
      cleanupDeleteMs: 40, cleanupInventoryMs: failDeletion ? 0 : 70 });
    expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(failDeletion ? 1 : 0);
    expect((await env().DESIGN_ARTWORK.list({ prefix: PRINT_STAGING_PREFIX })).objects).toHaveLength(failDeletion ? 1 : 0);
  } finally {
    now.mockRestore();
    await cleanupPrintStaging(env(), Date.now() + 17 * 60_000);
  }
});

it.each([0, 33])("rejects invalid small intermediates without retaining memory or staging intent (%i bytes)", async size => {
  const session = createPrintStagingSession(env(), "product", "asset");
  try {
    const response = new Response(new Uint8Array(size));
    if (!response.body) throw new Error("Missing body");
    await expect(session.write(response.body, 32, true)).rejects.toThrow(size ? "storage limit" : "empty");
    expect(printBufferAdmission.occupied).toBe(0);
    expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(0);
  } finally { await session.dispose(); }
});


it("pipelines at most two admitted multipart parts without reusing unacknowledged bytes", async () => {
  const input = new Uint8Array(PRINT_STAGING_PART_BYTES * 2 + 97);
  input.forEach((_, index) => { input[index] = index % 251; });
  let releaseFirst: (() => void) | undefined;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  let active = 0, peak = 0, firstAcknowledged = false, overlapped = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bucket = new Proxy(env().DESIGN_ARTWORK, { get(target, key) {
    if (key === "createMultipartUpload") return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
      const upload = await target.createMultipartUpload(...args);
      return new Proxy(upload, { get(inner, property) {
        if (property === "uploadPart") return async (number: number, bytes: Uint8Array) => {
          active += 1; peak = Math.max(peak, active);
          const checksum = createHash("sha256").update(bytes).digest("hex");
          try {
            if (number === 1) { timeout = setTimeout(() => { releaseFirst?.(); }, 1000); await held; }
            if (number === 2) { overlapped = !firstAcknowledged; releaseFirst?.(); }
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(checksum);
            const result = await inner.uploadPart(number, bytes);
            if (number === 1) firstAcknowledged = true;
            return result;
          } finally { active -= 1; }
        };
        const reflected: unknown = Reflect.get(inner, property); return reflected;
      } });
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DESIGN_ARTWORK: bucket }, "product", "asset");
  try {
    const body = new Response(input).body;
    if (!body) throw new Error("Missing body");
    const output = await session.write(body, input.byteLength);
    expect(output.sha256).toBe(createHash("sha256").update(input).digest("hex"));
    const stored = new Uint8Array(await new Response(await output.stream()).arrayBuffer());
    expect(stored.every((byte, index) => byte === input[index])).toBe(true);
    expect(overlapped).toBe(true);
    expect(peak).toBe(2);
    expect(printBufferAdmission.occupied).toBe(0);
  } finally { clearTimeout(timeout); releaseFirst?.(); await session.dispose(); }
});


it("retains serial multipart progress when no extra buffer fits the shared ceiling", async () => {
  const releasePressure = printBufferAdmission.reserve(96 * 1024 * 1024);
  let active = 0, peak = 0;
  const bucket = new Proxy(env().DESIGN_ARTWORK, { get(target, key) {
    if (key === "createMultipartUpload") return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
      const upload = await target.createMultipartUpload(...args);
      return new Proxy(upload, { get(inner, property) {
        if (property === "uploadPart") return async (number: number, bytes: Uint8Array) => {
          active += 1; peak = Math.max(peak, active);
          try { return await inner.uploadPart(number, bytes); }
          finally { active -= 1; }
        };
        const reflected: unknown = Reflect.get(inner, property); return reflected;
      } });
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DESIGN_ARTWORK: bucket }, "product", "asset");
  const input = new Uint8Array(PRINT_STAGING_PART_BYTES * 2 + 97);
  try {
    const body = new Response(input).body;
    if (!body) throw new Error("Missing body");
    const output = await session.write(body, input.byteLength);
    expect(output.sha256).toBe(createHash("sha256").update(input).digest("hex"));
    expect(peak).toBe(1);
    expect(printBufferAdmission.occupied).toBe(96 * 1024 * 1024);
  } finally { await session.dispose(); releasePressure(); }
  expect(printBufferAdmission.occupied).toBe(0);
});

it("settles every started part before releasing memory or aborting after an upload failure", async () => {
  let failFirst: (() => void) | undefined, releaseSecond: (() => void) | undefined, startedSecond: (() => void) | undefined;
  const first = new Promise<void>(resolve => { failFirst = resolve; });
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  const started = new Promise<void>(resolve => { startedSecond = resolve; });
  let active = 0, aborts = 0, settled = false;
  const bucket = new Proxy(env().DESIGN_ARTWORK, { get(target, key) {
    if (key === "resumeMultipartUpload") return (...args: Parameters<R2Bucket["resumeMultipartUpload"]>) => {
      const upload = target.resumeMultipartUpload(...args);
      return new Proxy(upload, { get(inner, property) {
        if (property === "abort") return async () => { expect(active).toBe(0); aborts += 1; await inner.abort(); };
        const reflected: unknown = Reflect.get(inner, property); return reflected;
      } });
    };
    if (key === "createMultipartUpload") return async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
      const upload = await target.createMultipartUpload(...args);
      return new Proxy(upload, { get(inner, property) {
        if (property === "uploadPart") return async (number: number, bytes: Uint8Array) => {
          active += 1;
          try {
            if (number === 1) { await first; throw new Error("First part rejected"); }
            startedSecond?.(); await second;
            return await inner.uploadPart(number, bytes);
          } finally { active -= 1; }
        };
        const reflected: unknown = Reflect.get(inner, property); return reflected;
      } });
    };
    const reflected: unknown = Reflect.get(target, key); return reflected;
  } });
  const session = createPrintStagingSession({ ...env(), DESIGN_ARTWORK: bucket }, "product", "asset");
  const body = new Response(new Uint8Array(PRINT_STAGING_PART_BYTES * 2)).body;
  if (!body) throw new Error("Missing body");
  const writing = session.write(body, PRINT_STAGING_PART_BYTES * 2);
  void writing.then(() => { settled = true; }, () => { settled = true; });
  try {
    await started;
    failFirst?.();
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(settled).toBe(false);
    expect(printBufferAdmission.occupied).toBe(PRINT_STAGING_PART_BYTES);
    expect(aborts).toBe(0);
    releaseSecond?.();
    await expect(writing).rejects.toThrow("First part rejected");
    expect(printBufferAdmission.occupied).toBe(0);
  } finally { failFirst?.(); releaseSecond?.(); await writing.catch(() => undefined); await session.dispose(); }
  expect(aborts).toBe(1);
  expect((await env().DB.prepare("SELECT * FROM print_asset_staging").all()).results).toHaveLength(0);
});


it("does not reserve a second multipart buffer for a single-part output", async () => {
  const reserve = vi.spyOn(printBufferAdmission, "reserve");
  const session = createPrintStagingSession(env(), "product", "asset");
  try {
    const body = new Response(new Uint8Array([1, 2, 3])).body;
    if (!body) throw new Error("Missing body");
    await session.write(body, 3);
    expect(reserve).not.toHaveBeenCalled();
  } finally { reserve.mockRestore(); await session.dispose(); }
});
