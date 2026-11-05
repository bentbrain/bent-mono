import { protectedConfig } from "./protected-config.mjs";
import { measureReleaseStage } from "./release-stage-timing.mjs";
import { prepareApiImage } from "./native-api-image.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { NATIVE_MIGRATION_LATEST } from "./native-migration-inventory.mjs";
import { setTimeout as wait } from "node:timers/promises";
import { productionAWS } from "./native-production-ci.mjs";
import { productionCloudflare, inspectProductionConsumer } from "./native-production-cloudflare.mjs";
import { productionReleaseStore } from "./native-production-release-store.mjs";
import { prepareProductionWorker, verifyProductionReleaseSettings } from "./native-production-worker.mjs";
import { verifyProductionRuntime, PRODUCTION_IMAGE_DIGEST, PRODUCTION_SOURCE_DIGEST } from "./native-production-runtime.mjs";
import { probeProductionImageStartup, prepareProductionImage, verifyCurrentProductionRuntime } from "./native-production-image.mjs";
import { printExecutorProtocol } from "./native-print-executor.mjs";
import { inspectDevelopmentWorker, versionResourcesDigest, workerContentManifest } from "./native-ci-worker.mjs";
import { productionMonitoringBaseline, runProductionMonitor, verifyStableProductionMonitoring } from "./native-production-monitor.mjs";
import { installPauseSchema, beginReleasePause, recordReleaseEvent, assertReleasePaused, resumeVerifiedRelease, verifyPauseSchema } from "./native-release-pause.mjs";
import { waitProductionNaturalDrain, waitUnchangedRendererDrain } from "./native-production-drain.mjs";
const check = (value, reason) => { if (!value)
    throw new Error(`Production paired release stopped: ${reason}`); };
