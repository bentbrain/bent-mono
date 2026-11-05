import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { qualificationPolicy, assertQualifiedSource } from './release-qualification-policy.mjs';
import { componentReleasePlan } from './release-components.mjs';
import { createCoordinator, coordinatorPlan, coordinatedRunTitle } from './release-coordinator.mjs';
import { verifySmokeBaselines } from './preview-smoke-context.mjs';
import { releaseMeasurements } from './release-measurements.mjs';
const source = 'a'.repeat(40), previous = 'b'.repeat(40);
const baselines = {native: {source: previous, runId: 100, deploymentId: 1}, web: {source: previous, runId: 101, deploymentId: 2}};
const make = paths => componentReleasePlan({source, target: 'preview', baselines, changes: () => paths});

test('Preview deploys then checks camera without automatic fault/load qualification in every mode', () => {
  for (const mode of ['api', 'full']) assert.deepEqual(coordinatorPlan('preview', mode).map(stage => stage.inputs.operation ?? 'web'), ['release', 'web']);
  for (const paths of [['workers/api/src/index.ts'], ['workers/video-renderer/index.ts'], ['infra/story-video-lambda/main.tf'], ['package.json']]) {
    const plan = make(paths);
    assert.ok(plan.stages.some(stage => ['deploy.yml', 'preview-smoke.yml'].includes(stage.workflow)));
    assert.ok(plan.stages.every(stage => !stage.inputs.operation?.startsWith('qualify')));
    assert.equal(plan.qualification.requiredBeforeNativePromotion, true);
    assert.equal(plan.estimatedMinutes, null);
  }
  assert.deepEqual(make(['apps/web/src/app/page.tsx']).stages.map(stage => stage.workflow), ['deploy.yml']);
  assert.deepEqual(make(['docs/readme.md']).stages, []);
});

test('independent qualification binds the exact deployed native run and never redeploys', () => {
  const live = {...baselines, native: {...baselines.native, source}};
  const plan = componentReleasePlan({source, target: 'qualification', baselines: live, changes: () => []});
  assert.deepEqual(plan.stages, [{workflow: 'native-development.yml', inputs: {operation: 'qualify-all', verify_release: 'native-100'}}]);
  const journal = createCoordinator({source, target: 'qualification', mode: 'auto', selection: plan});
  assert.match(coordinatedRunTitle(journal, 0), /qualify-all · full · native-100/);
  for (const native of [null, {...live.native, source: previous}, {...live.native, runId: undefined}])
    assert.throws(() => componentReleasePlan({source, target: 'qualification', baselines: {...live, native}, changes: () => []}), /Deploy Preview first/);
});

test('only source-equivalent isolated shipping selects the narrow manual suite', () => {
  const rendererBaseline = {sourceCommit: previous, nodeVersion: 'v24.7.0', inputsDigest: 'd'.repeat(64), reference: {key: 'original'}};
  const manifest = () => ({schemaVersion: 1, boundary: 'isolated-printify-webhooks-v1', inputsDigest: 'd'.repeat(64)});
  const plan = (path, read = manifest) => componentReleasePlan({source, target: 'qualification',
    baselines: {...baselines, native: {...baselines.native, source}}, rendererBaseline, manifest: read,
    changes: base => base === source ? [] : [path]});
  assert.equal(plan('workers/api/src/printify-webhooks.ts').stages[0].inputs.operation, 'qualify-components');
  assert.equal(plan('workers/api/src/printify-webhooks.ts', () => null).stages[0].inputs.operation, 'qualify-all');
  for (const path of ['workers/api/src/index.ts', 'workers/api/src/story-video.ts', 'workers/api/src/queue.ts',
    'workers/api/src/retry.ts', 'workers/api/drizzle/0036_new.sql', 'workers/api/sql/native-release-controls.sql',
    'workers/video-renderer/index.ts', 'infra/story-video-lambda/main.tf', 'bun.lock', 'package.json',
    'packages/contracts/src/design.ts', '.github/workflows/native-development.yml', 'scripts/native-ci-operation.mjs', 'unknown']) {
    assert.equal(qualificationPolicy([path]).kind, 'full', path);
    assert.equal(plan(path).stages[0].inputs.operation, 'qualify-all', path);
    assert.throws(() => assertQualifiedSource(previous, source, () => [path]), /differs from qualification/, path);
  }
});

test('Production qualification cannot cross unknown history, migration, policy or mixed changes', () => {
  for (const paths of [undefined, ['workers/api/src/printify-webhooks.ts'], ['docs/report.md', 'scripts/release-coordinator.mjs'],
    ['apps/web/public/mockups/shirt.png']]) assert.throws(() => assertQualifiedSource(previous, source, () => paths));
  for (const paths of [[], ['docs/report.md'], ['apps/web/src/app/page.tsx']])
    assert.equal(assertQualifiedSource(previous, source, () => paths).kind, 'unchanged');
  const candidate = readFileSync(new URL('./native-production-candidate.mjs', import.meta.url), 'utf8');
  assert.match(candidate, /assertQualifiedSource\(qualification.sourceCommit, env.GITHUB_SHA\)/);
});

test('native-only camera smoke refuses a stale Worker, changed web or unknown web baseline', () => {
  const live = {...baselines, native: {...baselines.native, source}};
  assert.equal(verifySmokeBaselines(source, live, () => ['workers/api/src/index.ts']).source, source);
  assert.throws(() => verifySmokeBaselines(source, baselines, () => []));
  assert.throws(() => verifySmokeBaselines(source, {...live, web: null}, () => []));
  for (const paths of [undefined, ['apps/web/src/app/page.tsx'], ['bun.lock']])
    assert.throws(() => verifySmokeBaselines(source, live, () => paths));
  const workflow = readFileSync(new URL('../.github/workflows/preview-smoke.yml', import.meta.url), 'utf8');
  assert.match(workflow, /--project mobile-camera-chromium --retries=0/);
  assert.match(workflow, /preview-smoke-context.mjs before/);
  assert.match(workflow, /preview-smoke-context.mjs after/);
  assert.match(workflow, /group: deploy-development/);
});

test('old and new plan timings never pool into one release estimate', () => {
  const journal = {schemaVersion: 1, repository: 'bentbrain/bent-mono', source, target: 'preview', mode: 'api',
    createdAt: '2026-09-17T01:00:00Z', stages: [{status: 'complete', completedAt: '2026-09-17T01:20:00Z'}]};
  assert.equal(releaseMeasurements([{...journal, id: 'old'}, {...journal, id: 'new', policyVersion: 2}]).groups.length, 2);
});
