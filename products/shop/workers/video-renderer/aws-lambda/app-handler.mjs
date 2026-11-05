import { protectedConfig } from "./protected-config.mjs";
import { randomUUID } from "node:crypto";
import { DEFAULT_STORY_MOTION } from "../src/geometry.mjs";
import { STORY_RENDERER_VERSION } from "../src/version.mjs";
import { ENCODING, VARIANTS } from "./config.mjs";
import { sha256, validateSettings } from "./contract.mjs";
import { appEnvironment } from "./app-environment.mjs";
const APP_FUNCTION = "forever-tee-video-development";
export const APP_ARN = "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:" + (APP_FUNCTION);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export function assertAppInvocation(context, environment = "development") {
    if (context?.invokedFunctionArn !== appEnvironment(environment).functionArn || typeof context.awsRequestId !== "string" || !context.awsRequestId ||
        typeof context.getRemainingTimeInMillis !== "function" || !Number.isFinite(context.getRemainingTimeInMillis()) ||
        context.getRemainingTimeInMillis() < 60000)
        throw new Error("Expected the personal app Lambda invocation.");
}
export function validateAppJob(event) {
    const keys = ["schemaVersion", "jobId", "attempt", "artwork", "baseProductSlug", "color", "settings", "storyKey", "rendererVersion", "grant"];
    if ([2, 3].includes(event?.schemaVersion))
        keys.push("recursiveSource");
    if (!event || typeof event !== "object" || Array.isArray(event) || Object.keys(event).length !== keys.length ||
        keys.some(key => !Object.hasOwn(event, key)) || ![1, 2, 3].includes(event.schemaVersion) || !UUID.test(event.jobId) ||
        !Number.isInteger(event.attempt) || event.attempt < 1 || event.attempt > 3 ||
        event.rendererVersion !== STORY_RENDERER_VERSION || typeof event.grant !== "string" || event.grant.length > 1024 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(event.grant))
        throw new Error("Invalid app job.");
    const variant = Object.values(VARIANTS).find(v => v.baseProductSlug === event.baseProductSlug && v.color === event.color);
    const artwork = event.artwork;
    if (!variant || !artwork || Object.keys(artwork).sort().join(",") !== "sha256,size" || !HASH.test(artwork.sha256) ||
        !Number.isSafeInteger(artwork.size) || artwork.size < 1 || artwork.size > 25000000 || typeof event.storyKey !== "string" ||
        !/^story-videos\/v7\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(black|white|cream)\.mp4$/.test(event.storyKey) ||
        !event.storyKey.endsWith(`/${event.color.toLowerCase()}.mp4`))
        throw new Error("Invalid app job assets.");
    if ([2, 3].includes(event.schemaVersion)) {
        const source = event.recursiveSource;
        const sourceKeys = event.schemaVersion === 3 ? "cropX,cropY,cropZoom,placement,sha256,size" : "cropX,cropY,cropZoom,sha256,size";
        if (!source || Object.keys(source).sort().join(",") !== sourceKeys ||
            !HASH.test(source.sha256) || !Number.isSafeInteger(source.size) || source.size < 1 ||
            source.size + artwork.size > 25000000)
            throw new Error("Invalid recursive source.");
        validateSettings({ ...event.settings, cropX: source.cropX, cropY: source.cropY, cropZoom: source.cropZoom });
        if (event.schemaVersion === 3) {
            const placement = source.placement;
            if (!placement || Object.keys(placement).sort().join(",") !== "placementWidth,placementX,placementY" ||
                !Object.values(placement).every(Number.isFinite) || placement.placementX < 0 || placement.placementY < 0 ||
                placement.placementWidth <= 0 || placement.placementWidth >= 1 ||
                placement.placementX + placement.placementWidth > 1 || placement.placementY + placement.placementWidth > 1) {
                throw new Error("Invalid recursive placement.");
            }
        }
    }
    return { ...event, settings: validateSettings(event.settings), variant };
}
async function responseBytes(response, maximum, expected) {
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Asset transfer failed (${response.status}).`);
    }
    const chunks = [];
    let size = 0;
    try {
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > maximum)
                throw new Error("Asset transfer exceeded its size limit.");
            chunks.push(Buffer.from(chunk));
        }
    }
    catch (error) {
        throw error;
    }
    if (expected !== undefined && size !== expected)
        throw new Error("Asset transfer was truncated.");
    return Buffer.concat(chunks, size);
}
async function claimExecution(send, endpoint, headers) {
    const signal = AbortSignal.timeout(10000);
    for (let attempt = 1; attempt <= 3; attempt++) {
        let response;
        try {
            response = await send(`${endpoint}/claim`, { method: "POST", headers, redirect: "error", signal });
        }
        catch {
            if (attempt === 3 || signal.aborted)
                throw new Error("Execution claim response unavailable.");
            continue;
        }
        await response.body?.cancel();
        if (response.status === 201 || response.status === 204)
            return response.status;
        if (attempt < 3 && !signal.aborted && (response.status === 429 || response.status >= 500))
            continue;
        throw new Error(`Execution claim failed (${response.status}).`);
    }
}
export function createAppHandler({ apiOrigin, readMockup, render, buildId, environment = "development", send = fetch, now = () => performance.now(), terminateQualification }) {
    const origin = new URL(apiOrigin);
    if (apiOrigin !== appEnvironment(environment).apiOrigin || origin.protocol !== "https:" || origin.origin !== apiOrigin || origin.username || origin.password || !HASH.test(buildId)) {
        throw new Error("Invalid app renderer configuration.");
    }
    return async (event, context) => {
        assertAppInvocation(context, environment);
        const job = validateAppJob(event);
        const startedAt = now();
        const endpoint = `${apiOrigin}/v2/internal/story-video-jobs/${job.jobId}`;
        const headers = { authorization: `Bearer ${job.grant}`, "x-video-execution-id": randomUUID() };
        if (await claimExecution(send, endpoint, headers) === 204)
            return { jobId: job.jobId, status: "skipped" };
        const claimMs = Math.round(now() - startedAt);
        try {
            // One shared deadline bounds retries. Only idempotent reads may be retried.
            const signal = AbortSignal.timeout(20000);
            let response;
            let readAttempts = 0;
            while (!response) {
                readAttempts++;
                try {
                    const result = await send(`${endpoint}/artwork`, { headers, redirect: "error", signal });
                    if ((result.status === 429 || result.status >= 500) && readAttempts < 3) {
                        await result.body?.cancel();
                        continue;
                    }
                    response = result;
                }
                catch {
                    if (readAttempts >= 3 || signal.aborted)
                        throw new Error("Artwork read failed.");
                }
            }
            const artwork = await responseBytes(response, job.artwork.size, job.artwork.size);
            if (sha256(artwork) !== job.artwork.sha256)
                throw new Error("Artwork checksum mismatch.");
            // Only the trusted Development API can issue this one-use fixture action,
            // after this execution owns the claim and verifies its immutable artwork.
            if (environment === "development" && job.attempt === 1 && response.headers.get("x-native-qualification-terminate") === job.jobId && terminateQualification) {
                await terminateQualification(job.jobId, headers["x-video-execution-id"], context);
                throw new Error("Qualification termination unexpectedly returned.");
            }
            let recursiveInput = {};
            if (job.recursiveSource) {
                const source = job.recursiveSource;
                const nested = await send(`${endpoint}/recursive-artwork`, { headers, redirect: "error", signal });
                const recursiveArtwork = await responseBytes(nested, source.size, source.size);
                if (sha256(recursiveArtwork) !== source.sha256)
                    throw new Error("Recursive artwork checksum mismatch.");
                recursiveInput = { recursiveArtwork, recursiveCrop: { cropX: source.cropX, cropY: source.cropY, cropZoom: source.cropZoom },
                    ...(source.placement ? { recursivePlacement: source.placement } : {}) };
            }
            const mockup = await readMockup(job.variant.file);
            const assetReadMs = Math.round(now() - startedAt);
            const result = await render({ artwork, mockup, ...recursiveInput, baseProductSlug: job.baseProductSlug, settings: job.settings,
                motion: structuredClone(DEFAULT_STORY_MOTION), encoding: { ...ENCODING }, preset: "veryfast", websiteLabel: "shop.bent.build" });
            if (!Buffer.isBuffer(result.video) || result.video.length < 1 || result.video.length > 32000000)
                throw new Error("Invalid rendered video size.");
            const digest = sha256(result.video);
            const uploadAt = now();
            const uploaded = await send(`${endpoint}/video`, { method: "PUT", headers: { ...headers, "content-type": "video/mp4",
                    "content-length": String(result.video.length), "x-video-sha256": digest }, body: result.video,
                redirect: "error", signal: AbortSignal.timeout(30000) });
            const ack = JSON.parse((await responseBytes(uploaded, 4096)).toString("utf8"));
            if (ack?.key !== job.storyKey || ack.size !== result.video.length || ack.sha256 !== digest)
                throw new Error("R2 did not acknowledge this video.");
            const completed = { jobId: job.jobId, storyKey: job.storyKey, rendererVersion: STORY_RENDERER_VERSION,
                size: ack.size, sha256: digest, buildId, timings: { claimMs, assetReadMs, readAttempts,
                    renderMs: result.renderTimeMs, uploadMs: Math.round(now() - uploadAt), handlerMs: Math.round(now() - startedAt) } };
            // Async invocation results never reach the dispatcher. Log only identifiers
            // and stage timings, not grants, credentials, source bytes or request bodies.
            console.info("Story video execution complete", { jobId: job.jobId, attempt: job.attempt, buildId, timings: completed.timings });
            return completed;
        }
        catch (error) {
            // Only this execution may fail its claim. If this callback is lost or the
            // process is killed, the bounded D1 lease recovers the job instead.
            try {
                const response = await send(`${endpoint}/failure`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
                await response.body?.cancel();
            }
            catch { /* The durable watchdog remains responsible for recovery. */ }
            console.error("Story video execution failed", { jobId: job.jobId, attempt: job.attempt, buildId });
            throw error;
        }
    };
}
