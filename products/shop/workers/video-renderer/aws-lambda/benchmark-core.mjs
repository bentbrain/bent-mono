import { randomUUID } from "node:crypto";
import { FUNCTION_ARN, NAME, REPOSITORY, RESERVED_CONCURRENCY, VARIANTS } from "./config.mjs";
import { jobIdentity, validateJob } from "./contract.mjs";
import { STORY_RENDERER_VERSION } from "../src/version.mjs";

export function verifyCapacity(account, fn, reservation) {
  if (account.AccountLimit?.ConcurrentExecutions < 100 + RESERVED_CONCURRENCY ||
      !Number.isFinite(account.AccountLimit?.ConcurrentExecutions) ||
      reservation?.ReservedConcurrentExecutions !== RESERVED_CONCURRENCY) {
    throw new Error("Benchmark needs eight reserved slots and at least 108 account concurrency. No renders started.");
  }
  verifyFunction(fn);
}

export function verifyFunction(fn) {
  if (fn.arn !== FUNCTION_ARN || fn.state !== "Active" || fn.update !== "Successful" ||
      ![3008, 4096, 6144, 8192, 10240].includes(fn.memoryMB) ||
      !/^[0-9a-f]{64}$/.test(fn.buildId ?? "") ||
      typeof fn.image !== "string" || !fn.image.startsWith(`${REPOSITORY}@sha256:`) ||
      !/^[0-9a-f]{64}$/.test(fn.image.split("@sha256:")[1] ?? "")) {
    throw new Error("Expected an active, pinned-image personal benchmark function.");
  }
}

export async function preflight(call) {
  const account = await call(["lambda", "get-account-settings"]);
  const fn = await call(["lambda", "get-function", "--function-name", NAME, "--query",
    "{arn:Configuration.FunctionArn,state:Configuration.State,update:Configuration.LastUpdateStatus,memoryMB:Configuration.MemorySize,buildId:Configuration.Environment.Variables.STORY_BUILD_ID,image:Code.ResolvedImageUri}"]);
  const reservation = await call(["lambda", "get-function-concurrency", "--function-name", NAME]);
  verifyCapacity(account, fn, reservation);
  return fn;
}

export function jobsFor(fixture, customerCount, runId = randomUUID(), rotation = 0) {
  if (![1, 2].includes(customerCount) || fixture.schemaVersion !== 1 || !Array.isArray(fixture.variants) ||
      fixture.variants.length !== 4 || new Set(fixture.variants.map((variant) => variant.variantId)).size !== 4 ||
      fixture.variants.some((variant) => !Object.hasOwn(VARIANTS, variant.variantId))) throw new Error("Expected all four product variants and one or two customers.");
  const ordered = [...fixture.variants.slice(rotation), ...fixture.variants.slice(0, rotation)];
  return ["customer-a", "customer-b"].slice(0, customerCount).flatMap((customerId) => ordered.map((variant) => validateJob({
    schemaVersion: 1, runId, customerId, variantId: variant.variantId,
    artwork: fixture.artwork, mockup: variant.mockup, settings: variant.settings,
  })));
}

export function verifyResult(job, result, fn) {
  const expected = jobIdentity(job, fn.buildId);
  if (result?.schemaVersion !== 1 || result.runId !== job.runId || result.customerId !== job.customerId ||
      result.variantId !== job.variantId || result.jobDigest !== expected.digest || result.object?.key !== expected.key ||
      !/^[0-9a-f]{64}$/.test(result.object?.sha256 ?? "") || !Number.isSafeInteger(result.object.size) ||
      result.object.size < 1 || result.object.size > 64_000_000 || typeof result.object.etag !== "string" ||
      !result.object.etag || result.runtime?.buildId !== fn.buildId || result.runtime?.rendererVersion !== STORY_RENDERER_VERSION ||
      result.runtime?.memoryMB !== fn.memoryMB || typeof result.runtime?.instanceId !== "string" ||
      !result.runtime.instanceId || !Number.isSafeInteger(result.runtime.invocationSequence) || result.runtime.invocationSequence < 1 ||
      typeof result.runtime.awsRequestId !== "string" || !result.runtime.awsRequestId ||
      result.runtime.firstInvocationInProcess !== (result.runtime.invocationSequence === 1) ||
      result.uniqueFrameCount !== 91 || result.encoding?.frameRate !== 30 || result.encoding?.frameWidth !== 720 ||
      result.encoding?.frameHeight !== 1280 || result.encoding?.crf !== 21) throw new Error("Lambda returned mismatched job, build, output, or encoding metadata.");
  for (const key of ["handlerStartedAt", "handlerFinishedAt", "handlerMs", "runtimeLoadMs", "assetReadMs", "storageWriteMs",
    "renderMs", "assetDecodeMs", "canvasMs", "encoderPipeMs", "encoderDrainMs"]) {
    if (!Number.isFinite(result.timings?.[key]) || result.timings[key] < 0) throw new Error("Invalid Lambda timing evidence.");
  }
  if (result.timings.handlerFinishedAt < result.timings.handlerStartedAt) throw new Error("Invalid Lambda timing interval.");
  return result;
}

