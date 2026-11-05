import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { recordReleaseEvent } from './native-release-pause.mjs';
import { developmentOperation } from './native-ci-operation.mjs';
import { developmentCloudflare } from './native-ci-cloudflare.mjs';
import { createDevelopmentReleaseStore } from './native-ci-release-store.mjs';
import { failedQualificationReference, readQualificationRun } from './native-qualification-reference.mjs';
import { validateQualificationInventory, refreshFailedQualificationInventory, failedQualificationActiveJobs, assertQualificationCleanupFence, deleteQualificationInventory } from './native-qualification-inventory.mjs';
import { qualificationIdentity } from './native-qualification-identity.mjs';
import { loadDevelopmentRollback } from './native-ci-rollback.mjs';
import { inspectDevelopmentWorker, inspectDevelopmentConsumer, activeWorkerSettings } from './native-ci-worker.mjs';
import { inspectDevelopmentRuntime } from './native-ci-runtime.mjs';
import { loadActivePrintExecutorBaseline, developmentPrintExecutorClient, verifyRecordedPrintExecutor } from './native-print-executor.mjs';
import { developmentPrintStagingLifecycle } from './native-print-staging-lifecycle.mjs';
const check = (value, reason) => { if (!value)
    throw Error(`Failed qualification cleanup stopped: ${reason}`); };
