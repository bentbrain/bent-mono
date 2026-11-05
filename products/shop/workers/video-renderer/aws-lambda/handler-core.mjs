import { randomUUID } from "node:crypto";
import { DEFAULT_STORY_MOTION } from "../src/geometry.mjs";
import { STORY_RENDERER_VERSION } from "../src/version.mjs";
import { videoSize } from "../src/storage-contract.mjs";
import { ENCODING, FUNCTION_ARN, VARIANTS } from "./config.mjs";
import { jobIdentity, sha256, validateJob } from "./contract.mjs";

export function assertInvocation(context) {
  // The RIC supplies this context, not the event. Fail before accessing storage.
  const remaining = typeof context?.getRemainingTimeInMillis === "function"
    ? context.getRemainingTimeInMillis() : NaN;
  if (context?.invokedFunctionArn !== FUNCTION_ARN || typeof context.awsRequestId !== "string" ||
      !context.awsRequestId || !Number.isFinite(remaining) || remaining < 60_000) {
    throw new Error("Expected the isolated personal Lambda with at least 60 seconds remaining.");
  }
}

export function createHandler({ storage, render, buildId, now = () => performance.now(), wallClock = Date.now,
  instanceId = randomUUID() }) {
  let invocationSequence = 0;
  return async (event, context) => {
    assertInvocation(context);
    const startedAt = now();
    const handlerStartedAt = wallClock();
    const sequence = ++invocationSequence;
    const job = validateJob(event);
    const identity = jobIdentity(job, buildId);
    const assetsController = new AbortController();
    let assetReadAttempts = 0;
    let assetReadRetryDelayMs = 0;
    const readAsset = async (ref) => {
      const bytes = await storage.read(ref, { signal: assetsController.signal, onRequest: ({ attempts, retryDelayMs }) => {
        assetReadAttempts += attempts;
        assetReadRetryDelayMs += retryDelayMs;
      } });
      if (!Buffer.isBuffer(bytes) || bytes.length !== ref.size || sha256(bytes) !== ref.sha256) {
        throw new Error("Render asset checksum or size mismatch.");
      }
      return bytes;
    };
    const reads = [readAsset(job.artwork), readAsset(job.mockup)];
    let assets;
    try { assets = await Promise.all(reads); }
    catch (error) {
      assetsController.abort();
      await Promise.allSettled(reads);
      throw error;
    }
    const [artwork, mockup] = assets;
    const assetReadMs = Math.round(now() - startedAt);
    const result = await render({
      artwork, mockup, baseProductSlug: VARIANTS[job.variantId].baseProductSlug,
      settings: job.settings, motion: structuredClone(DEFAULT_STORY_MOTION), encoding: { ...ENCODING },
      preset: "veryfast", websiteLabel: "shop.bent.build",
    });
    if (!Buffer.isBuffer(result.video)) throw new Error("Renderer did not return video bytes.");
    const size = videoSize(result.video.length);
    const videoHash = sha256(result.video);
    const storageStartedAt = now();
    const stored = await storage.write({
      key: identity.key, video: result.video, sha256: videoHash, jobDigest: identity.digest, buildId,
    });
    if (typeof stored?.etag !== "string" || !stored.etag || stored.sha256 !== videoHash) {
      throw new Error("Video storage did not acknowledge the expected checksum.");
    }
    return {
      schemaVersion: 1, runId: job.runId, customerId: job.customerId, variantId: job.variantId,
      jobDigest: identity.digest,
      object: { key: identity.key, size, sha256: videoHash, etag: stored.etag },
      runtime: { buildId, rendererVersion: STORY_RENDERER_VERSION, instanceId, invocationSequence: sequence,
        firstInvocationInProcess: sequence === 1, awsRequestId: context.awsRequestId,
        memoryMB: Number(context.memoryLimitInMB), nodeVersion: process.version },
      timings: {
        handlerStartedAt, handlerFinishedAt: wallClock(), handlerMs: Math.round(now() - startedAt),
        assetReadMs, assetReadAttempts, assetReadRetryDelayMs,
        storageWriteMs: Math.round(now() - storageStartedAt), renderMs: result.renderTimeMs,
        assetDecodeMs: result.assetLoadTimeMs, canvasMs: result.canvasTimeMs,
        encoderPipeMs: result.pipeTimeMs, encoderDrainMs: result.encoderDrainTimeMs,
      },
      encoding: result.encoding, uniqueFrameCount: result.uniqueFrameCount,
    };
  };
}
