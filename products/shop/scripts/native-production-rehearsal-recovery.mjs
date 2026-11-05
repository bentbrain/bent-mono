import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { productionAWS } from "./native-production-ci.mjs";
import { productionCloudflare, inspectProductionConsumer } from "./native-production-cloudflare.mjs";
import { productionReleaseStore } from "./native-production-release-store.mjs";
import { verifyProductionRuntime } from "./native-production-runtime.mjs";
import { verifyRecordedProductionVersion, verifyProductionPairStatus, waitForProductionPairStatus, completeProductionRehearsal, switchRecordedProductionVersion } from "./native-production-release.mjs";
import { inspectDevelopmentWorker as inspectWorker, workerContentManifest, versionResourcesDigest } from "./native-ci-worker.mjs";
import { assertReleasePaused, verifyPauseSchema, recordReleaseEvent, resumeVerifiedRelease } from "./native-release-pause.mjs";
import { productionMonitoringBaseline, runProductionMonitor } from "./native-production-monitor.mjs";
const RELEASE = "native-" + protectedConfig("resource_df582621cced"), SOURCE = "04327dc2fcbc6761d098c3eba9d6c5c240b9e667";
const SNAPSHOT = { key: "source/releases/native-" + protectedConfig("resource_8908850822e2") + "/release-inspection.json", version: "jtmcy.naZXzgR.ZtbT2RSHXveMPstCTa",
    sha256: protectedConfig("resource_4777aad2e64e") };
const FORWARD_RELEASE = "native-" + protectedConfig("resource_1f80479a3ff7"), FORWARD_SOURCE = "9c3083071d4e41f4cf13f885091c5fc16c113f17";
const FORWARD_SNAPSHOT = { key: "source/releases/native-" + protectedConfig("resource_53ed80b16d15") + "/release-inspection.json", version: "QOgFbT4IH9865eWXThKOlZqL06w_vpYD",
    sha256: protectedConfig("resource_927d6ea69a8d") };
const ISSUE_209_RELEASE = "native-" + protectedConfig("resource_14950b570946"), ISSUE_209_SOURCE = "c5684a1ad6d820e6e12644521e755a1a4868244e";
const ISSUE_209_SNAPSHOT = { key: "source/releases/native-" + protectedConfig("resource_b5c8436025ef") + "/release-inspection.json", version: "Cte.7r44Vi5jLOLc10wkPpeLevP9IPGb",
    sha256: protectedConfig("resource_ccb59341a3e8") };
const check = (value, reason) => { if (!value)
    throw Error(`Production rehearsal recovery stopped: ${reason}`); };