const rows = async (cf, sql, params = []) => (await cf.query(sql, params))[0].results;
// A failed experiment can be cleaned while its pair is live or after that exact
// pair's recorded rollback. This does not authorize a different current release,
// change source qualification policy, or re-enable the rejected executor.
export async function inspectFailedQualificationCleanupState({ cf, store, env, originalReleaseId, prepared, inspectWorker = inspectDevelopmentWorker, inspectRuntime = inspectDevelopmentRuntime, inspectConsumer = inspectDevelopmentConsumer, inspectIdentity = qualificationIdentity, inspectExecutor = loadActivePrintExecutorBaseline, executorClient, staging, inspectRecordedExecutor = verifyRecordedPrintExecutor }) {
    const controls = await rows(cf, 'SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1');
    const control = controls[0];
    check(controls.length === 1 && control.paused === 0 && control.release_id === null && /^native-[1-9][0-9]*$/.test(control.current_release_id), 'current release must be verified and unpaused');
    const events = await rows(cf, "SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'verified'", [control.current_release_id]);
    check(events.length === 1, 'current release verification missing');
    const verified = JSON.parse(events[0].payload);
    let identity;
    if (control.current_release_id === originalReleaseId) {
        identity = await inspectIdentity(cf, store, { ...env, NATIVE_VERIFY_RELEASE: originalReleaseId });
        check(identity.releaseId === originalReleaseId && identity.sourceCommit === prepared.sourceCommit, 'live original source differs from its sealed preparation');
        await inspectRecordedExecutor({ env, api: cf, prepared, store, inspectWorker,
            ...(executorClient ? { client: executorClient } : {}), ...(staging ? { staging } : {}) });
    }
    else {
        check(verified.rollbackVerified === true && verified.releaseId === control.current_release_id && verified.fromReleaseId === originalReleaseId, 'current generation is neither the original experiment nor its exact recorded rollback');
        const rollback = await loadDevelopmentRollback(cf, store, originalReleaseId);
        check(equal(rollback.prepared, prepared) && equal(verified.target, rollback.target) &&
            verified.workerVersion === prepared.previous.worker.workerVersion, 'rollback target differs from original sealed predecessor');
        const worker = await inspectWorker(cf, rollback.artifact), runtime = await inspectRuntime(env);
        check(equal(worker, prepared.previous.worker) && equal(await inspectConsumer(cf), prepared.previous.consumer) &&
            runtime.renderer.imageDigest === rollback.target.imageDigest && runtime.failure.imageDigest === rollback.target.imageDigest &&
            runtime.renderer.sourceDigest === rollback.target.sourceDigest, 'current rollback Worker, consumer or Lambda pair changed');
        if (verified.worker?.printExecutor || verified.retainedPrintExecutor) {
            await inspectExecutor({ api: cf, store, inspectWorker,
                client: executorClient ?? developmentPrintExecutorClient(env), staging: staging ?? developmentPrintStagingLifecycle(env) });
        }
        else {
            const bindings = (await activeWorkerSettings(cf, prepared.previous.worker)).bindings ?? [];
            const modes = bindings.filter(binding => binding.name === 'PRINT_EXECUTION_MODE');
            check((modes.length === 0 || modes.length === 1 && modes[0].type === 'plain_text' && modes[0].text === 'queue') &&
                !bindings.some(binding => binding.name === 'PRINT_EXECUTIONS'), 'rollback has an unrecorded executor');
        }
        identity = { releaseId: control.current_release_id, rollbackOf: originalReleaseId, workerVersion: worker.workerVersion,
            workerResourcesSha256: worker.versionResourcesSha256, imageDigest: rollback.target.imageDigest };
    }
    const fence = { releaseId: control.current_release_id, verifiedPayload: events[0].payload };
    await assertQualificationCleanupFence(cf, fence);
    return { identity, fence };
}
export async function recoverFailedQualification(env = process.env, dependencies = {}) {
    check(developmentOperation(env) === 'cleanup-failed-qualification', 'dedicated first-attempt cleanup operation required');
    const { reference, runId } = failedQualificationReference(env.NATIVE_QUALIFICATION_REFERENCE, env.NATIVE_VERIFY_RELEASE);
    check(String(runId) !== env.GITHUB_RUN_ID, 'cleanup requires a distinct run');
    const cf = dependencies.cf ?? developmentCloudflare(env);
    const store = dependencies.store ?? await createDevelopmentReleaseStore(env);
    const readRun = dependencies.readRun ?? (id => readQualificationRun(env, id));
    const originalRun = await readRun(runId);
    check(originalRun.id === runId && originalRun.conclusion === 'failure' && originalRun.status === 'completed' &&
        originalRun.run_attempt === 1 && originalRun.event === 'workflow_dispatch' && originalRun.head_branch === 'main' &&
        originalRun.path === '.github/workflows/native-development.yml' && originalRun.repository?.id === Number(protectedConfig("githubRepositoryId")) &&
        originalRun.repository?.owner?.id === Number(protectedConfig("githubOwnerId")) && originalRun.head_repository?.id === Number(protectedConfig("githubRepositoryId")) &&
        /^[a-f0-9]{40}$/.test(originalRun.head_sha ?? '') &&
        new RegExp(`^Native development · (?:qualify-all|qualify-components) · full · ${env.NATIVE_VERIFY_RELEASE} · - · main · ${originalRun.head_sha} ·`).test(originalRun.display_title ?? ''), 'authenticated original failed full qualification identity');
    const originalEnv = { ...env, GITHUB_RUN_ID: String(runId), GITHUB_SHA: originalRun.head_sha };
    const originalBytes = await store.read(reference);
    const original = validateQualificationInventory(JSON.parse(originalBytes), originalEnv);
    check(original.fixtures.length > 0, 'original inventory contains no fixtures');
    const preparations = await rows(cf, "SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'prepared'", [env.NATIVE_VERIFY_RELEASE]);
    check(preparations.length === 1, 'original release preparation missing');
    const { preparation, ...prepared } = JSON.parse(preparations[0].payload);
    check(prepared.releaseId === original.releaseId && prepared.sourceCommit === originalRun.head_sha && prepared.environment === 'development' &&
        prepared.accountId === protectedConfig("awsAccountId") && prepared.region === 'ap-southeast-2' &&
        equal(JSON.parse(await store.read(preparation)), prepared), 'original failed source/release differs from immutable preparation');
    const inspectLive = dependencies.inspectLive ?? inspectFailedQualificationCleanupState;
    const before = await inspectLive({ cf, store, env, originalReleaseId: original.releaseId, prepared });
    const now = dependencies.now ?? Date.now, sleep = dependencies.wait ?? wait, deadline = now() + 60000;
    for (;;) {
        await assertQualificationCleanupFence(cf, before.fence);
        const active = await failedQualificationActiveJobs(cf, original);
        if (active.videos === 0 && active.prints === 0)
            break;
        check(now() < deadline, 'owned video/print work remains active after the bounded wait');
        await sleep(Math.min(2000, deadline - now()));
    }
    const priorReviews = await rows(cf, "SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'failed-cleanup-inventory'", [`native-${runId}`]);
    check(priorReviews.length <= 1, 'ambiguous failed cleanup inventory journal');
    let priorReference, baseline = original;
    if (priorReviews.length) {
        const prior = JSON.parse(priorReviews[0].payload);
        check(equal(prior.originalInventoryReference, reference), 'prior cleanup journal refers to a different failed inventory');
        priorReference = prior.reviewReference;
        const reviewed = JSON.parse(await store.read(priorReference));
        check(equal(reviewed.original, original) && equal(reviewed.originalInventoryReference, reference) &&
            reviewed.originalRunId === String(runId) && reviewed.originalSourceCommit === originalRun.head_sha, 'prior refreshed inventory lost its original failed source');
        baseline = validateQualificationInventory(reviewed.refreshed, originalEnv);
    }
    const refreshed = await refreshFailedQualificationInventory(cf, baseline, originalEnv);
    // Preserve both snapshots; late completion can replace null keys, never the
    // original evidence. No qualification-completion or renderer receipt is made.
    const review = { schemaVersion: 1, originalRunId: String(runId), cleanupRunId: env.GITHUB_RUN_ID,
        originalReleaseId: original.releaseId, originalSourceCommit: originalRun.head_sha, cleanupSourceCommit: env.GITHUB_SHA,
        originalInventoryReference: reference, ...(priorReference ? { priorRecoveryReview: priorReference } : {}), original, refreshed, liveIdentity: before.identity, fence: before.fence };
    const reviewReference = await store.save('failed-qualification-cleanup-review.json', Buffer.from(JSON.stringify(review)));
    check(equal(JSON.parse(await store.read(reviewReference)), review), 'refreshed cleanup review readback differs');
    if (!priorReference) {
        // The first refreshed keys survive a lost delete acknowledgement or a later
        // R2 failure. Future recovery must use them when database rows are gone.
        await recordReleaseEvent(cf, `native-${runId}`, 'failed-cleanup-inventory', { originalInventoryReference: reference, reviewReference });
    }
    const verifiedBeforeDelete = await inspectLive({ cf, store, env, originalReleaseId: original.releaseId, prepared });
    check(equal(verifiedBeforeDelete, before), 'current source/generation changed before cleanup');
    const result = await deleteQualificationInventory(cf, refreshed, originalEnv, { fence: before.fence });
    await assertQualificationCleanupFence(cf, before.fence);
    const after = await inspectLive({ cf, store, env, originalReleaseId: original.releaseId, prepared });
    check(equal(after, before), 'current source/generation changed during cleanup');
    const receipt = { schemaVersion: 1, failedQualificationCleanupComplete: true, qualificationComplete: false,
        qualificationRunId: String(runId), cleanupRunId: env.GITHUB_RUN_ID, originalReleaseId: original.releaseId,
        originalSourceCommit: originalRun.head_sha, cleanupSourceCommit: env.GITHUB_SHA,
        originalInventoryReference: reference, reviewReference, liveIdentity: before.identity, ...result };
    const evidence = await store.save('failed-qualification-cleanup-receipt.json', Buffer.from(JSON.stringify(receipt)));
    check(equal(JSON.parse(await store.read(evidence)), receipt), 'failed cleanup receipt readback differs');
    return { ...receipt, evidence };
}