const hash = value => createHash("sha256").update(value).digest("hex");
export async function verifyProductionPairStatus(env, releaseId, sourceCommit, paused = true, request = fetch) {
    check(typeof env.BENT_SHIRT_OPERATIONS_SECRET === "string" && env.BENT_SHIRT_OPERATIONS_SECRET.length > 0, "operations credential required.");
    const response = await request("https://forever-tee-api.socialqueue.workers.dev/v2/internal/operations/native-video-release", {
        redirect: "error", signal: AbortSignal.timeout(30000), headers: { "x-bent-shirt-operations-secret": env.BENT_SHIRT_OPERATIONS_SECRET },
    });
    check(response.ok, "live Worker protocol response.");
    const value = await response.json();
    check(value.executionProtocol === "claim-v1" && value.rendererVersion === "story-video-renderer-v7" && value.releaseId === releaseId &&
        value.sourceCommit === sourceCommit && value.imageDigest === PRODUCTION_IMAGE_DIGEST && value.sourceDigest === PRODUCTION_SOURCE_DIGEST &&
        value.environment === "production" && value.functionArn === "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production" &&
        value.paused === paused && value.pauseOwner === (paused ? releaseId : null), "actual Worker/image/protocol/admission mismatch.");
    return { protocolVerified: true, releaseId, sourceCommit, executionProtocol: value.executionProtocol, paused };
}
export async function waitForProductionPairStatus(env, releaseId, sourceCommit, paused = true, { request = fetch, delay = wait, attempts = 7, intervalMs = 10000 } = {}) {
    check(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 7 && Number.isSafeInteger(intervalMs) && intervalMs >= 0 && intervalMs <= 10000, "bounded live Worker verification wait.");
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await verifyProductionPairStatus(env, releaseId, sourceCommit, paused, request);
        }
        catch (error) {
            const retryable = error instanceof Error &&
                error.message === "Production paired release stopped: actual Worker/image/protocol/admission mismatch.";
            if (!retryable || attempt === attempts)
                throw error;
            await delay(intervalMs);
        }
    }
}
export async function verifyRecordedProductionVersion(cf, record, variables, previousSettings) {
    check(record?.workerBytesVerified === true && /^[a-f0-9-]{36}$/.test(record.workerVersion) &&
        /^[a-f0-9]{64}$/.test(record.versionResourcesSha256) && ["lambda", "cloudflare"].includes(record.provider), "verified immutable version record.");
    const active = (await cf.deployments()).deployments?.[0]?.versions;
    check(active?.length === 1 && active[0].percentage === 100 && active[0].version_id === record.workerVersion, "exact active version.");
    const version = await cf.version(record.workerVersion);
    check(version.id === record.workerVersion && versionResourcesDigest(version) === record.versionResourcesSha256, "immutable version resources.");
    const consumer = await inspectProductionConsumer(cf);
    check(equal(consumer, record.consumer), "recorded provider queue configuration.");
    // Script settings describe the latest upload, not a historical version that
    // is active after rollback. Verify the bindings of the exact active version.
    verifyProductionReleaseSettings({ bindings: version.resources.bindings }, consumer, { ...variables, STORY_VIDEO_PROVIDER: record.provider }, previousSettings, record.consumer.settings, record.printExecutor);
    const schedules = await cf.schedules();
    check(schedules.schedules?.length === 1 && schedules.schedules[0].cron === record.cron, "recorded provider recovery schedule.");
    return { workerVersion: record.workerVersion, provider: record.provider, resourcesVerified: true, queueConcurrency: consumer.settings.max_concurrency };
}
export async function switchRecordedProductionVersion(cf, pauseOwner, record, variables, previousSettings) {
    await assertReleasePaused(cf, pauseOwner);
    await cf.deployExistingVersion(record.workerVersion);
    await cf.restoreConsumer(record.consumer.consumerId, record.consumer.settings, record.printExecutor);
    await cf.setSchedule(record.cron);
    await assertReleasePaused(cf, pauseOwner);
    return verifyRecordedProductionVersion(cf, record, variables, previousSettings);
}
// Every mutation is preceded by durable preparation and pause ownership.
// Ordinary failures retain the pause. Historical failed jobs are observed by
// their stable monitor fingerprint and are never mutated by a release.
export async function executeProductionPair({ cf, store, prepared, image, worker, runtime, status, monitor, wait: delay = wait, now = Date.now }) {
    check(prepared.environment === "production" && prepared.accountId === protectedConfig("awsAccountId") && prepared.region === "ap-southeast-2" &&
        prepared.candidate.imageDigest === PRODUCTION_IMAGE_DIGEST && prepared.candidate.sourceDigest === PRODUCTION_SOURCE_DIGEST &&
        equal(prepared.worker, worker.review) && equal(prepared.image, image.review) &&
        prepared.planSha256 === hash(JSON.stringify({ worker: worker.review, image: image.review })), "pinned pair preparation.");
    await worker.verifyPrevious();
    const evidence = await store.save("prepared.json", Buffer.from(JSON.stringify(prepared)));
    check(equal(JSON.parse(await store.read(evidence)), prepared), "immutable preparation readback.");
    await installPauseSchema(cf);
    await beginReleasePause(cf, { ...prepared, preparation: evidence }, now());
    const releaseId = prepared.releaseId;
    const probe = await cf.query("INSERT INTO story_video_jobs (id, status) VALUES (NULL, 'rendering')");
    check(probe.every(result => result.meta?.changes === 0), "real admission trigger did not reject an invalid rendering insert.");
    await recordReleaseEvent(cf, releaseId, "cloud-pause-verified", { invalidRenderingInsertIgnored: true });
    await recordReleaseEvent(cf, releaseId, "drained", await measureReleaseStage("drain", () => image.review.drainPolicy === 'unchanged-render-handlers-v1'
        ? waitUnchangedRendererDrain(cf, releaseId, delay, image.review, now) : waitProductionNaturalDrain(cf, releaseId, delay, now)));
    check(equal(await image.verifyBefore(), prepared.runtime), "recorded runtime changed during drain.");
    await worker.verifyPrevious();
    const updatedImage = await measureReleaseStage("image-provision", () => image.apply(cf, releaseId));
    await recordReleaseEvent(cf, releaseId, "runtime-image-verified", { plan: prepared.imagePlanArtifact, review: updatedImage });
    await worker.migrate();
    await installPauseSchema(cf);
    await recordReleaseEvent(cf, releaseId, "migration-verified", { executionProtocol: "claim-v1", migration: NATIVE_MIGRATION_LATEST });
    if (prepared.worker.printExecutor) {
        check(typeof worker.deployPrintExecutor === "function" && typeof worker.verifyPrintExecutor === "function", "prepared print executor deployment and verification are required.");
        await measureReleaseStage("print-executor-deploy", () => worker.deployPrintExecutor());
    }
    // Publish the compatible Cloudflare fallback after the namespace migration
    // with its release secrets in one version upload. Standalone secret writes
    // create Worker versions and must never be a separate release transition.
    await recordReleaseEvent(cf, releaseId, "fallback-deploy-started", { ...worker.review, fixedReleaseSecrets: worker.secretNames });
    const fallback = await measureReleaseStage("fallback-deploy", () => worker.deploy("cloudflare"));
    const fallbackArtifact = await store.save("fallback-worker.json", Buffer.from(JSON.stringify(fallback)));
    await recordReleaseEvent(cf, releaseId, "fallback-verified", { fallback, artifact: fallbackArtifact });
    await recordReleaseEvent(cf, releaseId, "native-deploy-started", worker.review);
    const native = await measureReleaseStage("worker-deploy", () => worker.deploy("lambda"));
    await status();
    const nativeArtifact = await store.save("native-worker.json", Buffer.from(JSON.stringify(native)));
    await recordReleaseEvent(cf, releaseId, "native-verified", { native, artifact: nativeArtifact });
    return completeProductionRehearsal({ cf, prepared, native, fallback, variables: worker.variables, previousSettings: worker.settings,
        runtime, expectedRuntime: updatedImage.runtime, status, monitor, verifyPrintExecutor: worker.verifyPrintExecutor });
}
export async function completeProductionRehearsal({ cf, prepared, native, fallback, variables, previousSettings, runtime, expectedRuntime = prepared.runtime, status, monitor, monitoringBaseline = prepared.monitoringBaseline, verifyPrintExecutor }) {
    const releaseId = prepared.releaseId;
    if (prepared.worker.printExecutor) {
        check(typeof verifyPrintExecutor === "function" && equal(native.printExecutor, fallback.printExecutor), "both provider versions must retain the verified print executor.");
        check(equal(await verifyPrintExecutor(), native.printExecutor), "executor changed before rehearsal.");
    }
    const restored = await switchRecordedProductionVersion(cf, releaseId, fallback, variables, previousSettings);
    await recordReleaseEvent(cf, releaseId, "rollback-rehearsed", restored);
    await switchRecordedProductionVersion(cf, releaseId, native, variables, previousSettings);
    await recordReleaseEvent(cf, releaseId, "forward-rehearsed", await status());
    return resumeVerifiedRelease(cf, releaseId, async () => {
        check(equal(await runtime(), expectedRuntime), "qualified runtime changed before admission.");
        await verifyRecordedProductionVersion(cf, native, variables, previousSettings);
        if (prepared.worker.printExecutor)
            check(equal(await verifyPrintExecutor(), native.printExecutor), "executor changed during rehearsal.");
        const monitoring = await monitor();
        verifyStableProductionMonitoring(monitoringBaseline, monitoring);
        return { environment: "production", releaseId, sourceCommit: prepared.sourceCommit, candidate: prepared.candidate, native, fallback, ...(native.printExecutor ? { worker: native } : {}),
            runtime: expectedRuntime, status: await status(), monitoring: monitoring.evidence, monitoringBaseline,
            rollbackRehearsed: true, provider: "lambda" };
    });
}
export async function releaseProductionPair(env, candidate) {
    check(env.NATIVE_OPERATION === "release" && candidate.qualifiedImageVerified && candidate.acceptanceVerified && candidate.alertDeliveryVerified &&
        candidate.workerSourceUnchanged && candidate.sourceCommit === env.GITHUB_SHA, "explicit qualified Production release.");
    const { call } = await productionAWS(env), runtime = () => verifyProductionRuntime(call);
    const monitor = () => runProductionMonitor({ ...env, NATIVE_OPERATION: "monitor", NATIVE_RELEASE_MODE: "full" });
    const healthy = await monitor();
    check(healthy.monitoringVerified && healthy.pauseOverdue === false, "activated live readiness monitoring required before pause.");
    const monitoringBaseline = productionMonitoringBaseline(healthy);
    const store = await productionReleaseStore(env, call), currentRuntime = await verifyCurrentProductionRuntime(call);
    const image = env.NATIVE_RELEASE_MODE === "api"
        ? await prepareApiImage({ environment: "production", sha: env.GITHUB_SHA, cf: productionCloudflare(env), store, candidate,
            runtime: currentRuntime, inspectRuntime: () => verifyCurrentProductionRuntime(call),
            probeRuntime: () => probeProductionImageStartup(call, env) })
        : await measureReleaseStage("image-prepare", () => prepareProductionImage(candidate, env, store));
    const imagePlanArtifact = await image.preserve();
    const worker = await measureReleaseStage("worker-build", () => prepareProductionWorker(env, store, candidate.qualification?.printExecutor)), releaseId = `native-${env.GITHUB_RUN_ID}`;
    const prepared = { environment: "production", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", releaseId, sourceCommit: env.GITHUB_SHA,
        planSha256: hash(JSON.stringify({ worker: worker.review, image: image.review })), worker: worker.review, image: image.review,
        imagePlanArtifact, artifacts: worker.artifacts, runtime: currentRuntime,
        candidate: { imageDigest: candidate.imageDigest, sourceDigest: candidate.sourceDigest, evidence: candidate.evidence },
        previous: { worker: worker.before, consumer: worker.consumer }, variables: worker.variables,
        monitoringBaseline, monitoringBefore: healthy.evidence };
    const result = await executeProductionPair({ cf: worker.cf, store, prepared, image, worker, runtime,
        status: (paused = true) => waitForProductionPairStatus(env, releaseId, env.GITHUB_SHA, paused), monitor });
    await waitForProductionPairStatus(env, releaseId, env.GITHUB_SHA, false);
    return { ...result, pairedReleaseComplete: true, evidence: await store.save("release-complete.json", Buffer.from(JSON.stringify(result))) };
}
export async function rollbackProductionPair(env) {
    const from = env.NATIVE_ROLLBACK_RELEASE, releaseId = `native-${env.GITHUB_RUN_ID}`;
    check(env.NATIVE_OPERATION === "rollback" && /^native-[1-9][0-9]+$/.test(from ?? "") && from !== releaseId, "explicit recorded rollback source.");
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call);
    await verifyPauseSchema(cf);
    const event = async (stage) => {
        const rows = (await cf.query("SELECT payload FROM native_video_release_events WHERE release_id=? AND stage=?", [from, stage]))[0].results;
        check(rows.length === 1, `original ${stage} evidence required.`);
        return JSON.parse(rows[0].payload);
    };
    const { preparation, ...prepared } = await event("prepared");
    check(prepared.releaseId === from && prepared.environment === "production" && equal(JSON.parse(await store.read(preparation)), prepared), "D1/S3 preparation mismatch.");
    const fallbackRecord = await event("fallback-verified"), fallback = JSON.parse(await store.read(fallbackRecord.artifact));
    check(equal(fallback, fallbackRecord.fallback) && fallback.provider === "cloudflare", "verified compatible fallback required.");
    const original = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    check(equal(original.before, prepared.previous.worker), "original Worker preservation.");
    const bytes = await store.read(prepared.artifacts.candidateArtifact);
    const content = await workerContentManifest(new Response(bytes));
    check(equal(content, fallback.content) && hash(bytes) === prepared.worker.bundleSha256 &&
        versionResourcesDigest(await cf.version(fallback.workerVersion)) === fallback.versionResourcesSha256, "fallback code/resources unavailable or changed.");
    const verifyPrintExecutor = () => printExecutorProtocol("production").verifyRecordedPrintExecutor({
        env, api: cf, prepared, store, inspectWorker: inspectDevelopmentWorker
    });
    const printExecutor = prepared.worker.printExecutor ? await verifyPrintExecutor() : null;
    check(!printExecutor || equal(fallback.printExecutor, printExecutor), "fallback executor differs from sealed release.");
    const runtime = await verifyProductionRuntime(call);
    check(equal(runtime, prepared.runtime), "unexpected runtime; do not roll back an unrecorded pair.");
    await recordReleaseEvent(cf, releaseId, "rollback-prepared", { from, fallback, preparation });
    const pausedAt = Date.now();
    await cf.query(`UPDATE native_video_release_control SET paused=1, release_id=?, paused_at=?, updated_at=?
    WHERE singleton=1 AND ((paused=1 AND release_id=?) OR (paused=0 AND release_id IS NULL AND current_release_id=?))`, [releaseId, pausedAt, pausedAt, from, from]);
    await assertReleasePaused(cf, releaseId);
    // Preserve every active print/video attempt and require the normal quiet fence.
    await waitProductionNaturalDrain(cf, releaseId, wait);
    const restored = await switchRecordedProductionVersion(cf, releaseId, fallback, prepared.variables, original.settings);
    const result = await resumeVerifiedRelease(cf, releaseId, async () => {
        check(equal(await verifyProductionRuntime(call), prepared.runtime), "runtime changed during rollback.");
        await verifyRecordedProductionVersion(cf, fallback, prepared.variables, original.settings);
        if (printExecutor)
            check(equal(await verifyPrintExecutor(), printExecutor), "executor changed during fallback rollback.");
        return { ...(printExecutor ? { worker: fallback } : {}), rollbackVerified: true, fromReleaseId: from, releaseId, provider: "cloudflare", restored, retainedNativeRuntime: true, retainedSchemaAndMedia: true };
    });
    return { ...result, evidence: await store.save("rollback-complete.json", Buffer.from(JSON.stringify(result))) };
}
