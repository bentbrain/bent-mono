import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectedConfig } from './protected-config.mjs';
import { loadVerifiedCandidate } from './native-ci-candidate.mjs';
import { captureRendererArchive } from './native-renderer-archive.mjs';
import { createDevelopmentReleaseStore } from './native-ci-release-store.mjs';
import { qualifyDevelopmentRelease, qualifyDevelopmentComponents } from './native-ci-qualification.mjs';
import { executeNativeDevelopment } from './native-ci-development.mjs';
import { cleanupDevelopmentQualification } from './native-ci-qualification-cleanup.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'qualification-finalization-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig('githubRepositoryId'),
        GITHUB_REPOSITORY_OWNER_ID: protectedConfig('githubOwnerId'), GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
        GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main',
        NATIVE_OPERATION: 'qualify-all', NATIVE_VERIFY_RELEASE: 'native-456', RUNNER_TEMP: directory,
        AWS_REGION: 'ap-southeast-2', AWS_DEFAULT_REGION: 'ap-southeast-2', AWS_ACCESS_KEY_ID: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic', AWS_SESSION_TOKEN: 'synthetic' };
    const objects = new Map(), calls = [];
    const run = async (command, args) => {
        assert.equal(command, 'aws'); calls.push(args);
        const output = value => ({ stdout: JSON.stringify(value) });
        if (args[0] === 'sts') return output({ Account: protectedConfig('awsAccountId'),
            Arn: `arn:aws:sts::${protectedConfig('awsAccountId')}:assumed-role/forever-tee-video-development-ci/native-789` });
        assert.equal(args[0], 's3api');
        assert.equal(args[args.indexOf('--expected-bucket-owner') + 1], protectedConfig('awsAccountId'));
        const key = args[args.indexOf('--key') + 1];
        if (args[1] === 'put-object') {
            assert.equal(args[args.indexOf('--if-none-match') + 1], '*');
            assert.equal(args[args.indexOf('--server-side-encryption') + 1], 'AES256');
            if (objects.has(key)) throw Error('immutable key already exists');
            objects.set(key, await readFile(args[args.indexOf('--body') + 1]));
            return output({ VersionId: 'sealed-version' });
        }
        assert.equal(args[1], 'get-object');
        assert.equal(args[args.indexOf('--version-id') + 1], 'sealed-version');
        assert.ok(objects.has(key));
        await writeFile(args[args.indexOf('--version-id') + 2], objects.get(key));
        return output({ VersionId: 'sealed-version' });
    };
    return { env, objects, calls, store: await createDevelopmentReleaseStore(env, run), run };
}
async function archiveFixture(t) {
    const f = await fixture(t), sourceBytes = Buffer.from('synthetic immutable zip'), sourceDigest = 'b'.repeat(64);
    const imageDigest = `sha256:${'c'.repeat(64)}`;
    const candidate = { schemaVersion: 1, environment: 'development', accountId: protectedConfig('awsAccountId'), region: 'ap-southeast-2',
        sourceCommit: f.env.GITHUB_SHA, sourceDigest, githubRunId: '100', zipSha256: hash(sourceBytes), sourceVersion: 'source-v1',
        sourceKey: `source/${f.env.GITHUB_SHA}/100/${hash(sourceBytes)}.zip`, imageDigest,
        imageUri: `${protectedConfig('awsAccountId')}.dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@${imageDigest}`,
        rendererVersion: 'story-video-renderer-v7', executionProtocol: 'claim-v1', deploymentPerformed: false,
        buildId: 'forever-tee-video-development:11111111-1111-4111-8111-111111111111',
        buildArn: `arn:aws:codebuild:ap-southeast-2:${protectedConfig('awsAccountId')}:build/forever-tee-video-development:11111111-1111-4111-8111-111111111111` };
    const bytes = Buffer.from(JSON.stringify(candidate));
    const receipt = { schemaVersion: 1, sourceDigest, candidateKey: `source/candidates/${sourceDigest}/100.json`, candidateVersion: 'candidate-v1', candidateSha256: hash(bytes) };
    const originals = new Map([[receipt.candidateKey, bytes], [candidate.sourceKey, sourceBytes]]);
    const pair = { imageDigest, sourceCommit: f.env.GITHUB_SHA };
    const build = { id: candidate.buildId, arn: candidate.buildArn, buildStatus: 'SUCCEEDED', buildComplete: true,
        projectName: 'forever-tee-video-development', serviceRole: `arn:aws:iam::${protectedConfig('awsAccountId')}:role/forever-tee-video-development-build`,
        source: { type: 'S3', location: `forever-tee-video-development-${protectedConfig('awsAccountId')}-ap-southeast-2/${candidate.sourceKey}`,
            buildspec: JSON.stringify({ phases: { build: { commands: ['bash aws-lambda/cloud-build-app.sh'] } }, version: '0.2' }) },
        sourceVersion: candidate.sourceVersion, environment: { type: 'LINUX_CONTAINER', image: 'aws/codebuild/standard:7.0',
            computeType: 'BUILD_GENERAL1_SMALL', privilegedMode: true, environmentVariables: Object.entries({ SOURCE_DIGEST: sourceDigest,
                SOURCE_COMMIT: candidate.sourceCommit, SOURCE_ZIP_SHA256: candidate.zipSha256, SHOP_AWS_ACCOUNT_ID: protectedConfig('awsAccountId') })
                .map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })) } };
    const readOriginal = async args => {
        assert.equal(args[1], 'get-object');
        assert.equal(args[args.indexOf('--expected-bucket-owner') + 1], protectedConfig('awsAccountId'));
        const key = args[args.indexOf('--key') + 1], version = args[args.indexOf('--version-id') + 1];
        assert.equal(version, key === receipt.candidateKey ? receipt.candidateVersion : candidate.sourceVersion);
        await writeFile(args[args.indexOf('--version-id') + 2], originals.get(key));
        return { VersionId: version };
    };
    const candidateRun = async (command, args) => {
        assert.equal(command, 'aws');
        let result;
        if (args[0] === 'sts') result = { Account: protectedConfig('awsAccountId'),
            Arn: `arn:aws:sts::${protectedConfig('awsAccountId')}:assumed-role/forever-tee-video-development-ci/native-789` };
        else if (args[0] === 's3api') result = await readOriginal(args);
        else if (args[0] === 'codebuild') { assert.equal(args[1], 'batch-get-builds'); result = { builds: [build] }; }
        else if (args[1] === 'describe-repositories') result = { repositories: [{ registryId: protectedConfig('awsAccountId'), imageTagMutability: 'IMMUTABLE' }] };
        else { assert.equal(args[1], 'describe-images'); result = { imageDetails: [{ registryId: protectedConfig('awsAccountId'), repositoryName: 'forever-tee-video-development', imageDigest }] }; }
        return { stdout: JSON.stringify(result) };
    };
    const resources = { run: candidateRun, verifyCheckout: async () => {}, packageSource: async () => ({ sourceDigest }) };
    const dependencies = { loadCandidate: (selected, env) => loadVerifiedCandidate(selected, env, resources), createCall: async () => readOriginal };
    f.env.NATIVE_CANDIDATE_RECEIPT = JSON.stringify(receipt);
    return { ...f, candidate, receipt, originals, dependencies, pair, build, resources };
}
test('actual archive caller selects the protected release receipt and preserves exact original bytes', async t => {
    const f = await archiveFixture(t);
    const archive = await captureRendererArchive(f.env, f.store, f.pair, f.dependencies);
    assert.equal(archive.candidate.original.key, f.receipt.candidateKey);
    assert.equal(archive.source.original.version, f.candidate.sourceVersion);
    for (const entry of Object.values(archive)) assert.deepEqual(await f.store.read(entry.copy), f.originals.get(entry.original.key));
    assert.equal(f.calls.filter(args => args[1] === 'put-object').length, 2);
});
test('actual archive caller rejects changed receipt, source, pair, version, raw bytes and immutable copy', async t => {
    for (const kind of ['receipt', 'source', 'image', 'commit', 'version', 'bytes', 'source-bytes', 'build', 'build-version', 'current-source', 'copy']) {
        const f = await archiveFixture(t);
        if (kind === 'receipt') f.env.NATIVE_CANDIDATE_RECEIPT = JSON.stringify({ ...f.receipt, sourceDigest: 'f'.repeat(64) });
        if (kind === 'source') {
            f.candidate.sourceKey = 'source/unpinned.zip';
            const bytes = Buffer.from(JSON.stringify(f.candidate));
            f.originals.set(f.receipt.candidateKey, bytes);
            f.env.NATIVE_CANDIDATE_RECEIPT = JSON.stringify({ ...f.receipt, candidateSha256: hash(bytes) });
        }
        if (kind === 'image') f.pair.imageDigest = `sha256:${'f'.repeat(64)}`;
        if (kind === 'commit') f.pair.sourceCommit = 'f'.repeat(40);
        if (kind === 'build') f.build.buildStatus = 'FAILED';
        if (kind === 'build-version') f.build.sourceVersion = 'changed';
        if (kind === 'current-source') f.resources.packageSource = async () => ({ sourceDigest: 'f'.repeat(64) });
        if (kind === 'source-bytes') f.originals.set(f.candidate.sourceKey, Buffer.from('changed source'));
        if (kind === 'bytes') f.originals.set(f.receipt.candidateKey, Buffer.from('changed'));
        if (kind === 'version') {
            const createCall = f.dependencies.createCall;
            f.dependencies.createCall = async () => { const call = await createCall(); return async args => ({ ...await call(args), VersionId: 'changed' }); };
        }
        if (kind === 'copy') f.store.read = async () => Buffer.from('changed');
        await assert.rejects(captureRendererArchive(f.env, f.store, f.pair, f.dependencies));
    }
});
async function qualificationFixture(t, mode) {
    const f = await fixture(t), pair = { releaseId: f.env.NATIVE_VERIFY_RELEASE, sourceCommit: f.env.GITHUB_SHA, imageDigest: `sha256:${'d'.repeat(64)}` };
    const primary = Error('Native candidate verification failed: pinned candidate receipt and current source.');
    const inventory = { schemaVersion: 1, runId: f.env.GITHUB_RUN_ID, releaseId: pair.releaseId, sourceCommit: pair.sourceCommit, fixtures: [] };
    let captures = 0;
    const cf = { query: async sql => {
        assert.match(sql, /SELECT design_id FROM storage_test_fixtures/); captures++; return [{ results: [] }];
    }, storyVideoLifecycle: async () => ({ rules: [{ id: 'expire-development-benchmarks-after-seven-days', enabled: true,
        conditions: { prefix: 'benchmarks/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } } }] }) };
    const dependencies = { developmentCloudflare: () => cf, createDevelopmentReleaseStore: async () => f.store,
        qualificationIdentity: async () => pair, captureRendererEvidence: async () => ({}), qualifyShippingDatabase: async () => ({ evidence: {} }),
        captureQualificationInventory: async () => { captures++; return inventory; }, captureRendererArchive: async () => { throw primary; },
        verifyReusableRenderer: async () => { if (mode === 'fallback') throw Error('renderer drift'); return {}; } };
    for (const [index, name] of ['Families', 'Exhaustion', 'Faults', 'Termination', 'Load'].entries())
        dependencies[`qualifyDevelopment${name}`] = async () => ({ ...pair, evidence: { key: `source/releases/native-789/qualification-stage-${index}.json`, version: 'v1', sha256: 'e'.repeat(64) } });
    if (mode === 'components') {
        const save = f.store.save;
        f.store.save = (name, bytes) => { if (name === 'qualification-complete-summary.json') throw primary; return save(name, bytes); };
    }
    if (mode !== 'full') {
        f.env.NATIVE_OPERATION = 'qualify-components';
        f.env.NATIVE_RENDERER_REFERENCE = JSON.stringify({ key: `source/releases/native-${protectedConfig('resource_8d0190ecec7d')}/qualification-receipt-native-456-run-200.json`, version: 'v1', sha256: 'a'.repeat(64) });
    }
    const entryDependencies = { cloudflare: () => cf, verifyCheckout: async () => {},
        qualifyRelease: (env, options) => qualifyDevelopmentRelease(env, { ...options, dependencies }),
        qualifyComponents: (env, options) => qualifyDevelopmentComponents(env, { ...options, dependencies }),
        cleanup: async (env, api, options) => cleanupDevelopmentQualification(env, api, { ...options, store: await createDevelopmentReleaseStore(env, f.run) }) };
    return { ...f, cf, primary, entryDependencies, captures: () => captures };
}
test('entrypoint reuses the exact durable inventory after full, component and full-fallback finalization failures', async t => {
    for (const mode of ['full', 'components', 'fallback']) {
        const f = await qualificationFixture(t, mode);
        await assert.rejects(executeNativeDevelopment(f.env, f.entryDependencies), error => error === f.primary);
        assert.equal(f.captures(), 1, mode);
        assert.equal(f.calls.filter(args => args[1] === 'put-object' && args.some(value => value.includes('qualification-cleanup-inventory'))).length, 1, mode);
        assert.ok([...f.objects.keys()].some(key => key.includes('qualification-cleanup-complete')), mode);
        assert.ok(![...f.objects.keys()].some(key => /qualification-(receipt|complete-summary)/.test(key)), mode);
    }
});
test('entrypoint retains primary and secondary Error diagnostics without recapturing the inventory', async t => {
    const f = await qualificationFixture(t, 'full'), secondary = Error('synthetic underlying lifecycle failure');
    f.cf.storyVideoLifecycle = async () => { throw secondary; };
    await assert.rejects(executeNativeDevelopment(f.env, f.entryDependencies), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [f.primary, secondary]);
        return true;
    });
    assert.equal(f.captures(), 1);
});
test('actual post-inventory legacy cleanup callchain rejects the same create-only S3 key', async t => {
    const f = await qualificationFixture(t, 'full');
    await assert.rejects(f.entryDependencies.qualifyRelease(f.env), error => error === f.primary);
    await assert.rejects(f.entryDependencies.cleanup(f.env, f.cf), error => {
        assert.equal(error.cause.message, 'immutable key already exists'); return true;
    });
    const attempts = f.calls.filter(args => args[1] === 'put-object' && args.some(value => value.includes('qualification-cleanup-inventory')));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0][attempts[0].indexOf('--key') + 1], attempts[1][attempts[1].indexOf('--key') + 1]);
    assert.ok(attempts.every(args => args[args.indexOf('--if-none-match') + 1] === '*'));
    assert.equal([...f.objects.keys()].filter(key => key.includes('qualification-cleanup-inventory')).length, 1);
});
test('uncertain inventory save stops fallback cleanup without recapture or a second write', async t => {
    const f = await qualificationFixture(t, 'full'), save = f.store.save;
    f.store.save = async (...args) => { await save(...args); throw Error('lost inventory save acknowledgement'); };
    await assert.rejects(executeNativeDevelopment(f.env, f.entryDependencies), error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /lost inventory save acknowledgement/);
        assert.match(error.errors[1].message, /saved inventory reference missing/); return true;
    });
    assert.equal(f.captures(), 1);
    assert.equal(f.calls.filter(args => args[1] === 'put-object').length, 1);
});
