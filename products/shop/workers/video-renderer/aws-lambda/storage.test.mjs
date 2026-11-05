import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createStorage, singleRequestClient } from "./s3-storage.mjs";
import { ACCOUNT, BUCKET } from "./config.mjs";
import { sha256 } from "./contract.mjs";

class Command { constructor(input) { this.input = input; } }
const bytes = Buffer.from("test asset");
function storage(send) { return createStorage({ client: { send }, GetObjectCommand: Command, PutObjectCommand: Command }); }

test("S3 reads pin the bucket owner and bound/destroy the response stream", async () => {
  const stream = Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]);
  const result = await storage(async ({ input }, options) => {
    assert.equal(input.Bucket, BUCKET);
    assert.equal(input.ExpectedBucketOwner, ACCOUNT);
    assert.ok(options.abortSignal);
    return { Body: stream, ContentLength: bytes.length };
  }).read({ key: "inputs/artwork/test", size: bytes.length });
  assert.deepEqual(result, bytes);
  assert.equal(stream.destroyed, true);
});

test("S3 rejects missing, oversized and truncated assets without buffering unbounded data", async () => {
  for (const object of [
    { ContentLength: 1 },
    { ContentLength: 500, Body: Readable.from([bytes]) },
    { ContentLength: bytes.length, Body: Readable.from([Buffer.concat([bytes, bytes])]) },
    { ContentLength: bytes.length, Body: Readable.from([bytes.subarray(0, 3)]) },
  ]) {
    await assert.rejects(storage(async () => object).read({ key: "inputs/test", size: bytes.length }));
    if (object.Body) assert.equal(object.Body.destroyed, true);
  }
});

test("aborting an asset read destroys a stalled S3 body and releases the invocation", async () => {
  const controller = new AbortController();
  const stream = new Readable({ read() {} });
  const reading = storage(async () => ({ ContentLength: bytes.length, Body: stream }))
    .read({ key: "inputs/test", size: bytes.length }, { signal: controller.signal });
  const rejected = assert.rejects(reading, /aborted/);
  await new Promise(setImmediate);
  controller.abort();
  await rejected;
  assert.equal(stream.destroyed, true);
});

test("S3 output is conditional, checksum-verified, encrypted and owner-pinned", async () => {
  const hash = sha256(bytes);
  const result = await storage(async ({ input }, options) => {
    assert.equal(input.Bucket, BUCKET);
    assert.equal(input.ExpectedBucketOwner, ACCOUNT);
    assert.equal(input.IfNoneMatch, "*");
    assert.equal(input.ServerSideEncryption, "AES256");
    assert.equal(input.ContentType, "video/mp4");
    assert.equal(input.ChecksumSHA256, Buffer.from(hash, "hex").toString("base64"));
    assert.deepEqual(input.Body, bytes);
    assert.ok(options.abortSignal);
    return { ETag: "etag", ChecksumSHA256: input.ChecksumSHA256 };
  }).write({ key: "outputs/test", video: bytes, sha256: hash, jobDigest: "job", buildId: "build" });
  assert.deepEqual(result, { etag: "etag", sha256: hash });
  await assert.rejects(storage(async () => ({ ETag: "etag" })).write({ key: "outputs/test", video: bytes, sha256: hash }), /checksum/);
});

test("S3 conflicts and timeouts are not retried or treated as completed output", async () => {
  let calls = 0;
  await assert.rejects(storage(async () => { calls++; throw new Error("PreconditionFailed"); })
    .write({ key: "outputs/test", video: bytes, sha256: sha256(bytes) }), /PreconditionFailed/);
  assert.equal(calls, 1);
});

test("read and write clients remain separate so only idempotent reads may retry", async () => {
  const calls = [];
  const reader = { send: async () => { calls.push("read"); return { Body: Readable.from([bytes]), ContentLength: bytes.length }; } };
  const writer = { send: async ({ input }) => { calls.push("write"); return { ETag: "etag", ChecksumSHA256: input.ChecksumSHA256 }; } };
  const split = createStorage({ readClient: reader, writeClient: writer, GetObjectCommand: Command, PutObjectCommand: Command });
  await split.read({ key: "inputs/test", size: bytes.length });
  await split.write({ key: "outputs/test", video: bytes, sha256: sha256(bytes) });
  assert.deepEqual(calls, ["read", "write"]);
});

test("single-attempt write clients cannot reuse frozen sockets and always release connections", async () => {
  const calls = [];
  let created = 0;
  const client = singleRequestClient(() => {
    const id = ++created;
    return { send: async (command) => { calls.push(`send-${id}`); if (command.fail) throw new Error("failed"); return "stored"; },
      destroy: () => calls.push(`destroy-${id}`) };
  });
  assert.equal(await client.send({}), "stored");
  await assert.rejects(client.send({ fail: true }), /failed/);
  assert.deepEqual(calls, ["send-1", "destroy-1", "send-2", "destroy-2"]);
});

test("asset reads report actual SDK attempt and retry-delay evidence", async () => {
  let evidence;
  await storage(async () => ({ ContentLength: bytes.length, Body: Readable.from([bytes]),
    $metadata: { attempts: 2, totalRetryDelay: 45 } }))
    .read({ key: "inputs/test", size: bytes.length }, { onRequest: (value) => { evidence = value; } });
  assert.deepEqual(evidence, { attempts: 2, retryDelayMs: 45 });
});
