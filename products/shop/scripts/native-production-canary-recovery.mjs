import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { productionAWS } from "./native-production-ci.mjs";
import { productionCloudflare } from "./native-production-cloudflare.mjs";
import { productionReleaseStore } from "./native-production-release-store.mjs";
import { verifyProductionRuntime } from "./native-production-runtime.mjs";
import { verifyProductionPairStatus, verifyRecordedProductionVersion } from "./native-production-release.mjs";
import { verifyPauseSchema, assertReleasePaused, recordReleaseEvent } from "./native-release-pause.mjs";
import { canaryArtworkKey, canaryFailureStage } from "./native-production-canary.mjs";
const RELEASE = "native-" + protectedConfig("resource_99eca93d1134"), FAILED_RUN = protectedConfig("resource_0cee8f722ce6"), PRIOR_FAILED_RUN = protectedConfig("resource_366cf2abe0fe");
const SOURCE = { kind: "synthetic-colour-blocks-v1", byte_size: 204510, artwork_width: 2400, artwork_height: 3000,
    sha256: "ed234ac311653a0c78954716d16266f2ef124b37ddb780d96d7d3fa5ad6b60bc", customerArtworkRead: false };
const check = (value, reason) => { if (!value)
    throw Error(`Production canary recovery stopped: ${reason}`); };
const sha = value => createHash("sha256").update(value).digest("hex");
const encodedRun = runId => [...runId].map(value => String.fromCharCode(97 + Number(value))).join("");
export function canaryRecoveryStage(state, runId) {
    check(["start", "done"].includes(state) && /^[1-9][0-9]+$/.test(runId ?? ""), "recovery event identity.");
    return `canary-recovery-${state}-${encodedRun(runId)}`;
}
export function verifyReviewedCanaryFailure({ fixture, control, failed, failedAt, designCount, activeCount, priorRecovery }) {
    check(fixture.releaseId === RELEASE && /^[a-f0-9-]{36}$/.test(fixture.designId) &&
        fixture.artworkKey === canaryArtworkKey(fixture.designId, SOURCE.sha256) && Number.isSafeInteger(fixture.createdAt) &&
        equal(fixture.source, SOURCE) && /^[A-Za-z0-9_-]{43}$/.test(fixture.sessionToken) && sha(fixture.sessionToken) === fixture.ownerId, "exact immutable failed fixture with the corrected production key.");
    check(control?.paused === 1 && control.release_id === RELEASE && control.current_release_id === RELEASE &&
        Number.isSafeInteger(control.paused_at) && control.paused_at >= fixture.createdAt, "exact canary-owned admission pause.");
    check(failed?.runId === FAILED_RUN && failed.admissionsPaused === true && Number.isSafeInteger(failedAt) &&
        failedAt >= fixture.createdAt && failedAt - fixture.createdAt < 5 * 60 * 1000, "exact failed Actions run and bounded failure time.");
    check(designCount === 0 && activeCount === 0, "Cloudflare key guard stopped before R2-backed draft or video work.");
    check(priorRecovery?.failedRun === PRIOR_FAILED_RUN && priorRecovery.status?.protocolVerified === true &&
        priorRecovery.status.releaseId === RELEASE && priorRecovery.status.paused === false, "first reviewed failure was recovered before this independent pause.");
}
export async function recoverProductionCanary(env) {
    check(env.NATIVE_OPERATION === "recover-canary" && env.NATIVE_VERIFY_RELEASE === RELEASE, "explicit reviewed release only.");
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call);
    const fixtureObject = await store.readSingle(FAILED_RUN, "canary-fixture.json");
    const fixture = JSON.parse(fixtureObject.bytes.toString("utf8"));
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    await verifyPauseSchema(cf);
    const pause = await assertReleasePaused(cf, RELEASE);
    const controls = await query("SELECT paused,release_id,current_release_id,paused_at FROM native_video_release_control WHERE singleton=1");
    const failedRows = await query("SELECT payload,created_at FROM native_video_release_events WHERE release_id=? AND stage=?", [RELEASE, canaryFailureStage(FAILED_RUN)]);
    const designs = await query("SELECT COUNT(*) AS count FROM designs WHERE id=?", [fixture.designId]);
    const active = await query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status IN ('queued','rendering')");
    const priorRows = await query("SELECT payload FROM native_video_release_events WHERE release_id=? AND stage='canary-recovered'", [RELEASE]);
    check(controls.length === 1 && failedRows.length === 1 && designs.length === 1 && active.length === 1 && priorRows.length === 1 &&
        pause.paused_at === controls[0].paused_at, "complete reviewed failure state.");
    verifyReviewedCanaryFailure({ fixture, control: controls[0], failed: JSON.parse(failedRows[0].payload), failedAt: failedRows[0].created_at,
        designCount: designs[0].count, activeCount: active[0].count, priorRecovery: JSON.parse(priorRows[0].payload) });
    const verifiedRows = await query("SELECT payload FROM native_video_release_events WHERE release_id=? AND stage='verified'", [RELEASE]);
    const preparedRows = await query("SELECT payload FROM native_video_release_events WHERE release_id=? AND stage='prepared'", [RELEASE]);
    check(verifiedRows.length === 1 && preparedRows.length === 1, "completed paired release evidence.");
    const verified = JSON.parse(verifiedRows[0].payload), prepared = JSON.parse(preparedRows[0].payload);
    const original = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    check(verified.releaseId === RELEASE && verified.provider === "lambda" && verified.rollbackRehearsed === true &&
        equal(await verifyProductionRuntime(call), prepared.runtime), "unchanged qualified Lambda pair.");
    await verifyRecordedProductionVersion(cf, verified.native, prepared.variables, original.settings);
    await verifyProductionPairStatus(env, RELEASE, verified.sourceCommit, true);
    const intent = await store.save("canary-recovery-intent.json", Buffer.from(JSON.stringify({ releaseId: RELEASE, failedRun: FAILED_RUN,
        failedFixture: fixtureObject.reference, rootCause: "canary-r2-key-guard-outdated", correctedArtworkKey: fixture.artworkKey,
        runId: env.GITHUB_RUN_ID, verifierSourceCommit: env.GITHUB_SHA })));
    await recordReleaseEvent(cf, RELEASE, canaryRecoveryStage("start", FAILED_RUN), { runId: env.GITHUB_RUN_ID, failedRun: FAILED_RUN, intent });
    const resumedAt = Date.now();
    await cf.query(`UPDATE native_video_release_control SET paused=0,release_id=NULL,updated_at=?
    WHERE singleton=1 AND paused=1 AND release_id=? AND current_release_id=? AND paused_at=?`, [resumedAt, RELEASE, RELEASE, pause.paused_at]);
    const resumed = await query("SELECT paused,release_id,current_release_id FROM native_video_release_control WHERE singleton=1");
    check(resumed.length === 1 && resumed[0].paused === 0 && resumed[0].release_id === null && resumed[0].current_release_id === RELEASE, "admission resume was not confirmed.");
    const status = await verifyProductionPairStatus(env, RELEASE, verified.sourceCommit, false);
    const result = { canaryRecovered: true, releaseId: RELEASE, failedRun: FAILED_RUN, intent, status,
        immutableArtworkKeyAllowed: true, retainedSyntheticFixture: true };
    await recordReleaseEvent(cf, RELEASE, canaryRecoveryStage("done", FAILED_RUN), { runId: env.GITHUB_RUN_ID, ...result });
    return result;
}
