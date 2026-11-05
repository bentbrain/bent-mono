import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { captureQualificationInventory } from './native-qualification-inventory.mjs';
import { recoverFailedQualification, inspectFailedQualificationCleanupState } from './native-failed-qualification-cleanup.mjs';
const design = '11111111-1111-4111-8111-111111111111', product = '22222222-2222-4222-8222-222222222222', revision = '33333333-3333-4333-8333-333333333333';
const sha = 'a'.repeat(64), source = 'b'.repeat(40), env = { GITHUB_RUN_ID: '200', GITHUB_SHA: source, NATIVE_VERIFY_RELEASE: 'native-100' };
const cleanupEnv = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'c'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main',
    NATIVE_OPERATION: 'cleanup-failed-qualification', NATIVE_RELEASE_MODE: 'full', NATIVE_VERIFY_RELEASE: 'native-100' };
function fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE designs(id TEXT PRIMARY KEY,artwork_key TEXT,sha256 TEXT);
 CREATE TABLE products(id TEXT PRIMARY KEY,design_id TEXT REFERENCES designs(id));
 CREATE TABLE design_revisions(id TEXT PRIMARY KEY,design_id TEXT REFERENCES designs(id),artwork_key TEXT);
 CREATE TABLE print_assets(id TEXT PRIMARY KEY,configured_product_id TEXT REFERENCES products(id),storage_key TEXT);
 CREATE TABLE print_asset_objects(storage_key TEXT);
 CREATE TABLE print_asset_jobs(configured_product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,status TEXT);
 CREATE TABLE story_video_jobs(id TEXT PRIMARY KEY,product_id TEXT REFERENCES products(id),status TEXT,story_key TEXT);
 CREATE TABLE storage_test_fixtures(design_id TEXT PRIMARY KEY REFERENCES designs(id),run_id TEXT,purpose TEXT);
 CREATE TABLE paid_order_lines(configured_product_id TEXT REFERENCES products(id));
 CREATE TABLE printify_production_products(configured_product_id TEXT REFERENCES products(id));`);
    for (const table of ['native_video_qualification_observations', 'native_video_qualification_faults', 'design_upload_grants'])
        db.exec(`CREATE TABLE ${table}(design_id TEXT REFERENCES designs(id))`);
    db.prepare('INSERT INTO designs VALUES(?,?,?)').run(design, `designs/${design}/artwork/${sha}`, sha);
    db.prepare('INSERT INTO products VALUES(?,?)').run(product, design);
    db.prepare('INSERT INTO design_revisions VALUES(?,?,?)').run(revision, design, `designs/${design}/artwork/${sha}`);
    db.prepare('INSERT INTO print_assets VALUES(?,?,?)').run('asset', product, `print-assets/blobs/${sha}.png`);
    db.prepare('INSERT INTO story_video_jobs VALUES(?,?,?,?)').run('job', product, 'ready', `story-videos/v7/${revision}/${product}/black.mp4`);
    db.prepare('INSERT INTO storage_test_fixtures VALUES(?,?,?)').run(design, env.GITHUB_RUN_ID, 'native-qualification');
    const calls = [], deleted = [];
    const query = async (sql, params = []) => {
        const statement = db.prepare(sql);
        return [{ success: true, results: statement.all(...params), meta: { changes: 0 } }];
    };
    const cf = { query, batch: async (statements) => {
            calls.push(statements);
            db.exec('BEGIN');
            try {
                const result = [];
                for (const { sql, params } of statements) {
                    const stmt = db.prepare(sql);
                    if (sql.trim().startsWith('SELECT'))
                        result.push({ results: stmt.all(...params), success: true });
                    else
                        result.push({ meta: stmt.run(...params), success: true });
                }
                db.exec('COMMIT');
                return result;
            }
            catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        }, deleteQualificationArtwork: async (key) => deleted.push(key), deleteQualificationVideo: async (key) => deleted.push(key) };
    return { db, cf, calls, deleted };
}
async function recoveryFixture(t) {
    const f = fixture();
    t.after(() => f.db.close());
    f.db.exec(`CREATE TABLE native_video_release_control(singleton INTEGER PRIMARY KEY,paused INTEGER,release_id TEXT,current_release_id TEXT);
 CREATE TABLE native_video_release_events(release_id TEXT,stage TEXT,payload TEXT,created_at INTEGER,PRIMARY KEY(release_id,stage));
 INSERT INTO native_video_release_control VALUES(1,0,NULL,'native-250');`);
    const verifiedPayload = JSON.stringify({ rollbackVerified: true, releaseId: 'native-250', fromReleaseId: 'native-100' });
    f.db.prepare('INSERT INTO native_video_release_events VALUES(?,?,?,0)').run('native-250', 'verified', verifiedPayload);
    const prepared = { releaseId: 'native-100', sourceCommit: source, environment: 'development', accountId: protectedConfig("awsAccountId"), region: 'ap-southeast-2', worker: {} };
    const original = await captureQualificationInventory(f.cf, env);
    // The original failed cleanup observed null output keys. Completion must be
    // reviewed afresh before deletion, without changing original evidence.
    original.fixtures[0].assets = [null];
    original.fixtures[0].videos = [null];
    const reference = { key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-cleanup-inventory-native-100-run-200.json", version: 'original', sha256: 'd'.repeat(64) };
    const objects = new Map([[reference.key, Buffer.from(JSON.stringify(original))], ['prepared', Buffer.from(JSON.stringify(prepared))]]);
    f.db.prepare('INSERT INTO native_video_release_events VALUES(?,?,?,0)').run('native-100', 'prepared', JSON.stringify({ ...prepared, preparation: { key: 'prepared' } }));
    let activeRun = '300';
    const saves = [];
    const store = { read: async (ref) => { assert.ok(objects.has(ref.key)); return objects.get(ref.key); }, save: async (name, bytes) => {
            const key = `native-${activeRun}/${name}`;
            assert.ok(!objects.has(key));
            objects.set(key, bytes);
            saves.push(key);
            return { key, version: 'sealed', sha256: 'e'.repeat(64) };
        } };
    const originalRun = { id: 200, conclusion: 'failure', status: 'completed', run_attempt: 1, event: 'workflow_dispatch', head_branch: 'main', head_sha: source,
        path: '.github/workflows/native-development.yml', repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) },
        display_title: `Native development · qualify-all · full · native-100 · - · main · ${source} · [manual]` };
    const fence = { releaseId: 'native-250', verifiedPayload };
    const dependencies = { cf: f.cf, store, readRun: async () => originalRun, inspectLive: async () => ({ identity: { releaseId: 'native-250' }, fence }) };
    return { ...f, prepared, original, reference, objects, saves, originalRun, fence, dependencies,
        setRun: run => { activeRun = run; }, cleanup: { ...cleanupEnv, NATIVE_QUALIFICATION_REFERENCE: JSON.stringify(reference) } };
}
test('failed cleanup seals refreshed keys, preserves failed evidence and never emits passing qualification', async (t) => {
    const f = await recoveryFixture(t);
    const receipt = await recoverFailedQualification(f.cleanup, f.dependencies);
    assert.equal(receipt.failedQualificationCleanupComplete, true);
    assert.equal(receipt.qualificationComplete, false);
    assert.equal(receipt.originalSourceCommit, source);
    assert.equal(receipt.cleanupSourceCommit, cleanupEnv.GITHUB_SHA);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM designs').get().n, 0);
    assert.ok(f.deleted.some(key => key.endsWith('/black.mp4')));
    const review = JSON.parse(f.objects.get(receipt.reviewReference.key));
    assert.deepEqual(review.original, f.original);
    assert.deepEqual(review.original.fixtures[0].videos, [null]);
    assert.ok(review.refreshed.fixtures[0].videos[0].endsWith('/black.mp4'));
    assert.ok(f.saves.every(key => !key.includes('qualification-receipt.json') && !key.includes('complete-summary') && !key.includes('renderer-reference')));
    assert.equal(f.calls[0].length, 12); // release fence and both fixture guards are in the delete transaction
});
test('original run/source/release or paid and fulfilment references cannot be substituted', async (t) => {
    for (const mutation of [
        f => { f.originalRun.conclusion = 'success'; }, f => { f.originalRun.head_sha = 'f'.repeat(40); },
        f => { f.originalRun.run_attempt = 2; }, f => { f.originalRun.repository.id = 1; },
        f => f.db.prepare('INSERT INTO paid_order_lines VALUES(?)').run(product),
        f => f.db.prepare('INSERT INTO printify_production_products VALUES(?)').run(product),
        f => f.db.exec("UPDATE storage_test_fixtures SET run_id='other'"),
    ]) {
        const f = await recoveryFixture(t);
        mutation(f);
        await assert.rejects(recoverFailedQualification(f.cleanup, f.dependencies));
        assert.equal(f.deleted.length, 0);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM designs').get().n, 1);
    }
});
test('active print and video work are bounded and never cancelled by cleanup', async (t) => {
    for (const kind of ['print', 'video']) {
        const f = await recoveryFixture(t);
        let time = 0;
        if (kind === 'print')
            f.db.prepare("INSERT INTO print_asset_jobs VALUES(?,'running')").run(product);
        else
            f.db.exec("UPDATE story_video_jobs SET status='queued'");
        await assert.rejects(recoverFailedQualification(f.cleanup, { ...f.dependencies, now: () => time, wait: async (ms) => { time += ms; } }), /bounded wait/);
        assert.equal(time, 60000);
        assert.equal(f.calls.length, 0);
        assert.equal(f.deleted.length, 0);
    }
});
test('a print claim racing the settled read aborts the whole deletion transaction', async (t) => {
    const f = await recoveryFixture(t), batch = f.cf.batch;
    f.cf.batch = async (statements) => { f.db.prepare("INSERT INTO print_asset_jobs VALUES(?,'running')").run(product); return batch(statements); };
    await assert.rejects(recoverFailedQualification(f.cleanup, f.dependencies));
    assert.equal(f.deleted.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM products').get().n, 1);
});
test('release generation drift cannot cross the atomic cleanup fence', async (t) => {
    const f = await recoveryFixture(t), batch = f.cf.batch;
    f.cf.batch = async (statements) => { f.db.exec("UPDATE native_video_release_control SET current_release_id='native-999'"); return batch(statements); };
    await assert.rejects(recoverFailedQualification(f.cleanup, f.dependencies));
    assert.equal(f.deleted.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM designs').get().n, 1);
});
test('partial object failure recovers reviewed completed keys after database deletion', async (t) => {
    const f = await recoveryFixture(t);
    f.cf.deleteQualificationVideo = async () => { throw Error('object failure'); };
    await assert.rejects(recoverFailedQualification(f.cleanup, f.dependencies), /cleanup incomplete/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM designs').get().n, 0);
    assert.equal(f.calls.length, 1);
    f.setRun('301');
    f.cf.deleteQualificationVideo = async (key) => f.deleted.push(key);
    const receipt = await recoverFailedQualification({ ...f.cleanup, GITHUB_RUN_ID: '301' }, f.dependencies);
    assert.equal(receipt.failedQualificationCleanupComplete, true);
    assert.equal(f.calls.length, 1);
    assert.ok(f.deleted.some(key => key.endsWith('/black.mp4')));
    const review = JSON.parse(f.objects.get(receipt.reviewReference.key));
    assert.ok(review.priorRecoveryReview);
});
test('current identity rejects unrelated or paused generations without inspecting application services', async () => {
    for (const state of [{ paused: 1, current_release_id: 'native-100' }, { paused: 0, current_release_id: 'native-999' }]) {
        const cf = { query: async (sql) => [{ results: sql.includes('release_control') ? [{ release_id: null, ...state }] : [{ payload: JSON.stringify({ rollbackVerified: true, releaseId: 'native-999', fromReleaseId: 'native-other' }) }] }] };
        await assert.rejects(inspectFailedQualificationCleanupState({ cf, store: {}, env: cleanupEnv, originalReleaseId: 'native-100', prepared: {} }));
    }
});
test('live-original cleanup verifies deployed source independently from new cleanup code', async () => {
    const verifiedPayload = JSON.stringify({ verified: true });
    const cf = { query: async (sql) => [{ results: sql.includes('release_control WHERE singleton') ? [{ paused: 0, release_id: null, current_release_id: 'native-100' }]
                    : sql.includes('CASE WHEN') ? [{ allowed: 1 }] : [{ payload: verifiedPayload }] }] };
    let checkedExecutor = false;
    const input = { cf, store: {}, env: cleanupEnv, originalReleaseId: 'native-100', prepared: { sourceCommit: source },
        inspectIdentity: async () => ({ releaseId: 'native-100', sourceCommit: source }), inspectRecordedExecutor: async () => { checkedExecutor = true; } };
    assert.equal((await inspectFailedQualificationCleanupState(input)).identity.sourceCommit, source);
    assert.notEqual(source, cleanupEnv.GITHUB_SHA);
    assert.equal(checkedExecutor, true);
    await assert.rejects(inspectFailedQualificationCleanupState({ ...input, inspectIdentity: async () => ({ releaseId: 'native-100', sourceCommit: cleanupEnv.GITHUB_SHA }) }), /sealed preparation/);
});
test('successful failed-fixture cleanup cannot become a renderer qualification baseline', async () => {
    const { discoverRendererBaseline } = await import('./release-qualification-recovery.mjs');
    assert.equal(await discoverRendererBaseline(async () => ({ workflow_runs: [{ id: 300, display_title: 'Native development · cleanup-failed-qualification · full · native-100' }] }), async () => assert.fail('failed cleanup has no renderer pointer')), null);
});
test('recorded rollback cleanup verifies the sealed predecessor and retained executor without reopening it', async (t) => {
    const f = await recoveryFixture(t);
    const { workerContentManifest, versionResourcesDigest } = await import('./native-ci-worker.mjs');
    const imageDigest = `sha256:${'b'.repeat(64)}`, sourceDigest = 'c'.repeat(64);
    const runtime = { runtimeVerified: true, environment: 'development', renderer: { imageDigest, sourceDigest,
            imageUri: protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@" + (imageDigest) }, failure: { imageDigest } };
    const version = { id: '44444444-4444-4444-8444-444444444444', resources: { script: { etag: 'old' } } };
    const worker = { workerVersion: version.id, content: await workerContentManifest(new Response('old code')),
        versionResourcesSha256: versionResourcesDigest(version) };
    const consumer = { consumerId: 'c'.repeat(32), settings: { max_concurrency: 2, max_retries: 10 } };
    const prepared = { ...f.prepared, previous: { runtime, worker, consumer }, artifacts: { previousArtifact: { key: 'old-worker' } } };
    const artifact = { body: Buffer.from('old code').toString('base64'), contentType: 'application/javascript', entrypoint: 'index.js', before: worker, consumer };
    f.objects.set('prepared', Buffer.from(JSON.stringify(prepared)));
    f.objects.set('old-worker', Buffer.from(JSON.stringify(artifact)));
    f.db.prepare("UPDATE native_video_release_events SET payload=? WHERE release_id='native-100' AND stage='prepared'")
        .run(JSON.stringify({ ...prepared, preparation: { key: 'prepared' } }));
    const target = { environment: 'development', accountId: protectedConfig("awsAccountId"), region: 'ap-southeast-2', imageDigest, imageUri: runtime.renderer.imageUri, sourceDigest };
    f.db.prepare("UPDATE native_video_release_events SET payload=? WHERE release_id='native-250' AND stage='verified'")
        .run(JSON.stringify({ rollbackVerified: true, releaseId: 'native-250', fromReleaseId: 'native-100', target, workerVersion: version.id,
        retainedPrintExecutor: { releaseId: 'native-100' } }));
    f.cf.version = async () => version;
    let executorChecked = false;
    const input = { cf: f.cf, store: f.dependencies.store, env: cleanupEnv, originalReleaseId: 'native-100', prepared,
        inspectWorker: async (_cf, historical) => { assert.deepEqual(historical, artifact); return worker; }, inspectRuntime: async () => runtime,
        inspectConsumer: async () => consumer, executorClient: {}, staging: {}, inspectExecutor: async () => { executorChecked = true; } };
    const result = await inspectFailedQualificationCleanupState(input);
    assert.equal(result.identity.rollbackOf, 'native-100');
    assert.equal(executorChecked, true);
    await assert.rejects(inspectFailedQualificationCleanupState({ ...input, inspectConsumer: async () => ({}) }), /changed/);
    await assert.rejects(inspectFailedQualificationCleanupState({ ...input, inspectRuntime: async () => ({ ...runtime, renderer: { ...runtime.renderer, imageDigest: 'unknown' } }) }), /changed/);
});
