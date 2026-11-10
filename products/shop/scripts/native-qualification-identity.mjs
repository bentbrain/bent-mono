import { loadDevelopmentPreparation } from "./native-development-preparation.mjs";
import { protectedConfig } from "./protected-config.mjs";
import { inspectDevelopmentWorker, verifyDevelopmentPairStatus } from './native-ci-worker.mjs';
import { inspectDevelopmentRuntime } from './native-ci-runtime.mjs';
import { verifyWorkerUpload } from './native-worker-content.mjs';
export async function qualificationIdentity(cf, store, env, { inspectWorker = inspectDevelopmentWorker, inspectRuntime = inspectDevelopmentRuntime, verifyStatus = verifyDevelopmentPairStatus } = {}) {
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const controls = await query('SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1');
    if (controls.length !== 1 || controls[0].paused !== 0 || controls[0].release_id !== null ||
        controls[0].current_release_id !== env.NATIVE_VERIFY_RELEASE)
        throw Error('Qualification requires the original live unpaused release.');
    const prepared = await loadDevelopmentPreparation(cf, store, env.NATIVE_VERIFY_RELEASE);
    if (prepared.environment !== 'development' || prepared.accountId !== protectedConfig("awsAccountId") || prepared.region !== 'ap-southeast-2')
        throw Error('Release preparation environment differs.');
    const worker = await inspectWorker(cf, undefined, prepared.worker), runtime = await inspectRuntime(env);
    if (runtime.renderer.imageDigest !== prepared.candidate.imageDigest || runtime.failure.imageDigest !== prepared.candidate.imageDigest ||
        runtime.renderer.sourceDigest !== prepared.candidate.sourceDigest)
        throw Error('Live qualification pair changed.');
    verifyWorkerUpload(worker.content, prepared.worker);
    await verifyStatus(env, prepared.candidate, env.NATIVE_VERIFY_RELEASE, fetch, { paused: false, sourceCommit: prepared.sourceCommit });
    return { releaseId: env.NATIVE_VERIFY_RELEASE, sourceCommit: prepared.sourceCommit, imageDigest: prepared.candidate.imageDigest,
        workerVersionId: worker.workerVersion, workerBundleSha256: prepared.worker.bundleSha256,
        workerResourcesSha256: worker.versionResourcesSha256 };
}
