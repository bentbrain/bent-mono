import assert from "node:assert/strict";
import test from "node:test";
import { runBatch, streamingBatch } from "./batch.mjs";

test("publishes committed videos before the batch finishes, with two bounded lanes", async () => {
  const release = Promise.withResolvers();
  const first = Promise.withResolvers();
  const published = [];
  const active = new Set();
  let peak = 0;
  const running = runBatch({
    jobs: [0, 1, 2, 3].map((key) => ({ key })),
    concurrency: 2,
    cached: async () => undefined,
    render: async (job, lane) => {
      assert.equal(active.has(lane), false);
      active.add(lane);
      peak = Math.max(peak, active.size);
      await Promise.resolve();
      if (job.key > 0) await release.promise;
      active.delete(lane);
      return { key: job.key, size: 100 };
    },
    ready: (result) => { published.push(result.key); first.resolve(); },
  });
  await first.promise;
  assert.deepEqual(published, [0]);
  release.resolve();
  const result = await running;
  assert.equal(peak, 2);
  assert.equal(result.results.length, 4);
  assert.deepEqual(result.failures, []);
});

test("cache hits skip rendering and one failed encode does not discard the others", async () => {
  const rendered = [];
  const result = await runBatch({
    jobs: [0, 1, 2, 3].map((key) => ({ key })),
    concurrency: 2,
    cached: async (job) => job.key === 0 ? { key: 0, size: 100 } : undefined,
    render: async (job) => {
      rendered.push(job.key);
      if (job.key === 1) throw new Error("encoder failed");
      return { key: job.key, size: 100 };
    },
    ready() {},
  });
  assert.deepEqual(rendered.sort(), [1, 2, 3]);
  assert.deepEqual(result.results.map((item) => item.key).sort(), [0, 2, 3]);
  assert.equal(result.failures[0].key, 1);
});

test("NDJSON is delivered before completion and ends with an explicit terminal event", async () => {
  const release = Promise.withResolvers();
  const response = streamingBatch(async (ready) => {
    ready({ key: "video", size: 100 });
    await release.promise;
    return { results: [{ key: "video" }], failures: [] };
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /started/);
  assert.match(decoder.decode((await reader.read()).value), /ready/);
  release.resolve();
  assert.match(decoder.decode((await reader.read()).value), /complete/);
  assert.equal((await reader.read()).done, true);
});
