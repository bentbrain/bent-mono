import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectedConfig } from './protected-config.mjs';
import { inspectRetainedFailedQualification, failedInspectionQueries } from './native-failed-qualification-inspection.mjs';
import { failedInventoryInspectionDescriptor } from './native-qualification-reference.mjs';
import { createDevelopmentCICall } from './native-ci-aws.mjs';
import { createDevelopmentReleaseStore } from './native-ci-release-store.mjs';
import { executeNativeDevelopment } from './native-ci-development.mjs';
import { developmentOperation } from './native-ci-operation.mjs';
import { sealDispatchInputs, resolveDispatchInputs } from './release-dispatch-inputs.mjs';
import { openReleaseEvidence } from './release-evidence.mjs';
import { workerContentManifest, workerContentResponse } from './native-worker-content.mjs';
import { offlinePreflight } from './release-preflight.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'failed-inventory-inspection-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const originalSource = 'b'.repeat(40), releaseId = 'native-100';
    const key = `source/releases/native-${protectedConfig('resource_8d0190ecec7d')}/qualification-cleanup-inventory-${releaseId}-run-200.json`;
    const descriptor = { schemaVersion: 1, qualificationRunId: 200, releaseId, sourceCommit: originalSource, key };
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig('githubRepositoryId'),
        GITHUB_REPOSITORY_OWNER_ID: protectedConfig('githubOwnerId'), GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'c'.repeat(40),
        GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_TOKEN: 'synthetic',
        GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main',
        NATIVE_OPERATION: 'inspect-failed-qualification', NATIVE_VERIFY_RELEASE: releaseId, NATIVE_QUALIFICATION_REFERENCE: JSON.stringify(descriptor),
        RUNNER_TEMP: directory, AWS_REGION: 'ap-southeast-2', AWS_DEFAULT_REGION: 'ap-southeast-2', AWS_ACCESS_KEY_ID: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic', AWS_SESSION_TOKEN: 'synthetic',
        SHOP_EVIDENCE_ENCRYPTION_KEY: '07'.repeat(32), SHOP_EVIDENCE_KEY_VERSION: 'v1' };
    const originalRun = { id: 200, conclusion: 'failure', status: 'completed', run_attempt: 1, event: 'workflow_dispatch', head_branch: 'main', head_sha: originalSource,
        workflow_id: 1234, path: '.github/workflows/native-development.yml', repository: { id: Number(protectedConfig('githubRepositoryId')), owner: { id: Number(protectedConfig('githubOwnerId')) } },
        head_repository: { id: Number(protectedConfig('githubRepositoryId')) }, run_started_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T01:00:00Z',
        display_title: `Native development · qualify-all · full · ${releaseId} · - · main · ${originalSource} · [manual]` };
    const workflow = { id: 1234, path: originalRun.path, state: 'active' }, calls = [], requests = [], queries = [];
    let main = env.GITHUB_SHA;
    const request = async (url, options) => {
        assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer synthetic'); requests.push(url);
        const prefix = 'https://api.github.com/repos/bentbrain/bent-mono/';
        assert.ok(url.startsWith(prefix)); const path = url.slice(prefix.length);
        if (path === 'actions/runs/200') return Response.json(originalRun);
        if (path === 'actions/workflows/native-development.yml') return Response.json(workflow);
        assert.equal(path, 'git/ref/heads/main'); return Response.json({ object: { sha: main } });
    };
    const candidate = { imageDigest: `sha256:${'d'.repeat(64)}`, sourceDigest: 'e'.repeat(64) };
    const content = await workerContentManifest(workerContentResponse({ code: Buffer.from('export default {};') }));
    const prepared = { releaseId, sourceCommit: originalSource, environment: 'development', accountId: protectedConfig('awsAccountId'), region: 'ap-southeast-2', candidate,
        worker: { schemaVersion: 3, content, bundleSha256: content.modules[0].sha256, bundleBytes: content.modules[0].bytes } };
    const verified = { releaseId, sourceCommit: originalSource, candidate, runtime: { renderer: candidate, failure: { imageDigest: candidate.imageDigest } },
        worker: { workerVersion: '11111111-1111-4111-8111-111111111111', versionResourcesSha256: 'a'.repeat(64), content } };
    const designId = '22222222-2222-4222-8222-222222222222', sha = 'f'.repeat(64);
    const inventory = { schemaVersion: 1, runId: '200', releaseId, sourceCommit: originalSource,
        fixtures: [{ designId, sha256: sha, artworkKey: `designs/${designId}/artwork/${sha}`, products: [], revisions: [], assets: [], videos: [] }] };
    const originalBytes = Buffer.from(JSON.stringify(inventory, null, 2) + '\n');
    const objects = new Map([[key, originalBytes], [`source/releases/${releaseId}/prepared.json`, Buffer.from(JSON.stringify(prepared))]]);
    const preparation = { key: `source/releases/${releaseId}/prepared.json`, version: 'v1', sha256: hash(objects.get(`source/releases/${releaseId}/prepared.json`)) };
    const controls = [{ paused: 0, release_id: null, current_release_id: releaseId }];
    const cf = { query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (sql.includes("stage = 'prepared'")) return [{ results: [{ payload: JSON.stringify({ ...prepared, preparation }) }] }];
        if (sql.includes("stage = 'verified' AND payload")) return [{ results: [{ allowed: params[0] === controls[0].current_release_id && params[2] === JSON.stringify(verified) ? 1 : 0 }] }];
        if (sql.includes("stage = 'verified'")) return [{ results: [{ payload: JSON.stringify(verified) }] }];
        assert.equal(sql, 'SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1');
        return [{ results: controls }];
    }, batch: () => assert.fail('provider write'), updateStoryVideoLifecycle: () => assert.fail('lifecycle write') };
    const metadata = new Map([...objects].map(([objectKey, bytes]) => [objectKey, { VersionId: 'v1', ContentLength: bytes.length, ETag: `"${hash(bytes)}"`, ServerSideEncryption: 'AES256', LastModified: '2026-01-01T00:30:00Z' }]));
    const run = async (command, args) => {
        assert.equal(command, 'aws'); calls.push(args); const response = value => ({ stdout: JSON.stringify(value) });
        if (args[0] === 'sts') return response({ Account: protectedConfig('awsAccountId'), Arn: `arn:aws:sts::${protectedConfig('awsAccountId')}:assumed-role/forever-tee-video-development-ci/native-300` });
        assert.equal(args[0], 's3api'); assert.ok(['head-object', 'get-object'].includes(args[1]));
        assert.equal(args[args.indexOf('--expected-bucket-owner') + 1], protectedConfig('awsAccountId'));
        const objectKey = args[args.indexOf('--key') + 1]; assert.ok(objects.has(objectKey));
        if (args[1] === 'head-object') return response(metadata.get(objectKey));
        assert.equal(args[args.indexOf('--version-id') + 1], metadata.get(objectKey).VersionId);
        assert.match(args[args.indexOf('--range') + 1], /^bytes=0-(131071|1048575)$/);
        await writeFile(args[args.indexOf('--range') + 2], objects.get(objectKey));
        return response(metadata.get(objectKey));
    };
    const dependencies = { request, cf, createCall: env => createDevelopmentCICall(env, run) };
    return { env, descriptor, directory, originalRun, workflow, calls, requests, queries, prepared, preparation, verified, objects, metadata, originalBytes, controls, dependencies,
        setMain: value => { main = value; } };
}
test('actual read-only inspector exports original raw bytes and exact reference under encrypted inspection provenance', async t => {
    const f = await fixture(t);
    await executeNativeDevelopment(f.env, { cloudflare: () => f.dependencies.cf, verifyCheckout: async () => {},
        inspectFailedQualification: (env, { cf }) => inspectRetainedFailedQualification(env, { ...f.dependencies, cf }) });
    const file = join(f.directory, 'qualification-inventory-export.json'), ciphertext = await readFile(file, 'utf8');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!ciphertext.includes(f.originalBytes.toString()));
    const exported = openReleaseEvidence(ciphertext, { sourceCommit: f.env.GITHUB_SHA, runId: '300', filename: 'qualification-inventory-export.json' }, f.env);
    assert.deepEqual(Buffer.from(exported.inventoryBytesBase64, 'base64'), f.originalBytes);
    assert.deepEqual(exported.inventoryReference, { key: f.descriptor.key, version: 'v1', sha256: hash(f.originalBytes) });
    assert.equal(exported.cleanupApproved, false); assert.equal(exported.qualificationComplete, false); assert.equal(exported.productionApproved, false);
    assert.ok(f.calls.every(args => args[0] === 'sts' || ['head-object', 'get-object'].includes(args[1])));
    assert.ok(f.queries.every(({ sql }) => sql.startsWith('SELECT')));
    assert.equal(f.requests[0], 'https://api.github.com/repos/bentbrain/bent-mono/actions/runs/200');
    assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.json')).length, 1);
});
test('sealed qualification_reference admits only the exact inspection descriptor and main first attempt', async t => {
    const f = await fixture(t), inputs = sealDispatchInputs({ qualification_reference: JSON.stringify(f.descriptor) }, f.env.GITHUB_SHA, f.env);
    const env = { ...f.env, NATIVE_QUALIFICATION_REFERENCE: inputs.qualification_reference };
    resolveDispatchInputs(env); assert.equal(developmentOperation(env), 'inspect-failed-qualification');
    assert.deepEqual(failedInventoryInspectionDescriptor(env.NATIVE_QUALIFICATION_REFERENCE, 'native-100'), f.descriptor);
    for (const delta of [{ key: 'source/releases/native-1/other.json' }, { releaseId: 'native-999' }, { qualificationRunId: 201 }, { sourceCommit: 'main' }, { repository: 'foreign' }])
        assert.throws(() => failedInventoryInspectionDescriptor(JSON.stringify({ ...f.descriptor, ...delta }), 'native-100'));
    for (const delta of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/perf/story-video-family-experiments' }, { GITHUB_REPOSITORY_ID: '0' }, { NATIVE_RELEASE_MODE: 'api' }, { NATIVE_OPERATION: 'release' }])
        assert.throws(() => developmentOperation({ ...env, ...delta }));
    const preflight = offlinePreflight({ environment: 'development', lane: 'native', operation: 'inspect-failed-qualification', ref: env.GITHUB_REF,
        sha: env.GITHUB_SHA, verifyRelease: env.NATIVE_VERIFY_RELEASE, qualificationReference: env.NATIVE_QUALIFICATION_REFERENCE, migrations: [] });
    assert.equal(preflight.checks.find(check => check.id === 'native-request').passed, true);
});
test('wrong or unknown original workflow, run, source, release, owner, object and pair fail without exporting', async t => {
    const inventoryChange = (field, value) => f => {
        const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(f.originalBytes), [field]: value }, null, 2) + '\n');
        f.objects.set(f.descriptor.key, bytes);
        Object.assign(f.metadata.get(f.descriptor.key), { ContentLength: bytes.length, ETag: `"${hash(bytes)}"` });
    };
    const changes = [
        f => { f.originalRun.id = 201; }, f => { f.originalRun.head_sha = 'f'.repeat(40); }, f => { f.originalRun.run_attempt = 2; },
        f => { f.originalRun.path = '.github/workflows/unknown.yml'; }, f => { f.originalRun.workflow_id = 9999; }, f => { delete f.workflow.id; },
        f => { f.workflow.state = 'disabled_manually'; }, f => { f.originalRun.conclusion = 'success'; }, f => { f.originalRun.repository.owner.id = 1; },
        f => { f.originalRun.display_title = f.originalRun.display_title.replace('native-100', 'native-999'); },
        inventoryChange('sourceCommit', 'a'.repeat(40)), inventoryChange('runId', '201'), inventoryChange('releaseId', 'native-999'),
        f => { f.metadata.get(f.descriptor.key).LastModified = '2026-01-02T00:00:00Z'; }, f => { f.metadata.get(f.descriptor.key).VersionId = 'null'; },
        f => { f.metadata.get(f.descriptor.key).ContentLength = 131073; }, f => { f.metadata.get(f.descriptor.key).ServerSideEncryption = 'none'; },
        f => { f.verified.runtime.failure.imageDigest = `sha256:${'f'.repeat(64)}`; }, f => { f.controls[0].paused = 1; },
        f => { f.preparation.key = 'source/releases/native-999/prepared.json'; }, f => { f.setMain('f'.repeat(40)); },
    ];
    for (const change of changes) {
        const f = await fixture(t); change(f);
        await assert.rejects(inspectRetainedFailedQualification(f.env, f.dependencies));
        assert.ok(!(await readdir(f.directory)).includes('qualification-inventory-export.json'));
        assert.ok(f.calls.every(args => args[0] === 'sts' || ['head-object', 'get-object'].includes(args[1])));
    }
});
test('changed HEAD, original readback and deletion fence fail before export', async t => {
    for (const kind of ['head', 'readback', 'fence', 'main']) {
        const f = await fixture(t), originalCreate = f.dependencies.createCall;
        f.dependencies.createCall = async env => {
            const call = await originalCreate(env); let gets = 0, heads = 0;
            return async args => {
                const result = await call(args);
                if (args.includes(f.descriptor.key)) {
                    if (args[1] === 'head-object' && ++heads === 2 && kind === 'head') result.VersionId = 'v2';
                    if (args[1] === 'get-object' && ++gets === 2 && kind === 'readback') await writeFile(args.at(-1), Buffer.alloc(f.originalBytes.length, 32));
                }
                if (kind === 'main') f.setMain('a'.repeat(40));
                if (kind === 'fence') f.controls[0].current_release_id = 'native-999';
                return result;
            };
        };
        await assert.rejects(inspectRetainedFailedQualification(f.env, f.dependencies));
        assert.ok(!(await readdir(f.directory)).includes('qualification-inventory-export.json'));
    }
});
test('inspection adapters reject attempted writes and arbitrary object reads before provider calls', async t => {
    const f = await fixture(t), call = await f.dependencies.createCall(f.env), count = f.calls.length;
    for (const args of [['s3api', 'put-object'], ['s3api', 'delete-object'], ['lambda', 'update-function-configuration'],
        ['s3api', 'get-object', '--key', 'arbitrary'], ['s3api', 'list-object-versions']]) await assert.rejects(call(args));
    assert.equal(f.calls.length, count);
    await assert.rejects(createDevelopmentReleaseStore(f.env, () => assert.fail('mutating store initialized')));
    const query = failedInspectionQueries(f.dependencies.cf, 'native-100');
    for (const sql of ['UPDATE native_video_release_control SET paused = 1', 'SELECT 1; DELETE FROM designs', 'SELECT * FROM designs']) await assert.rejects(query.query(sql));
    assert.equal(query.batch, undefined); assert.equal(query.save, undefined);
});
test('canonical workflow wires the inspection entrypoint, sealed export and current-main admission', async () => {
    const workflow = await readFile(new URL('../.github/workflows/native-development.yml', import.meta.url), 'utf8');
    const activated = await readFile(new URL('../../../.github/workflows/native-development.yml', import.meta.url), 'utf8');
    assert.equal(workflow, activated);
    assert.match(workflow, /options: \[.*inspect-failed-qualification/);
    assert.match(workflow, /node --import \.\/scripts\/decode-release-dispatch.mjs --import \.\/scripts\/public-release-logging.mjs scripts\/native-ci-development.mjs/);
    assert.match(workflow, /node \.\.\/\.\.\/scripts\/require-release-checks.mjs --sha "\$GITHUB_SHA"/);
    assert.match(workflow, /if: always\(\).*inputs.operation == 'inspect-failed-qualification'/);
    assert.match(workflow, /\$\{\{ runner.temp \}\}\/qualification-inventory-export.json/);
    assert.match(workflow, /shop-encrypted-diagnostics/);
});
