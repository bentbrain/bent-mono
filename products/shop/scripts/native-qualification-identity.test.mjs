import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualificationIdentity } from './native-qualification-identity.mjs';
import { workerContentManifest, workerContentResponse } from './native-worker-content.mjs';
function fixture() {
    const source = 'a'.repeat(40), sha = 'b'.repeat(64), image = `sha256:${'c'.repeat(64)}`;
    const prepared = { releaseId: 'native-100', environment: 'development', accountId: protectedConfig("awsAccountId"), region: 'ap-southeast-2',
        sourceCommit: source, worker: { bundleSha256: sha }, candidate: { imageDigest: image, sourceDigest: sha } };
    const control = { paused: 0, release_id: null, current_release_id: 'native-100' };
    const worker = { workerVersion: '11111111-1111-4111-8111-111111111111', content: { entrypoint: 'index.js', modules: [{ name: 'index.js', bytes: 1, sha256: sha }] }, versionResourcesSha256: 'd'.repeat(64) };
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
test('qualification identity verifies every sealed API upload part and preserves legacy single-module releases', async () => {
    const code = Buffer.from('export default {};\n//# sourceMappingURL=index.js.map');
    const map = Buffer.from(JSON.stringify({ version: 3, file: 'index.js', sources: ['source.ts'], names: [], mappings: '' }));
    const content = await workerContentManifest(workerContentResponse({ code, map }));
    const codeOnly = await workerContentManifest(workerContentResponse({ code }));
    const f = fixture();
    Object.assign(f.prepared.worker, { schemaVersion: 2, bundleSha256: content.modules[0].sha256, bundleBytes: code.length, content });
    f.worker.content = content;
    let statusCalls = 0;
    f.deps.verifyStatus = async () => { statusCalls++; };
    await qualificationIdentity(f.cf, f.store, f.env, f.deps);
    assert.equal(statusCalls, 1);
    const changedMap = structuredClone(content); changedMap.modules[1].sha256 = 'e'.repeat(64); delete changedMap.sha256;
    const changedCode = structuredClone(content); changedCode.modules[0].sha256 = 'e'.repeat(64); delete changedCode.sha256;
    const extra = structuredClone(content); extra.modules.push({ name: 'extra.js', bytes: 1, sha256: 'f'.repeat(64) }); delete extra.sha256;
    const duplicate = structuredClone(content); duplicate.modules[1] = { ...duplicate.modules[0] }; delete duplicate.sha256;
    for (const invalid of [codeOnly, changedMap, changedCode, extra, duplicate]) {
        f.worker.content = invalid;
        await assert.rejects(qualificationIdentity(f.cf, f.store, f.env, f.deps));
        assert.equal(statusCalls, 1);
    }
    f.worker.content = codeOnly;
    f.prepared.worker = { bundleSha256: content.modules[0].sha256 };
    await qualificationIdentity(f.cf, f.store, f.env, f.deps);
    assert.equal(statusCalls, 2);
    f.worker.content = content;
    await assert.rejects(qualificationIdentity(f.cf, f.store, f.env, f.deps));
    assert.equal(statusCalls, 2);
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
