import { protectedConfig } from "./protected-config.mjs";
import { rollbackRecoveryReference } from "./native-rollback-reference.mjs";
import { isDeepStrictEqual as equal } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { developmentOperation } from './native-ci-operation.mjs';
import { developmentCloudflare } from './native-ci-cloudflare.mjs';
import { createDevelopmentReleaseStore } from './native-ci-release-store.mjs';
import { readQualificationRun } from './native-qualification-reference.mjs';
import { loadDevelopmentRollback } from './native-ci-rollback.mjs';
import { inspectDevelopmentWorker, inspectDevelopmentConsumer } from './native-ci-worker.mjs';
import { inspectDevelopmentRuntime } from './native-ci-runtime.mjs';
import { probeDevelopmentFunctions } from './native-ci-health.mjs';
import { developmentPrintExecutorClient, verifyRestoredPrintExecutor } from './native-print-executor.mjs';
import { developmentPrintStagingLifecycle } from './native-print-staging-lifecycle.mjs';
import { assertReleasePaused, inspectDevelopmentDrain, recordReleaseEvent, resumeVerifiedRelease, verifyPauseSchema } from './native-release-pause.mjs';
const check = (value, reason) => { if (!value)
    throw Error(`Paused rollback recovery stopped: ${reason}`); };
// A recovery verifies already-restored resources and resumes the existing pause.
// It cannot apply Terraform, redeploy Workers, restore queues, or change targets.
export async function recoverPausedDevelopmentRollback(env, dependencies = {}) {
    check(developmentOperation(env) === 'recover-rollback', 'dedicated guarded recovery operation required');
    const releaseId = env.NATIVE_ROLLBACK_RELEASE;
    const reference = rollbackRecoveryReference(env.NATIVE_ROLLBACK_REFERENCE, releaseId);
    const runId = Number(releaseId.slice(7));
    check(Number.isSafeInteger(runId) && String(runId) !== env.GITHUB_RUN_ID, 'distinct original rollback run required');
    const cf = dependencies.cf ?? developmentCloudflare(env), store = dependencies.store ?? await createDevelopmentReleaseStore(env);
    const run = await (dependencies.readRun ?? (id => readQualificationRun(env, id)))(runId);
    const evidence = JSON.parse(await store.read(reference));
    check(run.id === runId && run.status === 'completed' && run.conclusion === 'failure' && run.run_attempt === 1 &&
        run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.path === '.github/workflows/native-development.yml' &&
        run.repository?.id === Number(protectedConfig("githubRepositoryId")) && run.repository?.owner?.id === Number(protectedConfig("githubOwnerId")) && run.head_repository?.id === Number(protectedConfig("githubRepositoryId")) &&
        /^[a-f0-9]{40}$/.test(run.head_sha ?? '') && evidence.sourceCommit === run.head_sha && evidence.releaseId === releaseId &&
        /^native-[1-9][0-9]*$/.test(evidence.fromReleaseId ?? '') && evidence.fromReleaseId !== releaseId &&
        (run.display_title ?? '').startsWith(`Native development · rollback · full · - · ${evidence.fromReleaseId} · main · ${run.head_sha} ·`), 'authenticated original failed rollback run/source/target required');
    const rows = async (stage) => (await cf.query('SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = ?', [releaseId, stage]))[0].results;
    const preparedRows = await rows('rollback-prepared');
    check(preparedRows.length === 1 && equal(JSON.parse(preparedRows[0].payload), evidence), 'original rollback journal differs from immutable evidence');
    const { prepared, target, artifact } = await loadDevelopmentRollback(cf, store, evidence.fromReleaseId);
    check(equal(target, evidence.target) && equal(prepared.previous, evidence.previous) &&
        evidence.plan?.imagePlanVerified === true && evidence.plan.imageDigest === target.imageDigest &&
        evidence.plan.sourceDigest === target.sourceDigest && evidence.plan.sourceCommit === evidence.sourceCommit, 'original rollback target/plan differs from sealed predecessor');
    const imageRows = await rows('rollback-image-started'), startupRows = await rows('rollback-startup-verified');
    check(imageRows.length === 1 && equal(JSON.parse(imageRows[0].payload), evidence.plan) && startupRows.length === 1 &&
        JSON.parse(startupRows[0].payload).startupVerified === true, 'original restoration did not reach its verified startup stage');
    await verifyPauseSchema(cf);
    const ownership = async () => {
        await assertReleasePaused(cf, releaseId);
        const controls = (await cf.query('SELECT current_release_id FROM native_video_release_control WHERE singleton = 1'))[0].results;
        check(controls.length === 1 && controls[0].current_release_id === prepared.releaseId, 'original paused generation changed');
    };
    await ownership();
    const inspectWorker = dependencies.inspectWorker ?? inspectDevelopmentWorker;
    const inspectRuntime = dependencies.inspectRuntime ?? (() => inspectDevelopmentRuntime(env));
    const verifyExecutor = dependencies.verifyExecutor ?? (args => verifyRestoredPrintExecutor({ ...args,
        client: developmentPrintExecutorClient(env), staging: developmentPrintStagingLifecycle(env) }));
    const inspect = async () => {
        await ownership();
        check(equal(await inspectWorker(cf, artifact), prepared.previous.worker) &&
            equal(await inspectDevelopmentConsumer(cf), prepared.previous.consumer), 'restored API bytes/version/resources or consumer changed');
        const runtime = await inspectRuntime();
        check(runtime.runtimeVerified === true && runtime.environment === 'development' && runtime.renderer.imageDigest === target.imageDigest &&
            runtime.failure.imageDigest === target.imageDigest && runtime.renderer.sourceDigest === target.sourceDigest, 'restored Lambda pair changed');
        const executor = await verifyExecutor({ api: cf, store, prepared, releaseId, inspectWorker });
        await ownership();
        return { ...(executor.restored ? { worker: { printExecutor: executor.restored } } : {}),
            ...(executor.retained ? { retainedPrintExecutor: executor.retained } : {}), rollbackVerified: true,
            fromReleaseId: prepared.releaseId, releaseId, target, workerVersion: prepared.previous.worker.workerVersion };
    };
    const verified = await inspect();
    const review = { schemaVersion: 1, recoveryRunId: env.GITHUB_RUN_ID, recoverySourceCommit: env.GITHUB_SHA,
        originalRollbackReference: reference, originalRollback: evidence, verified };
    const saved = await store.save('rollback-recovery-review.json', Buffer.from(JSON.stringify(review)));
    check(equal(JSON.parse(await store.read(saved)), review), 'recovery review readback differs');
    await recordReleaseEvent(cf, `native-${env.GITHUB_RUN_ID}`, 'rollback-recovery-prepared', { review: saved, releaseId });
    const now = dependencies.now ?? Date.now, sleep = dependencies.wait ?? wait;
    for (;;) {
        await ownership();
        const drain = await inspectDevelopmentDrain(cf, releaseId, now());
        if (drain.drained)
            break;
        await sleep(Math.min(15000, drain.remainingMs));
    }
    const startup = await (dependencies.probeRuntime ?? (() => probeDevelopmentFunctions(env)))();
    check(startup.startupVerified === true, 'fresh startup probe required');
    await recordReleaseEvent(cf, `native-${env.GITHUB_RUN_ID}`, 'rollback-recovery-startup', startup);
    return resumeVerifiedRelease(cf, releaseId, async () => {
        const current = await inspect();
        check(equal(current, verified), 'restored pair changed during recovery');
        return current;
    });
}
