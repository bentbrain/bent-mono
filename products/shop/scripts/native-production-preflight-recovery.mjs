import { equalWorkerSettings } from "./native-worker-settings.mjs";
import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { productionAWS } from "./native-production-ci.mjs";
import { productionCloudflare } from "./native-production-cloudflare.mjs";
import { verifyCurrentProductionRuntime } from "./native-production-image.mjs";
import { productionReleaseStore } from "./native-production-release-store.mjs";
import { loadRecordedProductionWorkerBaseline } from "./native-production-worker.mjs";
import { workerContentManifest } from "./native-ci-worker.mjs";
import { assertReleasePaused, recordReleaseEvent, verifyPauseSchema } from "./native-release-pause.mjs";
import { NATIVE_MIGRATION_LATEST } from "./native-migration-inventory.mjs";
const check = (value, reason) => { if (!value)
    throw Error(`Production release recovery stopped: ${reason}`); };
const EARLY_STAGES = ["cloud-pause-verified", "drained", "prepared"];
const PREDEPLOY_STAGES = [...EARLY_STAGES, "migration-verified", "runtime-image-verified", "secret-install-started"].sort();
export async function executeProductionReleaseAbort({ cf, store, releaseId, recoveryRunId, verifierSourceCommit, currentRuntime, loadBaseline = loadRecordedProductionWorkerBaseline, now = Date.now }) {
    check(/^native-[1-9][0-9]+$/.test(releaseId) && /^[1-9][0-9]+$/.test(recoveryRunId) && /^[a-f0-9]{40}$/.test(verifierSourceCommit), "pinned failed release and recovery identity.");
    await verifyPauseSchema(cf);
    const pause = await assertReleasePaused(cf, releaseId);
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const controls = await query("SELECT paused,release_id,current_release_id,paused_at FROM native_video_release_control WHERE singleton=1");
    check(controls.length === 1 && controls[0].paused === 1 && controls[0].release_id === releaseId &&
        /^native-[1-9][0-9]+$/.test(controls[0].current_release_id) && controls[0].current_release_id !== releaseId &&
        controls[0].paused_at === pause.paused_at, "exact early-release pause and prior admitted release.");
    const previousReleaseId = controls[0].current_release_id;
    const records = await query("SELECT stage,payload,created_at FROM native_video_release_events WHERE release_id=? ORDER BY created_at,stage", [releaseId]);
    const stages = records.map(record => record.stage).sort();
    const phase = equal(stages, EARLY_STAGES) ? "early" : equal(stages, PREDEPLOY_STAGES) ? "predeploy" : undefined;
    check(phase, "only a verified early or pre-deployment boundary may be aborted.");
    const event = stage => JSON.parse(records.find(record => record.stage === stage).payload);
    const { preparation, ...prepared } = event("prepared");
    check(prepared.environment === "production" && prepared.accountId === protectedConfig("awsAccountId") && prepared.region === "ap-southeast-2" &&
        prepared.releaseId === releaseId && /^[a-f0-9]{40}$/.test(prepared.sourceCommit) &&
        equal(JSON.parse(await store.read(preparation)), prepared), "immutable failed preparation.");
    const drained = event("drained");
    check(drained.naturalDrainVerified === true && drained.unresolvedAttempts === 0 && drained.pausedAt === pause.paused_at, "completed zero-work natural drain.");
    const active = (await query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status='rendering'"))[0];
    check(active?.count === 0, "no rendering work remains.");
    let expectedRuntime = prepared.runtime;
    if (phase === "predeploy") {
        const image = event("runtime-image-verified"), migration = event("migration-verified"), secret = event("secret-install-started");
        check(equal(image.plan, prepared.imagePlanArtifact) && image.review?.startupVerified === true && image.review.runtime?.runtimeVerified === true &&
            image.review.imageDigest === prepared.candidate?.imageDigest && image.review.sourceDigest === prepared.candidate?.sourceDigest, "qualified image update evidence.");
        check(equal(migration, { executionProtocol: "claim-v1", migration: NATIVE_MIGRATION_LATEST }) &&
            equal(secret.fixedReleaseSecrets, prepared.worker.secretNames), "migration and bounded legacy secret intent.");
        expectedRuntime = image.review.runtime;
    }
    check(equal(await currentRuntime(), expectedRuntime), "recorded runtime and image pair.");
    const baseline = await loadBaseline(cf, store, { pauseOwner: releaseId });
    const { provider, consumer, cron, ...fallbackWorker } = baseline?.fallback ?? {};
    check(baseline?.record.releaseId === previousReleaseId && provider === "cloudflare" && typeof cron === "string" &&
        equal(fallbackWorker, prepared.previous.worker) && equal(consumer, prepared.previous.consumer), "recorded prior fallback is still the active baseline.");
    const previous = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    const previousContent = await workerContentManifest(new Response(Buffer.from(previous.body, "base64"), {
        headers: { "content-type": previous.contentType, "cf-entrypoint": previous.entrypoint },
    }));
    check(equal(previous.before, prepared.previous.worker) && equal(previous.before, fallbackWorker) &&
        equal(previousContent, fallbackWorker.content) && equal(previous.consumer, consumer) &&
        equalWorkerSettings(previous.settings, baseline.settings) && previous.schedules?.schedules?.length === 1 &&
        previous.schedules.schedules[0].cron === cron, "preserved prior Worker baseline.");
    const intent = await store.save("release-abort-intent.json", Buffer.from(JSON.stringify({ releaseId, previousReleaseId, phase,
        failedPreparation: preparation, recoveryRunId, verifierSourceCommit })));
    const recoveredAt = now();
    await recordReleaseEvent(cf, releaseId, "release-abort-started", { recoveryRunId, previousReleaseId, phase, intent }, recoveredAt);
    await cf.query(`UPDATE native_video_release_control SET paused=0,release_id=NULL,updated_at=?
    WHERE singleton=1 AND paused=1 AND release_id=? AND current_release_id=? AND paused_at=?`, [recoveredAt, releaseId, previousReleaseId, pause.paused_at]);
    const resumed = await query("SELECT paused,release_id,current_release_id FROM native_video_release_control WHERE singleton=1");
    check(resumed.length === 1 && resumed[0].paused === 0 && resumed[0].release_id === null && resumed[0].current_release_id === previousReleaseId, "prior admission state was not confirmed.");
    const verified = await loadBaseline(cf, store);
    check(equal(verified?.record, baseline.record) && equal(verified?.fallback, baseline.fallback), "prior fallback changed while reopening admissions.");
    const result = { releaseAbortComplete: true, releaseId, previousReleaseId, phase, provider: "cloudflare", recoveredAt,
        recoveryMutations: ["release-control"], workerChanged: false, retainedQualifiedRuntime: phase === "predeploy" };
    await recordReleaseEvent(cf, releaseId, "release-aborted", { recoveryRunId, ...result }, Math.max(now(), recoveredAt + 1));
    return { ...result, evidence: await store.save("release-abort-complete.json", Buffer.from(JSON.stringify(result))) };
}
export async function recoverProductionRelease(env) {
    check(env.NATIVE_OPERATION === "recover-release" && /^native-[1-9][0-9]+$/.test(env.NATIVE_VERIFY_RELEASE ?? ""), "explicit failed release required.");
    if (env.NATIVE_VERIFY_RELEASE === "native-" + protectedConfig("resource_0c384d07e61b")) {
        const { recoverCreationRelease } = await import("./native-production-creation-recovery.mjs");
        return recoverCreationRelease(env);
    }
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call);
    return executeProductionReleaseAbort({ cf, store, releaseId: env.NATIVE_VERIFY_RELEASE, recoveryRunId: env.GITHUB_RUN_ID,
        verifierSourceCommit: env.GITHUB_SHA, currentRuntime: () => verifyCurrentProductionRuntime(call) });
}
