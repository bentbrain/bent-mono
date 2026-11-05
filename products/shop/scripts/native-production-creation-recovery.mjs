import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { createHash } from "node:crypto";
import { productionAWS } from "./native-production-ci.mjs";
import { productionCloudflare, inspectProductionConsumer } from "./native-production-cloudflare.mjs";
import { productionReleaseStore } from "./native-production-release-store.mjs";
import { verifyCurrentProductionRuntime } from "./native-production-image.mjs";
import { inspectDevelopmentWorker, versionResourcesDigest, workerContentManifest } from "./native-ci-worker.mjs";
import { assertReleasePaused, recordReleaseEvent, resumeVerifiedRelease, verifyPauseSchema } from "./native-release-pause.mjs";
import { switchRecordedProductionVersion, verifyRecordedProductionVersion } from "./native-production-release.mjs";
import { runProductionMonitor } from "./native-production-monitor.mjs";
export const CREATION_FAILED_RELEASE = "native-" + protectedConfig("resource_0c384d07e61b");
const PRIOR_RELEASE = "native-" + protectedConfig("resource_2f229d3bccd4"), FAILED_SOURCE = "bb53fd0bc7e319a93768524546b8b6f305e2872b";
const ORIGINAL_INSPECTION = { key: "source/releases/native-" + protectedConfig("resource_d24e537c07b2") + "/release-inspection.json",
    version: "ZRzpPG74bKqsWpjPJqb9VcvhJ0gYs_FN", sha256: protectedConfig("resource_e63e06a34dff") };
const INSPECTION = { key: "source/releases/native-" + protectedConfig("resource_6da6f18e6cfd") + "/release-inspection.json",
    version: "d4aFTxXyY4IGxNrke4b4Yge_3DZro.g1", sha256: protectedConfig("resource_9e324058f78d") };
const VERSION = protectedConfig("resource_0ea872585018");
const STAGES = ["prepared", "cloud-pause-verified", "drained", "runtime-image-verified", "migration-verified", "fallback-deploy-started", "creation-recovery-started"];
const check = (value, reason) => { if (!value)
    throw Error(`Creation release recovery stopped: ${reason}`); };
