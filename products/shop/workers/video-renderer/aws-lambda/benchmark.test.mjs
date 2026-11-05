import assert from "node:assert/strict";
import test from "node:test";
import { completedBenchmarkStatus, hasPlatformEvidence, jobsFor, parsePlatformReport, runRound, verifyCapacity, verifyResult } from "./benchmark-core.mjs";
import { FUNCTION_ARN, REPOSITORY, VARIANTS } from "./config.mjs";
import { jobIdentity, sha256 } from "./contract.mjs";
import { STORY_RENDERER_VERSION } from "../src/version.mjs";

const hash = "a".repeat(64);
const fn = { arn: FUNCTION_ARN, state: "Active", update: "Successful", memoryMB: 8192, buildId: hash, image: `${REPOSITORY}@sha256:${hash}` };
const settings = { cropX: 0.5, cropY: 0.5, cropZoom: 1, depth: 5, placementX: 0.3, placementY: 0.3, placementWidth: 0.4 };
const fixture = { schemaVersion: 1, artwork: { key: `inputs/artwork/${hash}.png`, sha256: hash, size: 100 },
  variants: Object.keys(VARIANTS).map((variantId) => ({ variantId, settings,
    mockup: { key: `inputs/mockups/${variantId}/${hash}.${VARIANTS[variantId].file.split(".").at(-1)}`, sha256: hash, size: 100 } })) };

function result(job) {
  const identity = jobIdentity(job, hash);
  return { schemaVersion: 1, ...job, jobDigest: identity.digest,
    object: { key: identity.key, size: 10, sha256: sha256("test video"), etag: "etag" },
    runtime: { buildId: hash, memoryMB: 8192, rendererVersion: STORY_RENDERER_VERSION, awsRequestId: "request-id", instanceId: `${job.customerId}-${job.variantId}`, invocationSequence: 1, firstInvocationInProcess: true },
    uniqueFrameCount: 91, encoding: { frameWidth: 720, frameHeight: 1280, frameRate: 30, crf: 21 },
    timings: { handlerStartedAt: 100, handlerFinishedAt: 110, handlerMs: 10, runtimeLoadMs: 1, assetReadMs: 1, storageWriteMs: 1,
      renderMs: 7, assetDecodeMs: 1, canvasMs: 3, encoderPipeMs: 1, encoderDrainMs: 2 } };
}

test("live driver refuses low quota, shared capacity, foreign functions and unpinned builds", () => {
  verifyCapacity({ AccountLimit: { ConcurrentExecutions: 1000 } }, fn, { ReservedConcurrentExecutions: 8 });
  for (const [account, definition, reservation] of [
    [{ AccountLimit: { ConcurrentExecutions: 10 } }, fn, { ReservedConcurrentExecutions: 8 }],
    [{ AccountLimit: {} }, fn, { ReservedConcurrentExecutions: 8 }],
    [{ AccountLimit: { ConcurrentExecutions: 1000 } }, fn, {}],
    [{ AccountLimit: { ConcurrentExecutions: 1000 } }, { ...fn, arn: "work" }, { ReservedConcurrentExecutions: 8 }],
    [{ AccountLimit: { ConcurrentExecutions: 1000 } }, { ...fn, image: `${REPOSITORY}:latest` }, { ReservedConcurrentExecutions: 8 }],
  ]) assert.throws(() => verifyCapacity(account, definition, reservation));
});

test("two customers dispatch eight independent jobs and notify on each completion", async () => {
  const jobs = jobsFor(fixture, 2);
  assert.equal(jobs.length, 8);
  const releases = [];
  const notifications = [];
  const running = runRound(jobs, (job) => new Promise((resolve) => releases.push(() => resolve({ result: result(job), platform: null }))), fn,
    { onResult: (sample) => notifications.push(sample) });
  assert.equal(releases.length, 8, "No customer or product waits in a shared queue.");
  releases[3]();
  await new Promise(setImmediate);
  assert.equal(notifications.length, 1);
  for (const [index, release] of releases.entries()) if (index !== 3) release();
  const report = await running;
  assert.equal(report.summary.failures, 0);
  assert.equal(report.summary.peakConcurrentHandlers, 8);
  assert.equal(report.summary.fullOverlapObserved, true);
  assert.equal(report.summary.customers[0].completed, 4);
  assert.equal(report.summary.customers[1].completed, 4);
});

