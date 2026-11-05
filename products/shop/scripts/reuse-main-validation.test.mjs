import { protectedConfig } from "./protected-config.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { reuseMainValidation } from './reuse-ci.mjs';
import { validationInputs, matchingValidation } from './validation-inputs.mjs';
const source = 'a'.repeat(40), old = 'b'.repeat(40), oid = 'c'.repeat(40);
const env = { ImageOS: 'ubuntu24', ImageVersion: '20260907.1' };
const files = ['apps/web/src/page.tsx', 'workers/api/src/index.ts', 'workers/video-renderer/index.ts', 'bun.lock', '.github/workflows/deploy.yml', 'docs/acceptance.json'];
const manifest = (change = {}, options = {}) => validationInputs(source, { env, platform: 'linux', arch: 'x64', node: 'v24.13.1',
    readTree: () => files.map(path => `100644 blob ${change[path] ?? oid}\t${path}`).join('\0'), ...options });
test('metadata-only changes preserve component evidence; source, policy, lockfile and build environment invalidate it', () => {
    const before = manifest();
    assert.equal(matchingValidation(before, manifest({ 'docs/acceptance.json': 'd'.repeat(40) })), true);
    for (const path of files.filter(path => !path.startsWith('docs/')))
        assert.equal(matchingValidation(before, manifest({ [path]: 'd'.repeat(40) })), false, path);
    for (const options of [{ node: 'v24.14.0' }, { env: { ...env, ImageVersion: '20260908.1' } }, { env: { ...env, NEXT_PUBLIC_FEATURE: 'different' } }, { env: { ...env, NODE_OPTIONS: '--require=injection' } }])
        assert.equal(matchingValidation(before, manifest({}, options)), false);
});
function fixture(mutate = () => { }) {
    const inputs = { ...manifest(), sourceCommit: old };
    const run = { id: 42, head_sha: old, head_branch: 'main', path: '.github/workflows/native-development.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_attempt: 1,
        repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) } };
    const job = { name: 'check', head_sha: old, conclusion: 'success', steps: [{ name: 'Check commit without existing CI', conclusion: 'success' }] };
    const record = { ...inputs, runId: 42, job: 'check' };
    mutate({ run, job, record });
    return { sha: source, branch: 'main', repository: 'bentbrain/bent-mono', currentRunId: 50, env,
        inputs: () => inputs, readPointer: async () => record, api: async (path) => path.includes('/jobs?') ? { jobs: [job] } : { workflow_runs: [run] } };
}
test('a trusted completed main validation with matching component and runner evidence can qualify a metadata commit', async () => {
    assert.equal(await reuseMainValidation(fixture()), 42);
});
test('PRs, failed runs, reused checks, changed environments and missing receipts never establish main admission', async () => {
    for (const change of [({ run }) => run.event = 'pull_request', ({ run }) => run.conclusion = 'cancelled', ({ run }) => run.run_attempt = 2,
        ({ run }) => run.repository.owner.id = 1, ({ job }) => job.steps[0].conclusion = 'skipped', ({ record }) => record.inputsDigest = 'd'.repeat(64),
        ({ record }) => record.runId = 43, ({ record }) => record.sourceCommit = source])
        assert.equal(await reuseMainValidation(fixture(change)), undefined);
    assert.equal(await reuseMainValidation({ ...fixture(), readPointer: async () => null }), undefined);
    assert.equal(await reuseMainValidation({ ...fixture(), branch: 'feature', api: () => assert.fail('no PR reuse') }), undefined);
});
test('a later deployment failure preserves the completed successful validation job', async () => {
    assert.equal(await reuseMainValidation(fixture(({ run }) => run.conclusion = 'failure')), 42);
    assert.equal(await reuseMainValidation(fixture(({ job }) => job.conclusion = 'failure')), undefined);
    assert.equal(await reuseMainValidation(fixture(({ run }) => run.status = 'in_progress')), undefined);
});
test('receipts describe normalized fixture inputs and keep browser/build overrides and platforms separate', () => {
    const before = manifest();
    for (const options of [{ env: { ...env, PUBLIC_STORE_DOMAIN: 'a-live-store' } }, { env: { ...env, GITHUB_SHA: 'another-source' } },
        { env: { ...env, POSTHOG_CLI_PROJECT_ID: 'other' } }, { env: { ...env, NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: 'other' } }])
        assert.equal(matchingValidation(before, manifest({}, options)), true);
    for (const overrides of [{ E2E_LOCAL_PRODUCT_DEFAULT_COLOR: 'White' }, { PLAYWRIGHT_BROWSERS_PATH: '/other' },
        { LAN_DEV_ORIGIN: 'https://other.example' }, { SHOP_ID: 'other' }, { CI: 'other' }])
        assert.equal(matchingValidation(before, manifest({}, { env: { ...env, ...overrides } })), false);
    assert.equal(manifest({}, { platform: 'darwin' }), null);
    assert.equal(manifest({}, { arch: 'arm64' }), null);
    assert.equal(manifest({}, { env: { ...env, E2E_LOCAL_PRODUCTION: '1' } }), null);
    assert.equal(matchingValidation({ ...before, scope: 'repository-components-v1' }, before), false);
});
