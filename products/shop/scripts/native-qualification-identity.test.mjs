import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualificationIdentity } from './native-qualification-identity.mjs';
function fixture() {
    const source = 'a'.repeat(40), sha = 'b'.repeat(64), image = `sha256:${'c'.repeat(64)}`;
    const prepared = { releaseId: 'native-100', environment: 'development', accountId: protectedConfig("awsAccountId"), region: 'ap-southeast-2',
        sourceCommit: source, worker: { bundleSha256: sha }, candidate: { imageDigest: image, sourceDigest: sha } };
    const control = { paused: 0, release_id: null, current_release_id: 'native-100' };
    const worker = { workerVersion: '11111111-1111-4111-8111-111111111111', content: { modules: [{ sha256: sha }] }, versionResourcesSha256: 'd'.repeat(64) };
    const runtime = { renderer: { imageDigest: image, sourceDigest: sha }, failure: { imageDigest: image } };
    const cf = { query: async (sql) => [{ results: sql.includes('release_control') ? [control] : [{ payload: JSON.stringify({ ...prepared, preparation: { key: 'prepared' } }) }] }] };
    const store = { read: async () => Buffer.from(JSON.stringify(prepared)) };
    const env = { NATIVE_VERIFY_RELEASE: 'native-100' }, deps = { inspectWorker: async () => worker, inspectRuntime: async () => runtime, verifyStatus: async () => { } };
    return { cf, store, env, deps, worker, runtime, control, prepared };
}
test('cleanup identity binds the immutable preparation, Worker bundle, resources and live renderer', async () => {
    const f = fixture(), identity = await qualificationIdentity(f.cf, f.store, f.env, f.deps);
    assert.equal(identity.releaseId, 'native-100');
    assert.equal(identity.workerBundleSha256, f.prepared.worker.bundleSha256);
    assert.equal(identity.workerResourcesSha256, f.worker.versionResourcesSha256);
});
test('release changes, pauses, Worker drift and mixed renderer images prevent cleanup recovery', async () => {
    for (const change of [f => f.control.current_release_id = 'native-999', f => f.control.paused = 1,
        f => f.worker.content.modules[0].sha256 = 'e'.repeat(64), f => f.runtime.failure.imageDigest = `sha256:${'e'.repeat(64)}`,
        f => f.store.read = async () => Buffer.from('{}'), f => f.prepared.releaseId = 'native-999']) {
        const f = fixture();
        change(f);
        await assert.rejects(qualificationIdentity(f.cf, f.store, f.env, f.deps));
    }
});
