import assert from "node:assert/strict";
import test from "node:test";
import { FUNCTION_ARN, REPOSITORY } from "./config.mjs";
import { sequentialJobs, verifySmokeCapacity } from "./smoke-core.mjs";

const fn = { arn: FUNCTION_ARN, state: "Active", update: "Successful", memoryMB: 8192,
  buildId: "a".repeat(64), image: `${REPOSITORY}@sha256:${"b".repeat(64)}`, capacityMode: "sequential-smoke" };
const account = { AccountLimit: { UnreservedConcurrentExecutions: 10 } };
test("smoke mode can use a low quota without treating unknown metrics as zero", () => {
  assert.equal(verifySmokeCapacity(account, fn, {}, { Datapoints: [] }).observedMaximum, null);
  assert.equal(verifySmokeCapacity(account, fn, null, { Datapoints: [] }).observedMaximum, null);
  assert.equal(verifySmokeCapacity(account, fn, {}, { Datapoints: [{ Maximum: 1 }] }).observedMaximum, 1);
  for (const [a, f, r, m] of [
    [account, { ...fn, capacityMode: "reserved-eight" }, {}, { Datapoints: [] }],
    [account, fn, { ReservedConcurrentExecutions: 8 }, { Datapoints: [] }],
    [{ AccountLimit: { UnreservedConcurrentExecutions: 1 } }, fn, {}, { Datapoints: [] }],
    [account, fn, {}, { Datapoints: [{ Maximum: 9 }] }],
    [account, fn, {}, { Datapoints: [{ Maximum: NaN }] }],
  ]) assert.throws(() => verifySmokeCapacity(a, f, r, m));
});

test("smoke driver never overlaps jobs and stops immediately on failure", async () => {
  const invoked = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const completed = [];
  const pending = sequentialJobs([1, 2, 3], async (job) => {
    invoked.push(job);
    if (job === 1) await first;
    if (job === 2) throw new Error("render failed");
    return job;
  }, (result) => completed.push(result));
  const rejected = assert.rejects(pending, /render failed/);
  assert.deepEqual(invoked, [1]);
  release();
  await rejected;
  assert.deepEqual(invoked, [1, 2]);
  assert.deepEqual(completed, [1]);
});