test("failures and wrong video/build results cannot appear as all-four ready", async () => {
  const jobs = jobsFor(fixture, 1);
  const report = await runRound(jobs, async (job) => {
    if (job.variantId === "tee-white") throw new Error("Lambda timed out");
    if (job.variantId === "tote-cream") return { result: { ...result(job), jobDigest: "wrong" } };
    return { result: result(job) };
  }, fn);
  assert.equal(report.summary.failures, 2);
  assert.equal(report.summary.customers[0].allFourReadyMs, null);
  assert.equal(report.samples.length, 4);
  assert.throws(() => jobsFor(fixture, 3));
  assert.throws(() => jobsFor({ ...fixture, variants: fixture.variants.slice(0, 3) }, 1));
});

test("platform timings are parsed only from this request's REPORT line", () => {
  const log = "REPORT RequestId: previous\tDuration: 999 ms\nREPORT RequestId: current\tDuration: 5000.25 ms\tBilled Duration: 5301 ms\tMemory Size: 8192 MB\tMax Memory Used: 422 MB\tInit Duration: 300.5 ms\n";
  assert.deepEqual(parsePlatformReport(Buffer.from(log).toString("base64"), "current"), {
    durationMs: 5000.25, billedDurationMs: 5301, memoryMB: 8192, maxMemoryMB: 422, initDurationMs: 300.5,
  });
  assert.equal(parsePlatformReport(Buffer.from(log).toString("base64"), "missing"), null);
});

test("missing or mismatched timing evidence cannot qualify a benchmark", () => {
  const platform = { durationMs: 5000, billedDurationMs: 5301, maxMemoryMB: 422, memoryMB: 8192, initDurationMs: 300.5 };
  assert.equal(hasPlatformEvidence({ ok: true, platform }, fn), true);
  assert.equal(hasPlatformEvidence({ ok: true, platform: { ...platform, initDurationMs: null } }, fn), true);
  for (const bad of [null, {}, { ...platform, memoryMB: 4096 }, { ...platform, billedDurationMs: NaN },
    { ...platform, durationMs: null }, { ...platform, maxMemoryMB: 0 }]) {
    assert.equal(hasPlatformEvidence({ ok: true, platform: bad }, fn), false);
  }
  const job = jobsFor(fixture, 1)[0];
  const valid = result(job);
  for (const invalid of [
    { ...valid, runtime: { ...valid.runtime, awsRequestId: "" } },
    { ...valid, runtime: { ...valid.runtime, memoryMB: 4096 } },
    { ...valid, timings: { ...valid.timings, canvasMs: NaN } },
    { ...valid, timings: { ...valid.timings, handlerFinishedAt: 99 } },
  ]) assert.throws(() => verifyResult(job, invalid, fn));
});

test("serialized success cannot qualify as a concurrent scaling benchmark", async () => {
  const jobs = jobsFor(fixture, 2);
  let index = 0;
  const batch = await runRound(jobs, async (job) => {
    const value = result(job);
    const offset = index++ * 20;
    value.timings.handlerStartedAt += offset;
    value.timings.handlerFinishedAt += offset;
    return { result: value };
  }, fn);
  assert.equal(batch.summary.failures, 0);
  assert.equal(batch.summary.peakConcurrentHandlers, 1);
  assert.equal(completedBenchmarkStatus({ rounds: [batch] }), "incomplete-overlap-evidence");
  const valid = { rounds: [{ summary: { failures: 0, fullOverlapObserved: true } }] };
  assert.equal(completedBenchmarkStatus(valid), "completed");
  assert.equal(completedBenchmarkStatus({ ...valid, platformTimingsMissing: true }), "incomplete-platform-evidence");
  assert.equal(completedBenchmarkStatus({ ...valid, verificationFailed: true }), "failed");
  assert.equal(completedBenchmarkStatus({ rounds: [{ summary: { failures: 1 } }] }), "failed");
  assert.equal(completedBenchmarkStatus({ rounds: [] }), "incomplete-overlap-evidence");
});
