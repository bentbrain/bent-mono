import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from 'node:util';
import { inspectDevelopmentWorker, verifyDevelopmentPairStatus } from './native-ci-worker.mjs';
import { inspectDevelopmentRuntime } from './native-ci-runtime.mjs';
export async function qualificationIdentity(cf, store, env, { inspectWorker = inspectDevelopmentWorker, inspectRuntime = inspectDevelopmentRuntime, verifyStatus = verifyDevelopmentPairStatus } = {}) {
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const controls = await query('SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1');
    if (controls.length !== 1 || controls[0].paused !== 0 || controls[0].release_id !== null ||
        controls[0].current_release_id !== env.NATIVE_VERIFY_RELEASE)
        throw Error('Qualification requires the original live unpaused release.');
    const events = await query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'prepared'", [env.NATIVE_VERIFY_RELEASE]);
    if (events.length !== 1)
        throw Error('Original release preparation is missing.');
    const { preparation, ...prepared } = JSON.parse(events[0].payload);
    if (prepared.releaseId !== env.NATIVE_VERIFY_RELEASE || prepared.environment !== 'development' ||
        prepared.accountId !== protectedConfig("awsAccountId") || prepared.region !== 'ap-southeast-2' || !/^[a-f0-9]{40}$/.test(prepared.sourceCommit ?? '') ||
        !equal(JSON.parse(await store.read(preparation)), prepared))
        throw Error('Release preparation differs from immutable evidence.');
    const worker = await inspectWorker(cf), runtime = await inspectRuntime(env);
    if (worker.content.modules.length !== 1 || worker.content.modules[0].sha256 !== prepared.worker.bundleSha256 ||
        runtime.renderer.imageDigest !== prepared.candidate.imageDigest || runtime.failure.imageDigest !== prepared.candidate.imageDigest ||
        runtime.renderer.sourceDigest !== prepared.candidate.sourceDigest)
        throw Error('Live qualification pair changed.');
    await verifyStatus(env, prepared.candidate, env.NATIVE_VERIFY_RELEASE, fetch, { paused: false, sourceCommit: prepared.sourceCommit });
    return { releaseId: env.NATIVE_VERIFY_RELEASE, sourceCommit: prepared.sourceCommit, imageDigest: prepared.candidate.imageDigest,
        workerVersionId: worker.workerVersion, workerBundleSha256: prepared.worker.bundleSha256,
        workerResourcesSha256: worker.versionResourcesSha256 };
}
