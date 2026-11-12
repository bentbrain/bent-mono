import test from 'node:test';
import assert from 'node:assert/strict';
import { componentBaselines, componentReleasePlan, releaseComponents } from './release-components.mjs';
import { componentHistory } from './release-component-history.fixtures.mjs';
import { apiOnlyPaths } from './native-api-image.mjs';
const source = 'a'.repeat(40), old = 'b'.repeat(40);
const bases = { web: { source: old, runId: 1, deploymentId: 1 }, native: { source: old, runId: 2, deploymentId: 2 } };
const plan = paths => componentReleasePlan({ source, target: 'preview', baselines: bases, changes: () => paths, policyVersion: 1 });
test('legacy policy: shipping and email correction omits unchanged web, retaining cloud qualification', () => {
    const p = plan(['workers/api/src/printify-webhooks.ts', 'workers/api/src/shopify-admin-client.ts', 'shopify/notifications/templates/shipping_confirmation.liquid']);
    assert.deepEqual(p.stages.map(s => s.inputs.operation), ['release', 'qualify-all']);
    assert.equal(p.mode, 'api');
    assert.equal(p.components.web, false);
    assert.equal(p.components.notifications, true);
});
test('templates and documentation alone do not dispatch an application release', () => {
    assert.deepEqual(plan(['shopify/notifications/email.css']).stages, []);
    assert.deepEqual(plan(['docs/acceptance.json']).stages, []);
    assert.equal(apiOnlyPaths(['shopify/notifications/test.mjs']), true);
});
test('legacy policy: web changes select web only; unknown/shared/policy changes require the full plan', () => {
    assert.deepEqual(plan(['apps/web/src/app/page.tsx']).stages.map(s => s.workflow), ['deploy.yml']);
    for (const path of ['AGENTS.md', 'bun.lock', 'package.json', '.github/workflows/native-development.yml', 'scripts/release-coordinator.mjs', 'packages/core/src/index.ts']) {
        const p = plan([path]);
        assert.equal(p.stages.length, 3, path);
        assert.equal(p.mode, 'full', path);
    }
    assert.equal(plan(['workers/api/drizzle/0036_new.sql']).mode, 'full');
    assert.equal(plan(['workers/video-renderer/index.ts']).mode, 'full');
});
test('legacy policy: unknown and divergent component baselines cannot skip required deployments', () => {
    const p = componentReleasePlan({ source, target: 'production', baselines: { web: null, native: null } });
    assert.equal(p.stages.length, 2);
    assert.equal(p.mode, 'full');
    assert.equal(componentReleasePlan({ source, target: 'preview', baselines: bases, changes: () => undefined, policyVersion: 1 }).stages.length, 3);
    assert.deepEqual(releaseComponents(undefined), { web: true, api: true, renderer: true, notifications: true });
});
test('each component compares against its own deployed source', () => {
    const p = componentReleasePlan({ source, target: 'production', baselines: { ...bases, web: { ...bases.web, source } }, changes: (base) => base === source ? [] : ['workers/api/src/printify-webhooks.ts'] });
    assert.deepEqual(p.stages.map(s => s.workflow), ['native-production.yml']);
});
test('changed print preparation selects full native deployment without an unchanged storefront', () => {
    const paths = ['docs/print-latency-qualification.md', 'workers/api/src/print-asset-staging.test.ts', 'workers/api/src/print-asset-staging.ts'];
    for (const target of ['preview', 'production']) {
        const p = componentReleasePlan({ source, target, baselines: bases, changes: () => paths });
        assert.equal(p.mode, 'full');
        assert.equal(p.components.web, false);
        assert.equal(p.qualification.operation, 'qualify-all');
        assert.deepEqual(p.stages, target === 'preview' ? [
            { workflow: 'native-development.yml', inputs: { operation: 'release', release_mode: 'full' } },
            { workflow: 'preview-smoke.yml', inputs: {} },
        ] : [{ workflow: 'native-production.yml', inputs: { operation: 'promote', release_mode: 'full' } }]);
    }
});
test('known print executor runtime inputs require full while test-only and historical plans retain image reuse', () => {
    for (const path of ['workers/api/src/print-assets.ts', 'workers/api/src/print-png.ts',
        'workers/api/src/print-asset-memory.ts', 'workers/api/src/print-execution-object.ts',
        'workers/api/src/observability.ts', 'packages/contracts/src/limits.ts']) {
        assert.equal(componentReleasePlan({ source, target: 'preview', baselines: bases, changes: () => [path] }).mode, 'full', path);
    }
    const paths = ['workers/api/src/print-asset-staging.test.ts'];
    assert.equal(componentReleasePlan({ source, target: 'preview', baselines: bases, changes: () => paths }).mode, 'api');
    for (const policyVersion of [1, 2]) {
        assert.equal(componentReleasePlan({ source, target: 'preview', baselines: bases, changes: () => ['workers/api/src/print-asset-staging.ts'], policyVersion }).mode, 'api');
    }
});
function baselineFixture(mutate = () => { }) {
    const f = componentHistory('production');
    mutate(f.runs);
    return f.api;
}
test('authenticated successful environment history identifies native and web sources separately', async () => {
    assert.deepEqual(await componentBaselines({ api: baselineFixture(), target: 'production' }), { web: { source, runId: 20, deploymentId: 201 }, native: { source, runId: 10, deploymentId: 100 } });
});
test('failed, rerun, rollback and wrong-identity deployments never establish a skip baseline', async () => {
    for (const mutate of [runs => runs[20].conclusion = 'failure', runs => runs[20].run_attempt = 2, runs => runs[20].repository.id = 1, runs => runs[20].path = 'unknown']) {
        const result = await componentBaselines({ api: baselineFixture(mutate), target: 'production' });
        assert.equal(result.web, null);
    }
    assert.equal((await componentBaselines({ api: baselineFixture(r => r[10].display_title = r[10].display_title.replace('promote', 'rollback')), target: 'production' })).native, null);
});
test('resume rejects a changed baseline and accepts only its own verified deployment', async () => {
    const { verifyComponentBaselines } = await import('./release-components.mjs');
    const journal = { source, selection: { baselines: bases }, stages: [] };
    verifyComponentBaselines(journal, bases);
    assert.throws(() => verifyComponentBaselines(journal, { ...bases, web: null }), /baseline changed/);
    journal.stages.push({ status: 'complete', workflow: 'native-development.yml', inputs: { operation: 'release' }, runId: 99 });
    assert.throws(() => verifyComponentBaselines(journal, bases), /baseline changed/);
    verifyComponentBaselines(journal, { ...bases, native: { source, runId: 99, deploymentId: 10 } });
    assert.throws(() => verifyComponentBaselines(journal, { ...bases, native: { source: old, runId: 99, deploymentId: 10 } }), /baseline changed/);
});
test('legacy policy: only the isolated shipping boundary with identical full renderer inputs selects component qualification', () => {
    const rendererBaseline = { sourceCommit: old, nodeVersion: 'v24.7.0', reference: { key: 'original' }, inputsDigest: 'd'.repeat(64) };
    const manifest = () => ({ schemaVersion: 1, boundary: 'isolated-printify-webhooks-v1', inputsDigest: 'd'.repeat(64) });
    const make = (paths, inputs = manifest) => componentReleasePlan({ source, target: 'preview', baselines: bases, rendererBaseline, changes: () => paths, manifest: inputs, policyVersion: 1 });
    assert.equal(make(['workers/api/src/printify-webhooks.ts']).stages[1].inputs.operation, 'qualify-components');
    assert.equal(make(['workers/api/src/shopify-admin-client.ts']).stages[1].inputs.operation, 'qualify-all');
    assert.equal(make(['workers/api/src/printify-webhooks.ts'], () => null).stages[1].inputs.operation, 'qualify-all');
    assert.equal(make(['workers/api/src/index.ts']).stages[1].inputs.operation, 'qualify-all');
});
test('legacy policy: application contracts select web/API and reuse only the image, retaining full cloud qualification', () => {
    for (const path of ['design.ts', 'limits.ts', 'cart.ts', 'cart-line-capability.ts']) {
        const changed = `packages/contracts/src/${path}`;
        assert.deepEqual(releaseComponents([changed]), { web: true, api: true, renderer: false, notifications: false });
        const p = plan([changed]);
        assert.equal(p.mode, 'api');
        assert.equal(p.stages[1].inputs.operation, 'qualify-all');
        assert.equal(apiOnlyPaths([changed]), true);
    }
    for (const path of ['packages/contracts/package.json', 'packages/contracts/src/new-contract.ts',
        'packages/contracts/src/product-mockup-geometry.js', 'packages/contracts/src/product-mockup-geometry.d.ts']) {
        assert.equal(plan([path]).mode, 'full', path);
        assert.equal(apiOnlyPaths([path]), false, path);
    }
});
test('a running camera smoke never replaces or hides the underlying deployment baselines', async () => {
    const f = componentHistory();
    f.addRun(30, 'smoke');
    f.runs[30].status = 'in_progress'; f.runs[30].conclusion = null;
    f.jobs[30].jobs[0].status = 'in_progress'; f.jobs[30].jobs[0].conclusion = null;
    f.statuses[300].shift();
    const baseline = await componentBaselines({ api: f.api, target: 'preview' });
    assert.equal(baseline.native.runId, 10);
    assert.equal(baseline.web.runId, 20);
});
test('failed-fixture cleanup is ignored while discovering actual deployment baselines', async () => {
    const f = componentHistory(); f.addRun(30, 'native', 'cleanup-failed-qualification'); f.inactivate();
    const result = await componentBaselines({ api: f.api, target: 'preview' });
    assert.equal(result.native.runId, 10); assert.equal(result.web.runId, 20);
});
test('retained qualification inspection is ignored while discovering actual deployment baselines', async () => {
    const f = componentHistory(); f.addRun(30, 'native', 'inspect-failed-qualification'); f.inactivate();
    const result = await componentBaselines({ api: f.api, target: 'preview' });
    assert.equal(result.native.runId, 10); assert.equal(result.web.runId, 20);
});
test('routine provider-contract releases omit unchanged web and reuse only the proven renderer boundary', () => {
    const rendererBaseline = { sourceCommit: old, nodeVersion: 'v24.7.0', reference: { key: 'original' }, inputsDigest: 'd'.repeat(64), boundary: 'isolated-printify-contracts-v2' };
    const manifest = () => ({ schemaVersion: 1, boundary: rendererBaseline.boundary, inputsDigest: rendererBaseline.inputsDigest });
    const options = { source, baselines: bases, rendererBaseline, manifest, changes: () => ['workers/api/src/printify-order-identity.ts'] };
    const preview = componentReleasePlan({ ...options, target: 'preview' });
    assert.deepEqual(preview.stages.map(stage => stage.workflow), ['native-development.yml', 'preview-smoke.yml']);
    assert.equal(preview.mode, 'api');
    assert.equal(preview.routineTargetMs, 600000);
    assert.equal(preview.qualification.kind, 'commerce');
    const qualification = componentReleasePlan({ ...options, target: 'qualification', baselines: { ...bases, native: { ...bases.native, source } } });
    assert.equal(qualification.stages[0].inputs.operation, 'qualify-components');
    const production = componentReleasePlan({ ...options, target: 'production' });
    assert.deepEqual(production.stages.map(stage => stage.workflow), ['native-production.yml']);
    assert.equal(componentReleasePlan({ ...options, target: 'preview', changes: () => ['workers/api/src/index.ts'] }).routineTargetMs, null);
    assert.equal(componentReleasePlan({ ...options, target: 'preview', manifest: () => null }).qualification.operation, 'qualify-all');
});