export function parsePlatformReport(logTail, requestId) {
  const text = Buffer.from(logTail ?? "", "base64").toString("utf8");
  const line = text.split("\n").find((line) => line.startsWith(`REPORT RequestId: ${requestId}\t`));
  if (!line) return null;
  const number = (label) => {
    const match = line.match(new RegExp(`(?:^|\\t)${label}: ([0-9.]+)`));
    return match ? Number(match[1]) : null;
  };
  return { durationMs: number("Duration"), billedDurationMs: number("Billed Duration"),
    initDurationMs: number("Init Duration"), maxMemoryMB: number("Max Memory Used"), memoryMB: number("Memory Size") };
}

export function hasPlatformEvidence(sample, fn) {
  if (!sample.ok) return false;
  const report = sample.platform;
  return [report?.durationMs, report?.billedDurationMs, report?.maxMemoryMB].every((value) => Number.isFinite(value) && value > 0) &&
    report?.memoryMB === fn.memoryMB &&
    (report.initDurationMs === null || (Number.isFinite(report.initDurationMs) && report.initDurationMs >= 0));
}

function summarizeRound(samples, customerCount) {
  const successful = samples.filter((sample) => sample.ok);
  const points = successful.flatMap(({ result }) => [
    [result.timings.handlerStartedAt, 1], [result.timings.handlerFinishedAt, -1],
  ]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let peakConcurrentHandlers = 0;
  for (const [, delta] of points) { active += delta; peakConcurrentHandlers = Math.max(peakConcurrentHandlers, active); }
  const customers = ["customer-a", "customer-b"].slice(0, customerCount).map((customerId) => {
    const own = successful.filter((sample) => sample.job.customerId === customerId);
    return { customerId, completed: own.length,
      firstReadyMs: own.length ? Math.min(...own.map((sample) => sample.readyMs)) : null,
      allFourReadyMs: own.length === 4 ? Math.max(...own.map((sample) => sample.readyMs)) : null };
  });
  return { customers, failures: samples.length - successful.length, peakConcurrentHandlers,
    fullOverlapObserved: peakConcurrentHandlers === customerCount * 4,
    instances: new Set(successful.map((sample) => sample.result.runtime.instanceId)).size,
    firstInvocations: successful.filter((sample) => sample.result.runtime.firstInvocationInProcess).length };
}

export function completedBenchmarkStatus(report) {
  if (report.verificationFailed || report.rounds.some((round) => round.summary.failures)) return "failed";
  if (report.platformTimingsMissing) return "incomplete-platform-evidence";
  if (!report.rounds.length || report.rounds.some((round) => !round.summary.fullOverlapObserved)) return "incomplete-overlap-evidence";
  return "completed";
}

export async function runRound(jobs, invoke, fn, { now = () => performance.now(), onResult = () => {} } = {}) {
  const start = now();
  // No shared queue: one independent invocation per product. All outcomes are retained.
  const samples = await Promise.all(jobs.map(async (job) => {
    const sentAt = now();
    let sample;
    try {
      const { result, platform } = await invoke(job);
      verifyResult(job, result, fn);
      sample = { ok: true, job, result, platform, driverInvocationMs: now() - sentAt, readyMs: now() - start };
    } catch (error) {
      sample = { ok: false, job, error: error instanceof Error ? error.message : "Invocation failed", driverInvocationMs: now() - sentAt };
    }
    onResult(sample);
    return sample;
  }));
  return { samples, summary: summarizeRound(samples, new Set(jobs.map((job) => job.customerId)).size) };
}