export function verifyReviewedRehearsalSnapshot(snapshot) {
    check(snapshot.releaseId === RELEASE && snapshot.control?.length === 1 && snapshot.control[0].paused === 1 &&
        snapshot.control[0].release_id === RELEASE && snapshot.control[0].current_release_id === null && snapshot.control[0].paused_at === 1787960796008, "exact original held pause.");
    check(equal(snapshot.records?.map(row => row.stage), ["prepared", "cloud-pause-verified", "drained", "migration-verified", "secret-install-started",
        "fallback-deploy-started", "fallback-verified", "native-deploy-started", "native-verified"]), "only the reviewed interrupted rehearsal, no retry or later release.");
    check(equal(snapshot.worker.activeVersions, [{ version_id: protectedConfig("resource_b4efc1b4ee71"), percentage: 100 }]) &&
        snapshot.worker.latestVersion === protectedConfig("resource_030ac180b0a9"), "exact uploaded native and active fallback versions.");
}
export function verifyReviewedForwardSnapshot(snapshot) {
    check(snapshot.releaseId === FORWARD_RELEASE && snapshot.control?.length === 1 && snapshot.control[0].paused === 1 &&
        snapshot.control[0].release_id === FORWARD_RELEASE && snapshot.control[0].current_release_id === "native-" + protectedConfig("resource_5c5e5c63a22e") &&
        snapshot.control[0].paused_at === 1788230352102, "exact forward-rehearsed held pause.");
    check(equal(snapshot.records?.map(row => row.stage), ["prepared", "cloud-pause-verified", "drained", "runtime-image-verified",
        "migration-verified", "secret-install-started", "fallback-deploy-started", "fallback-verified", "native-deploy-started",
        "native-verified", "rollback-rehearsed", "forward-rehearsed"]), "exact forward-rehearsed stage boundary.");
    check(equal(snapshot.worker?.activeVersions, [{ version_id: protectedConfig("resource_9053a89f6361"), percentage: 100 }]) &&
        snapshot.worker.latestVersion === protectedConfig("resource_9053a89f6361") && snapshot.consumer?.settings?.max_concurrency === 2 &&
        snapshot.canaryAssets?.length === 4 && snapshot.canaryAssets.every(asset => asset.status === "ready" && asset.error === null) &&
        !snapshot.jobs?.some(row => row.status === "rendering"), "exact active native version and drained snapshot.");
}
export function verifyReviewedIssue209Snapshot(snapshot) {
    const bindings = ["STORY_VIDEO_TRANSPORT", "STORY_VIDEO_WARM_ON_CONFIRM", "STORY_VIDEO_PROVIDER", "STORY_VIDEO_ENVIRONMENT",
        "STORY_VIDEO_LAMBDA_FUNCTION", "STORY_VIDEO_FAMILY_CONFIGURATION", "STORY_VIDEO_LANES", "STORY_VIDEO_NOTIFICATION_MODE",
        "STORY_VIDEO_RELEASE_ID", "STORY_VIDEO_RELEASE_COMMIT", "STORY_VIDEO_IMAGE_DIGEST", "STORY_VIDEO_SOURCE_DIGEST"];
    check(snapshot.releaseId === ISSUE_209_RELEASE && snapshot.control?.length === 1 && snapshot.control[0].paused === 1 &&
        snapshot.control[0].release_id === ISSUE_209_RELEASE && snapshot.control[0].current_release_id === "native-" + protectedConfig("resource_7adca284c1f4") &&
        snapshot.control[0].paused_at === 1788252457709, "exact Issue 209 held pause.");
    check(equal(snapshot.records?.map(row => row.stage), ["prepared", "cloud-pause-verified", "drained", "runtime-image-verified",
        "migration-verified", "fallback-deploy-started", "fallback-verified", "native-deploy-started"]), "exact post-native-deploy propagation boundary.");
    const version = snapshot.worker?.versionResources?.[0];
    check(equal(snapshot.worker.activeVersions, [{ version_id: protectedConfig("resource_6d9bdeb32755"), percentage: 100 }]) &&
        snapshot.worker.latestVersion === protectedConfig("resource_6d9bdeb32755") && version?.id === snapshot.worker.latestVersion &&
        version.sha256 === protectedConfig("resource_23a19465abe4") &&
        snapshot.worker.content?.sha256 === protectedConfig("resource_98b9cc41d14e") &&
        snapshot.worker.content?.entrypoint === "index.js" && snapshot.worker.content?.modules?.length === 1 &&
        snapshot.worker.content.modules[0].name === "index.js" && snapshot.worker.content.modules[0].bytes === 2089891 &&
        snapshot.worker.content.modules[0].sha256 === protectedConfig("resource_cc505cba05ae") &&
        equal(version.bindings?.map(binding => binding.name), bindings) &&
        version.bindings.every(binding => binding.count === 1 && binding.type === "plain_text" && binding.textMatches === true) &&
        equal(snapshot.consumer?.settings, { batch_size: 1, max_retries: 100, max_wait_time_ms: 1000, max_concurrency: 2, retry_delay: 10 }) &&
        snapshot.schedules?.schedules?.length === 1 && snapshot.schedules.schedules[0].cron === "* * * * *" &&
        snapshot.migrations?.at(-1)?.name === "0024_story_video_renderer_v7.sql" &&
        equal(snapshot.jobs, [{ status: "failed", count: 104 }, { status: "ready", count: 128 }]) &&
        snapshot.canaryAssets?.length === 4 && snapshot.canaryAssets.every(asset => asset.status === "ready" && asset.error === null), "exact active qualified Worker and drained runtime snapshot.");
}
async function recoverIssue209Promotion(env) {
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call);
    const snapshot = JSON.parse(await store.read(ISSUE_209_SNAPSHOT));
    verifyReviewedIssue209Snapshot(snapshot);
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const records = await query("SELECT stage,payload,created_at FROM native_video_release_events WHERE release_id=? ORDER BY created_at,stage", [ISSUE_209_RELEASE]);
    check(equal(records, snapshot.records), "Issue 209 release stages changed or recovery already started; never replay.");
    await verifyPauseSchema(cf);
    const pause = await assertReleasePaused(cf, ISSUE_209_RELEASE);
    check(pause.paused_at === snapshot.control[0].paused_at && Date.now() - pause.paused_at >= 300000, "original Issue 209 pause and full execution hold.");
    check((await query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status='rendering'"))[0]?.count === 0, "no active execution.");
    const event = stage => JSON.parse(records.find(record => record.stage === stage).payload);
    const { preparation, ...prepared } = event("prepared");
    check(prepared.releaseId === ISSUE_209_RELEASE && prepared.sourceCommit === ISSUE_209_SOURCE &&
        equal(JSON.parse(await store.read(preparation)), prepared), "original immutable Issue 209 preparation.");
    const imageEvent = event("runtime-image-verified"), migration = event("migration-verified"), fallbackEvent = event("fallback-verified");
    check(imageEvent.review?.startupVerified === true && imageEvent.review.runtime?.runtimeVerified === true &&
        equal(imageEvent.plan, prepared.imagePlanArtifact) && equal(migration, { executionProtocol: "claim-v1", migration: "0024_story_video_renderer_v7.sql" }), "verified Issue 209 runtime and migration.");
    const fallback = JSON.parse(await store.read(fallbackEvent.artifact));
    check(equal(fallback, fallbackEvent.fallback) && fallback.provider === "cloudflare", "preserved compatible Issue 209 fallback.");
    const original = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    check(equal(original.before, prepared.previous.worker), "preserved prior Worker baseline.");
    const candidateContent = await workerContentManifest(new Response(await store.read(prepared.artifacts.candidateArtifact)));
    const inspected = await inspectWorker(cf), consumer = await inspectProductionConsumer(cf);
    const native = { ...inspected, provider: "lambda", consumer, cron: "* * * * *" };
    check(inspected.workerVersion === snapshot.worker.latestVersion && equal(inspected.content, snapshot.worker.content) &&
        equal(candidateContent, inspected.content) && inspected.versionResourcesSha256 === snapshot.worker.versionResources[0].sha256 &&
        equal(consumer, snapshot.consumer), "active Issue 209 native version is the immutable prepared Worker.");
    await verifyRecordedProductionVersion(cf, native, prepared.variables, original.settings);
    const runtime = () => verifyProductionRuntime(call), expectedRuntime = imageEvent.review.runtime;
    check(equal(await runtime(), expectedRuntime), "unchanged qualified Issue 209 Lambda pair.");
    const status = (paused = true) => waitForProductionPairStatus(env, ISSUE_209_RELEASE, ISSUE_209_SOURCE, paused);
    await status();
    const monitor = () => runProductionMonitor({ ...env, NATIVE_OPERATION: "monitor" });
    const health = await monitor();
    check(health.monitoringVerified && !health.pauseOverdue, "working monitoring before Issue 209 recovery.");
    const intent = await store.save("rehearsal-recovery-intent.json", Buffer.from(JSON.stringify({ releaseId: ISSUE_209_RELEASE,
        inspection: ISSUE_209_SNAPSHOT, preparation, fallbackArtifact: fallbackEvent.artifact, activeWorkerVersion: native.workerVersion,
        runId: env.GITHUB_RUN_ID, verifierSourceCommit: env.GITHUB_SHA })));
    await recordReleaseEvent(cf, ISSUE_209_RELEASE, "rehearsal-recovery-started", { runId: env.GITHUB_RUN_ID, intent });
    const nativeArtifact = await store.save("native-worker.json", Buffer.from(JSON.stringify(native)));
    await recordReleaseEvent(cf, ISSUE_209_RELEASE, "native-verified", { native, artifact: nativeArtifact, recoveredFrom: ISSUE_209_SNAPSHOT });
    const result = await completeProductionRehearsal({ cf, prepared, native, fallback, variables: prepared.variables, previousSettings: original.settings,
        runtime, expectedRuntime, status, monitor, monitoringBaseline: prepared.monitoringBaseline });
    await status(false);
    return { ...result, pairedReleaseComplete: true, recoveredRehearsal: true, propagationRecovered: true, recoveryRunId: env.GITHUB_RUN_ID,
        evidence: await store.save("release-complete.json", Buffer.from(JSON.stringify(result))) };
}
async function recoverForwardRehearsed(env) {
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call);
    const snapshot = JSON.parse(await store.read(FORWARD_SNAPSHOT));
    verifyReviewedForwardSnapshot(snapshot);
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const records = await query("SELECT stage,payload,created_at FROM native_video_release_events WHERE release_id=? ORDER BY created_at,stage", [FORWARD_RELEASE]);
    check(equal(records, snapshot.records), "forward-rehearsed stages changed or recovery already started; never replay.");
    await verifyPauseSchema(cf);
    const pause = await assertReleasePaused(cf, FORWARD_RELEASE);
    check(pause.paused_at === snapshot.control[0].paused_at && Date.now() - pause.paused_at >= 300000, "original pause and full execution hold.");
    check((await query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status='rendering'"))[0]?.count === 0, "no active execution.");
    const event = stage => JSON.parse(records.find(record => record.stage === stage).payload);
    const { preparation, ...prepared } = event("prepared");
    check(prepared.releaseId === FORWARD_RELEASE && prepared.sourceCommit === FORWARD_SOURCE &&
        equal(JSON.parse(await store.read(preparation)), prepared), "original immutable forward preparation.");
    const imageEvent = event("runtime-image-verified"), fallbackEvent = event("fallback-verified"), nativeEvent = event("native-verified");
    check(imageEvent.review?.startupVerified === true && imageEvent.review.runtime?.runtimeVerified === true &&
        equal(imageEvent.plan, prepared.imagePlanArtifact), "verified paired runtime update.");
    const fallback = JSON.parse(await store.read(fallbackEvent.artifact)), native = JSON.parse(await store.read(nativeEvent.artifact));
    check(equal(fallback, fallbackEvent.fallback) && equal(native, nativeEvent.native) && fallback.provider === "cloudflare" && native.provider === "lambda" &&
        native.workerVersion === snapshot.worker.latestVersion, "both preserved forward-rehearsed versions.");
    const original = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    check(equal(original.before, prepared.previous.worker), "original compatible Worker artifact.");
    const content = await workerContentManifest(new Response(await store.read(prepared.artifacts.candidateArtifact)));
    check(equal(content, native.content) && equal(content, fallback.content) && (await cf.versions()).items?.[0]?.id === native.workerVersion &&
        equal(await workerContentManifest(await cf.content()), content) &&
        versionResourcesDigest(await cf.version(native.workerVersion)) === native.versionResourcesSha256 &&
        versionResourcesDigest(await cf.version(fallback.workerVersion)) === fallback.versionResourcesSha256, "immutable native/fallback bytes and resources.");
    await verifyRecordedProductionVersion(cf, native, prepared.variables, original.settings);
    const runtime = () => verifyProductionRuntime(call), expectedRuntime = imageEvent.review.runtime;
    check(equal(await runtime(), expectedRuntime), "unchanged qualified Lambda pair.");
    const status = () => verifyProductionPairStatus(env, FORWARD_RELEASE, FORWARD_SOURCE);
    await status();
    const monitor = () => runProductionMonitor({ ...env, NATIVE_OPERATION: "monitor" });
    const health = await monitor();
    check(health.monitoringVerified && health.breaches === 20 && health.sampledFamilies === 20 && health.completedFamilies === 0 && !health.pauseOverdue, "exact known pre-pause readiness backlog.");
    const intent = await store.save("monitor-fallback-recovery-intent.json", Buffer.from(JSON.stringify({ releaseId: FORWARD_RELEASE,
        inspection: FORWARD_SNAPSHOT, preparation, nativeArtifact: nativeEvent.artifact, fallbackArtifact: fallbackEvent.artifact,
        monitoring: health.evidence, runId: env.GITHUB_RUN_ID, verifierSourceCommit: env.GITHUB_SHA })));
    await recordReleaseEvent(cf, FORWARD_RELEASE, "rehearsal-recovery-started", { runId: env.GITHUB_RUN_ID, intent });
    const restored = await switchRecordedProductionVersion(cf, FORWARD_RELEASE, fallback, prepared.variables, original.settings);
    await recordReleaseEvent(cf, FORWARD_RELEASE, "monitor-fallback-recovered", restored);
    const result = await resumeVerifiedRelease(cf, FORWARD_RELEASE, async () => {
        check(equal(await runtime(), expectedRuntime), "qualified runtime changed before admission.");
        await verifyRecordedProductionVersion(cf, fallback, prepared.variables, original.settings);
        const monitoring = await monitor();
        check(monitoring.monitoringVerified && monitoring.breaches === 20 && monitoring.sampledFamilies === 20 &&
            monitoring.completedFamilies === 0 && !monitoring.pauseOverdue, "known backlog and working monitoring required before fallback admission.");
        return { environment: "production", releaseId: FORWARD_RELEASE, sourceCommit: FORWARD_SOURCE, candidate: prepared.candidate, native, fallback,
            runtime: expectedRuntime, restored, monitoring: monitoring.evidence, rollbackRehearsed: true, provider: "cloudflare",
            retainedQualifiedRuntime: true, recoveredMonitoringGate: false };
    });
    await verifyRecordedProductionVersion(cf, fallback, prepared.variables, original.settings);
    return { ...result, pairedReleaseComplete: true, recoveredRehearsal: true, fallbackAdmissionRestored: true, recoveryRunId: env.GITHUB_RUN_ID,
        evidence: await store.save("release-complete.json", Buffer.from(JSON.stringify(result))) };
}
export async function recoverProductionRehearsal(env) {
    if (env.NATIVE_OPERATION === "recover-rehearsal" && env.NATIVE_VERIFY_RELEASE === ISSUE_209_RELEASE)
        return recoverIssue209Promotion(env);
    if (env.NATIVE_OPERATION === "recover-rehearsal" && env.NATIVE_VERIFY_RELEASE === FORWARD_RELEASE)
        return recoverForwardRehearsed(env);
    check(env.NATIVE_OPERATION === "recover-rehearsal" && env.NATIVE_VERIFY_RELEASE === RELEASE, "explicit reviewed release only.");
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call);
    const snapshot = JSON.parse(await store.read(SNAPSHOT));
    verifyReviewedRehearsalSnapshot(snapshot);
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const records = await query("SELECT stage,payload,created_at FROM native_video_release_events WHERE release_id=? ORDER BY created_at,stage", [RELEASE]);
    check(equal(records, snapshot.records), "release stages changed or recovery already started; never replay.");
    await verifyPauseSchema(cf);
    const pause = await assertReleasePaused(cf, RELEASE);
    check(pause.paused_at === snapshot.control[0].paused_at && Date.now() - pause.paused_at >= 300000, "original pause and full execution hold.");
    check((await query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status='rendering'"))[0]?.count === 0, "no active execution.");
    const event = stage => JSON.parse(records.find(record => record.stage === stage).payload);
    const { preparation, ...prepared } = event("prepared");
    check(prepared.releaseId === RELEASE && prepared.sourceCommit === SOURCE && equal(JSON.parse(await store.read(preparation)), prepared), "original immutable preparation.");
    const fallbackEvent = event("fallback-verified"), nativeEvent = event("native-verified");
    const fallback = JSON.parse(await store.read(fallbackEvent.artifact)), native = JSON.parse(await store.read(nativeEvent.artifact));
    check(equal(fallback, fallbackEvent.fallback) && equal(native, nativeEvent.native) && fallback.workerVersion === protectedConfig("resource_b4efc1b4ee71") &&
        native.workerVersion === protectedConfig("resource_030ac180b0a9") && fallback.provider === "cloudflare" && native.provider === "lambda", "both preserved verified versions.");
    const original = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    check(equal(original.before, prepared.previous.worker), "original legacy artifact.");
    const content = await workerContentManifest(new Response(await store.read(prepared.artifacts.candidateArtifact)));
    check(equal(content, native.content) && equal(content, fallback.content), "unchanged qualified bundle for both providers.");
    check((await cf.versions()).items?.[0]?.id === native.workerVersion && equal(await workerContentManifest(await cf.content()), content) &&
        versionResourcesDigest(await cf.version(native.workerVersion)) === native.versionResourcesSha256, "latest native bytes and immutable bindings.");
    await verifyRecordedProductionVersion(cf, fallback, prepared.variables, original.settings);
    const runtime = () => verifyProductionRuntime(call);
    check(equal(await runtime(), prepared.runtime), "unchanged Lambda pair.");
    const monitor = () => runProductionMonitor({ ...env, NATIVE_OPERATION: "monitor" });
    const health = await monitor();
    check(health.monitoringVerified && health.breaches === 0 && !health.pauseOverdue, "healthy monitoring before recovery.");
    const intent = await store.save("rehearsal-recovery-intent.json", Buffer.from(JSON.stringify({ releaseId: RELEASE, inspection: SNAPSHOT, preparation,
        nativeArtifact: nativeEvent.artifact, fallbackArtifact: fallbackEvent.artifact, runId: env.GITHUB_RUN_ID, verifierSourceCommit: env.GITHUB_SHA })));
    await recordReleaseEvent(cf, RELEASE, "rehearsal-recovery-started", { runId: env.GITHUB_RUN_ID, intent });
    const status = () => verifyProductionPairStatus(env, RELEASE, SOURCE);
    const result = await completeProductionRehearsal({ cf, prepared, native, fallback, variables: prepared.variables, previousSettings: original.settings,
        runtime, status, monitor, monitoringBaseline: productionMonitoringBaseline(health) });
    await verifyProductionPairStatus(env, RELEASE, SOURCE, false);
    return { ...result, pairedReleaseComplete: true, recoveredRehearsal: true, recoveryRunId: env.GITHUB_RUN_ID,
        evidence: await store.save("release-complete.json", Buffer.from(JSON.stringify(result))) };
}
