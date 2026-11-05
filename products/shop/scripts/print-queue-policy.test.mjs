import assert from "node:assert/strict";
import test from "node:test";
import { verifyPrintQueue } from "./print-queue-policy.mjs";

test("release verifies the exact print queue, consumer and bounded retry policy", async () => {
  for (const environment of ["development", "production"]) {
    const binding = { name: "PRINT_ASSET_JOBS", type: "queue", queue_name: `forever-tee-print-assets-${environment}` };
    const consumer = { type: "worker", script: environment === "production" ? "forever-tee-api" : "forever-tee-api-development",
      settings: { batch_size: 1, max_retries: 100, max_wait_time_ms: 1000, max_concurrency: 5, retry_delay: 15 } };
    const cf = { settings: async () => ({ bindings: [binding] }), printConsumers: async () => [consumer] };
    assert.equal((await verifyPrintQueue(cf, environment)).printQueueVerified, true);
    for (const mutation of [value => { value.settings.max_concurrency = 100; }, value => { value.script = "another-worker"; },
      value => { value.settings.max_retries = 0; }, value => { value.settings.batch_size = 10; }]) {
      const changed = structuredClone(consumer); mutation(changed);
      await assert.rejects(verifyPrintQueue({ ...cf, printConsumers: async () => [changed] }, environment));
    }
    await assert.rejects(verifyPrintQueue({ ...cf, printConsumers: async () => [] }, environment));
    await assert.rejects(verifyPrintQueue({ ...cf, settings: async () => ({ bindings: [binding, binding] }) }, environment));
    await assert.rejects(verifyPrintQueue(cf, "other"));
  }
});