const hash = value => createHash("sha256").update(value).digest("hex");
const verifyRecoveryMonitoring = (baseline, observed) => {
    // This sealed recovery may itself follow a prolonged held pause. An overdue
    // pause alert is expected; changed readiness breaches are not.
    check(observed?.monitoringVerified === true && typeof observed.pauseOverdue === "boolean" &&
        Number.isSafeInteger(observed.breaches) && observed.breaches >= 0 && observed.breaches < 1000 &&
        /^[a-f0-9]{64}$/.test(observed.breachCohortSha256 ?? "") &&
        baseline?.breaches === observed.breaches && baseline.breachCohortSha256 === observed.breachCohortSha256, "readiness breach cohort changed.");
};
export function verifyCreationRecoverySnapshot(snapshot) {
    check(snapshot.releaseId === CREATION_FAILED_RELEASE && equal(snapshot.control, [{ paused: 1,
            release_id: CREATION_FAILED_RELEASE, paused_at: 1788667485009, current_release_id: PRIOR_RELEASE }]), "exact inspected pause.");
    check(equal(snapshot.records?.map(row => row.stage), STAGES), "exact interrupted fallback boundary.");
    check(equal(snapshot.worker?.activeVersions, [{ version_id: VERSION, percentage: 100 }]) && snapshot.worker.latestVersion === VERSION &&
        snapshot.worker.content?.sha256 === protectedConfig("resource_482fde8c090a") &&
        snapshot.worker.versionResources?.length === 1 && snapshot.worker.versionResources[0].id === VERSION &&
        snapshot.worker.versionResources[0].sha256 === protectedConfig("resource_0875ba886dc3"), "exact inspected active version and resources.");
    check(equal(snapshot.jobs, [{ status: "ready", count: 472 }]), "inspected drain.");
}
export async function executeCreationRecovery({ cf, store, runtime, monitor, runId, sourceCommit, now = Date.now, inspect = inspectDevelopmentWorker, switchVersion = switchRecordedProductionVersion, verifyVersion = verifyRecordedProductionVersion, resume = resumeVerifiedRelease }) {
    check(/^[1-9][0-9]+$/.test(runId) && /^[a-f0-9]{40}$/.test(sourceCommit), "recovery run identity.");
    const snapshot = JSON.parse(await store.read(INSPECTION));
    verifyCreationRecoverySnapshot(snapshot);
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const events = release => query("SELECT stage,payload,created_at FROM native_video_release_events WHERE release_id=? ORDER BY created_at,stage", [release]);
    const records = await events(CREATION_FAILED_RELEASE);
    check(equal(records, snapshot.records), "release history changed or recovery already started; never replay.");
    await verifyPauseSchema(cf);
    const pause = await assertReleasePaused(cf, CREATION_FAILED_RELEASE);
    check(pause.paused_at === snapshot.control[0].paused_at && now() - pause.paused_at >= 300000, "original full execution hold.");
    check(equal(await query("SELECT paused,release_id,paused_at,current_release_id FROM native_video_release_control WHERE singleton=1"), snapshot.control), "pause ownership changed.");
    check((await query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status='rendering'"))[0]?.count === 0, "active render remains.");
    const event = (rows, stage) => JSON.parse(rows.find(row => row.stage === stage)?.payload ?? "null");
    const { preparation, ...prepared } = event(records, "prepared");
    check(prepared.releaseId === CREATION_FAILED_RELEASE && prepared.sourceCommit === FAILED_SOURCE &&
        prepared.environment === "production" && prepared.accountId === protectedConfig("awsAccountId") && prepared.region === "ap-southeast-2" &&
        equal(JSON.parse(await store.read(preparation)), prepared), "immutable failed preparation.");
    const image = event(records, "runtime-image-verified");
    check(image.review?.startupVerified === true && equal(image.review.runtime, prepared.runtime) &&
        equal(await runtime(), prepared.runtime), "runtime must still be the unchanged prior image pair.");
    const active = await inspect(cf);
    check(active.workerVersion === VERSION && equal(active.content, snapshot.worker.content) &&
        active.versionResourcesSha256 === snapshot.worker.versionResources[0].sha256 &&
        equal(await inspectProductionConsumer(cf), snapshot.consumer) && equal(await cf.schedules(), snapshot.schedules), "inspected live fallback changed.");
    check(hash(await store.read(prepared.artifacts.candidateArtifact)) === prepared.worker.bundleSha256 &&
        active.content.modules?.length === 1 && active.content.modules[0].sha256 === prepared.worker.bundleSha256, "live fallback is the immutable failed candidate.");
    const priorRows = await events(PRIOR_RELEASE), priorEvent = event(priorRows, "prepared"), terminal = event(priorRows, "verified");
    check(priorEvent && terminal?.releaseId === PRIOR_RELEASE && terminal.provider === "lambda" && terminal.rollbackRehearsed === true, "prior admitted native pair and rehearsed fallback.");
    const { preparation: priorReference, ...prior } = priorEvent;
    check(prior.releaseId === PRIOR_RELEASE && prior.environment === "production" && prior.accountId === protectedConfig("awsAccountId") &&
        equal(JSON.parse(await store.read(priorReference)), prior), "immutable prior preparation.");
    const { provider, consumer, cron, ...priorNative } = terminal.native ?? {};
    check(provider === "lambda" && equal(priorNative, prepared.previous.worker) && equal(consumer, prepared.previous.consumer), "failed release preserved the admitted native version.");
    const fallbackEvent = event(priorRows, "fallback-verified"), fallback = JSON.parse(await store.read(fallbackEvent.artifact));
    check(equal(fallback, fallbackEvent.fallback) && equal(fallback, terminal.fallback) && fallback.provider === "cloudflare" &&
        fallback.workerBytesVerified === true && /^[a-f0-9-]{36}$/.test(fallback.workerVersion) &&
        fallback.consumer?.consumerId === snapshot.consumer.consumerId, "original verified compatible fallback, not the interrupted one.");
    const started = event(records, "creation-recovery-started"), originalIntent = JSON.parse(await store.read(started.intent));
    check(started.runId === protectedConfig("resource_28a45a0ece57") && originalIntent.runId === started.runId &&
        originalIntent.sourceCommit === "37c4137244c4e5517ebfd3a913e92552e09d6a7e" &&
        originalIntent.releaseId === CREATION_FAILED_RELEASE && originalIntent.priorReleaseId === PRIOR_RELEASE &&
        equal(originalIntent.inspection, ORIGINAL_INSPECTION) && equal(originalIntent.preparation, preparation) &&
        equal(originalIntent.priorReference, priorReference) && equal(originalIntent.fallbackArtifact, fallbackEvent.artifact), "exact prior intent rejected before dispatch; no replacement target.");
    const original = JSON.parse(await store.read(prior.artifacts.previousArtifact));
    check(equal(original.before, prior.previous.worker), "preserved prior settings.");
    const bytes = await store.read(prior.artifacts.candidateArtifact);
    check(hash(bytes) === prior.worker.bundleSha256 && equal(await workerContentManifest(new Response(bytes)), fallback.content) &&
        versionResourcesDigest(await cf.version(fallback.workerVersion)) === fallback.versionResourcesSha256, "retained fallback bytes and immutable resources.");
    verifyRecoveryMonitoring(prepared.monitoringBaseline, await monitor());
    check(equal(await events(CREATION_FAILED_RELEASE), records), "release changed during recovery review.");
    const intent = await store.save("creation-recovery-continuation-intent.json", Buffer.from(JSON.stringify({ releaseId: CREATION_FAILED_RELEASE,
        priorReleaseId: PRIOR_RELEASE, inspection: INSPECTION, preparation, priorReference, fallbackArtifact: fallbackEvent.artifact,
        priorIntent: started.intent, runId, sourceCommit })));
    await recordReleaseEvent(cf, CREATION_FAILED_RELEASE, "creation-recovery-continuation-started", { runId, intent });
    const restored = await switchVersion(cf, CREATION_FAILED_RELEASE, fallback, prior.variables, original.settings);
    const result = await resume(cf, CREATION_FAILED_RELEASE, async () => {
        check(equal(await runtime(), prepared.runtime), "runtime changed during restoration.");
        await verifyVersion(cf, fallback, prior.variables, original.settings);
        verifyRecoveryMonitoring(prepared.monitoringBaseline, await monitor());
        return { rollbackVerified: true, fromReleaseId: PRIOR_RELEASE, releaseId: CREATION_FAILED_RELEASE,
            provider: "cloudflare", restored, retainedNativeRuntime: true, retainedSchemaAndMedia: true,
            recoveryRunId: runId, inspection: INSPECTION };
    });
    return { ...result, evidence: await store.save("creation-recovery-complete.json", Buffer.from(JSON.stringify(result))) };
}
export async function recoverCreationRelease(env) {
    check(env.NATIVE_OPERATION === "recover-release" && env.NATIVE_VERIFY_RELEASE === CREATION_FAILED_RELEASE, "explicit inspected release only.");
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call);
    return executeCreationRecovery({ cf, store, runtime: () => verifyCurrentProductionRuntime(call),
        monitor: () => runProductionMonitor({ ...env, NATIVE_OPERATION: "monitor" }), runId: env.GITHUB_RUN_ID, sourceCommit: env.GITHUB_SHA });
}
