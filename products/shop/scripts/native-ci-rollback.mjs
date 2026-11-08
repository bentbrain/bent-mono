import { assertArtworkMediaBundle } from "./artwork-media-compatibility.mjs";
import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual } from "node:util";
import { assertReleasePaused, recordReleaseEvent, inspectDevelopmentDrain, resumeVerifiedRelease, verifyPauseSchema } from "./native-release-pause.mjs";
import { inspectDevelopmentConsumer, versionResourcesDigest, workerContentManifest } from "./native-ci-worker.mjs";
import { assertDeployableImage } from "./native-ci-image-policy.mjs";
const check = (value, reason) => { if (!value)
    throw new Error(`Native rollback stopped: ${reason}`); };
export function previousDevelopmentCandidate(prepared) {
    check(prepared.environment === "development" && prepared.accountId === protectedConfig("awsAccountId") && prepared.region === "ap-southeast-2", "recorded environment.");
    const previous = prepared.previous?.runtime;
    assertDeployableImage(previous?.renderer?.imageDigest);
    check(previous?.runtimeVerified === true && previous.environment === "development" &&
        previous.renderer.imageDigest === previous.failure.imageDigest &&
        /^sha256:[a-f0-9]{64}$/.test(previous.renderer.imageDigest) && /^[a-f0-9]{64}$/.test(previous.renderer.sourceDigest), "recorded compatible image pair.");
    const result = { environment: "development", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", imageDigest: previous.renderer.imageDigest,
        imageUri: previous.renderer.imageUri, sourceDigest: previous.renderer.sourceDigest };
    check(result.imageUri === protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@" + (result.imageDigest), "recorded immutable image URI.");
    return result;
}
export async function loadDevelopmentRollback(cf, store, fromReleaseId) {
    check(/^native-\d+$/.test(fromReleaseId), "source release ID.");
    const rows = (await cf.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'prepared'", [fromReleaseId]))[0].results;
    check(rows.length === 1, "immutable preparation missing.");
    const record = JSON.parse(rows[0].payload);
    const { preparation, ...prepared } = record;
    check(prepared.releaseId === fromReleaseId && isDeepStrictEqual(JSON.parse(await store.read(preparation)), prepared), "D1 and versioned S3 preparation disagree.");
    const target = previousDevelopmentCandidate(prepared);
    const artifact = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    const content = await workerContentManifest(new Response(Buffer.from(artifact.body, "base64"), {
        headers: { "content-type": artifact.contentType, "cf-entrypoint": artifact.entrypoint },
    }));
    check(isDeepStrictEqual(content, prepared.previous.worker.content) && isDeepStrictEqual(artifact.before, prepared.previous.worker) &&
        isDeepStrictEqual(artifact.consumer, prepared.previous.consumer), "previous Worker bytes/configuration differ from the recorded pair.");
    const version = await cf.version(prepared.previous.worker.workerVersion);
    check(version.id === prepared.previous.worker.workerVersion && versionResourcesDigest(version) === prepared.previous.worker.versionResourcesSha256, "previous immutable Worker version is unavailable or changed.");
    return { prepared, target, artifact };
}
export async function loadActiveDevelopmentRollbackArtifact(cf, store) {
    const readControl = async () => (await cf.query("SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1"))[0].results;
    const controls = await readControl(), control = controls[0];
    check(controls.length === 1 && control.paused === 0 && control.release_id === null && /^native-\d+$/.test(control.current_release_id), "historical content requires an unpaused recorded rollback.");
    const rows = (await cf.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'verified'", [control.current_release_id]))[0].results;
    check(rows.length === 1, "completed rollback verification missing.");
    const verified = JSON.parse(rows[0].payload);
    check(verified.rollbackVerified === true && verified.releaseId === control.current_release_id &&
        /^native-\d+$/.test(verified.fromReleaseId) && verified.fromReleaseId !== verified.releaseId, "completed rollback identity.");
    const { prepared, target, artifact } = await loadDevelopmentRollback(cf, store, verified.fromReleaseId);
    check(verified.workerVersion === prepared.previous.worker.workerVersion && isDeepStrictEqual(verified.target, target), "completed rollback pair differs from its original preparation.");
    check(isDeepStrictEqual(await readControl(), controls), "release control changed during historical artifact verification.");
    return artifact;
}
export async function executeDevelopmentRollback({ cf, store, prepared, target, releaseId, sourceCommit, image, inspectRuntime, probeRuntime, restorePrintExecutor, wait, now = Date.now }) {
    check(typeof probeRuntime === "function", "live startup verifier required before any mutation.");
    check(!prepared.worker?.printExecutor || typeof restorePrintExecutor === "function", "executor rollback verifier required before any mutation.");
    check(/^native-\d+$/.test(releaseId) && releaseId !== prepared.releaseId && /^[a-f0-9]{40}$/.test(sourceCommit) &&
        image.review.imageDigest === target.imageDigest && image.review.sourceDigest === target.sourceDigest, "rollback preparation.");
    const artifact = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    assertArtworkMediaBundle(Buffer.from(artifact.body, "base64"));
    await verifyPauseSchema(cf);
    const evidence = { releaseId, sourceCommit, fromReleaseId: prepared.releaseId, target, previous: prepared.previous, plan: image.review };
    await store.save("rollback.json", Buffer.from(JSON.stringify(evidence)));
    await recordReleaseEvent(cf, releaseId, "rollback-prepared", evidence, now());
    // Recovery of an interrupted release is explicit and tied to its immutable
    // record. Restart the entire drain window; never inherit an old timer.
    await cf.query(`UPDATE native_video_release_control SET paused = 1, release_id = ?, paused_at = ?, updated_at = ?
    WHERE singleton = 1 AND ((paused = 1 AND release_id = ?) OR (paused = 0 AND release_id IS NULL AND current_release_id = ?))`, [releaseId, now(), now(), prepared.releaseId, prepared.releaseId]);
    await assertReleasePaused(cf, releaseId);
    for (;;) {
        const result = await inspectDevelopmentDrain(cf, releaseId, now());
        if (result.drained)
            break;
        await wait(Math.min(15000, result.remainingMs));
    }
    const current = await inspectRuntime();
    for (const runtime of [current.renderer, current.failure])
        check([target.imageDigest, prepared.candidate.imageDigest].includes(runtime.imageDigest), "unrecorded live image.");
    await recordReleaseEvent(cf, releaseId, "rollback-image-started", image.review, now());
    if (image.review.updateCount > 0)
        await image.apply(cf, releaseId);
    await assertReleasePaused(cf, releaseId);
    await recordReleaseEvent(cf, releaseId, "rollback-startup-verified", await probeRuntime(), now());
    const executor = restorePrintExecutor ? await restorePrintExecutor() : null;
    await assertReleasePaused(cf, releaseId);
    await cf.deployExistingVersion(prepared.previous.worker.workerVersion);
    await cf.restoreConsumer(prepared.previous.consumer.consumerId, prepared.previous.consumer.settings);
    return resumeVerifiedRelease(cf, releaseId, async () => {
        const runtime = await inspectRuntime();
        check(runtime.renderer.imageDigest === target.imageDigest && runtime.failure.imageDigest === target.imageDigest &&
            runtime.renderer.sourceDigest === target.sourceDigest, "restored Lambda pair.");
        const active = (await cf.deployments()).deployments?.[0]?.versions;
        check(active?.length === 1 && active[0].percentage === 100 && active[0].version_id === prepared.previous.worker.workerVersion, "previous Worker must receive all traffic.");
        check(versionResourcesDigest(await cf.version(active[0].version_id)) === prepared.previous.worker.versionResourcesSha256, "restored Worker configuration.");
        check(isDeepStrictEqual(await inspectDevelopmentConsumer(cf), prepared.previous.consumer), "restored queue configuration.");
        await executor?.verify();
        return { ...(executor?.restored ? { worker: { printExecutor: executor.restored } } : {}),
            ...(executor?.retained ? { retainedPrintExecutor: executor.retained } : {}),
            rollbackVerified: true, fromReleaseId: prepared.releaseId, releaseId, target, workerVersion: active[0].version_id };
    });
}
