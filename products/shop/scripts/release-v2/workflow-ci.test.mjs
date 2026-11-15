import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, parseJSON } from './data.mjs';
import { prepareWorkflow, sealWorkflow } from './workflow-ci.mjs';
import { createBootstrapFixture, createProtectedPackageFixture } from './testing/bootstrap-fixture.mjs';

test('plan workflow grants the canonical source guard read access and preserves its protected boundary', async () => {
  const text = await readFile(new URL('../../.github/workflows/shop-composition-qualification.yml', import.meta.url), 'utf8');
  const canonicalCopy = await readFile(new URL('../../../../.github/workflows/shop-composition-qualification.yml', import.meta.url), 'utf8');
  assert.equal(text, canonicalCopy);
  const block = text.match(/^permissions:\n((?:  [a-z-]+: [a-z]+\n)+)/m)?.[1];
  assert.ok(block);
  const permissions = Object.fromEntries([...block.matchAll(/^  ([a-z-]+): ([a-z]+)$/gm)].map(([, key, value]) => [key, value]));
  assert.deepEqual(permissions, { contents: 'read', actions: 'read', checks: 'read', statuses: 'read', 'pull-requests': 'read', 'id-token': 'write' });
  assert.doesNotMatch(text, /^\s+(?:contents|actions|checks|statuses|pull-requests): write$/m);
  assert.match(text, /environment: Preview/);
  assert.match(text, /github\.ref == 'refs\/heads\/main'/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /if: always\(\)\n\s+run: node products\/shop\/scripts\/release-v2\/workflow-ci\.mjs seal/);
  assert.match(text, /path: \$\{\{ runner\.temp \}\}\/shop-composition-sealed/);
});

async function setup(t, options = {}) {
  const { historyIntake, ...bootstrapOptions } = options;
  const fixture = await createBootstrapFixture(t, { root: process.env.SHOP_BOOTSTRAP_TEST_ROOT ?? tmpdir(), ...bootstrapOptions });
  if (historyIntake) fixture.installationContract.historyIntake = { repository: fixture.intake.installation.repository, workflow: { id: 333, path: '.github/workflows/shop-composition-qualification.yml', jobName: 'Validate retained composition', jobId: 'plan' }, recipientFingerprint: fixture.intake.installation.recipientFingerprint };
  const packed = await createProtectedPackageFixture(fixture);
  const env = { ...fixture.env, RUNNER_TEMP: fixture.directory, SHOP_COMPOSITION_INSTALLATION_PACKAGE: canonical(packed.packed),
    SHOP_COMPOSITION_INSTALLATION_PACKAGE_SHA256: packed.digest, SHOP_ARTIFACT_RUN_ID: fixture.intake.request.runId,
    SHOP_ARTIFACT_RUN_ATTEMPT: fixture.intake.request.runAttempt, SHOP_ARTIFACT_ID: fixture.intake.request.artifactId };
  return { fixture, env };
}

test('protected workflow package prepares a plan configuration and seals evidence without including signing keys', async t => {
  const { fixture, env } = await setup(t), result = await prepareWorkflow(env);
  const options = parseJSON(await readFile(result.configuration));
  assert.equal(options.command, 'plan'); assert.equal(options.request.sourceCommit, fixture.identity.head);
  assert.equal(Object.hasOwn(options, 'env'), false); assert.equal(result.providerWrites, 0);
  assert.equal((await stat(options.installationPath)).mode & 0o777, 0o600);
  const evidence = join(fixture.directory, 'shop-composition-private');
  assert.deepEqual(await readdir(evidence), ['workflow-preparation.private.json']);
  const sealed = await sealWorkflow(env); assert.equal(sealed.sealed, true);
  const archive = join(fixture.directory, 'shop-composition-sealed');
  assert.deepEqual((await readdir(archive)).sort(), ['composition-evidence.tar.gz.enc', 'composition-evidence.tar.gz.enc.envelope.json', 'composition-evidence.tar.gz.enc.json']);
  const inventory = parseJSON(await readFile(join(fixture.directory, 'shop-composition-retained/shop-composition-private/workflow-inventory.private.json')));
  assert.deepEqual(inventory.inventory.map(item => item.path), ['workflow-preparation.private.json']);
  await assert.rejects(prepareWorkflow(env), { code: 'EEXIST' });
});

test('package digest substitution and noncanonical workflow identity fail before installation', async t => {
  const { env } = await setup(t);
  await assert.rejects(prepareWorkflow({ ...env, SHOP_COMPOSITION_INSTALLATION_PACKAGE_SHA256: '0'.repeat(64) }), /package bytes differ/);
  await assert.rejects(prepareWorkflow({ ...env, GITHUB_REF: 'refs/heads/other' }), /Canonical protected workflow/);
});


test('rollback prepares original artifact/source locators separately from current Actions head', async t => {
  const { env, fixture } = await setup(t, { historyIntake: true, operationCommands: ['advance', 'rollback'] });
  const prepared = await prepareWorkflow({ ...env, SHOP_COMPOSITION_COMMAND: 'rollback', SHOP_HISTORY_RUN_ID: '77', SHOP_HISTORY_RUN_ATTEMPT: '2', SHOP_HISTORY_ARTIFACT_ID: '88', SHOP_HISTORY_SOURCE_COMMIT: '2'.repeat(40) });
  const options = parseJSON(await readFile(prepared.configuration));
  assert.equal(options.request, null); assert.deepEqual(options.historyRequest, { runId: '77', runAttempt: '2', artifactId: '88', sourceCommit: '2'.repeat(40) });
  assert.equal(fixture.identity.head, '1'.repeat(40)); assert.equal(Object.hasOwn(options, 'rollbackDirectory'), false);
});

test('later delivery can import exact original native qualification without changing current source identity', async t => {
  const { env } = await setup(t, { historyIntake: true });
  const prepared = await prepareWorkflow({ ...env, SHOP_QUALIFICATION_RUN_ID: '77', SHOP_QUALIFICATION_RUN_ATTEMPT: '2', SHOP_QUALIFICATION_ARTIFACT_ID: '88', SHOP_QUALIFICATION_SOURCE_COMMIT: '2'.repeat(40) });
  const options = parseJSON(await readFile(prepared.configuration));
  assert.equal(options.request.sourceCommit, '1'.repeat(40)); assert.equal(options.qualificationRequest.sourceCommit, '2'.repeat(40));
});

test('report recovery prepares without any artifact or qualification locator', async t => {
  const { env } = await setup(t);
  const prepared = await prepareWorkflow({ ...env, SHOP_COMPOSITION_COMMAND: 'recover-report', SHOP_COMPOSITION_REPORTING_AUTHORITY: '{}', SHOP_ARTIFACT_RUN_ID: '', SHOP_ARTIFACT_ID: '', SHOP_QUALIFICATION_RUN_ID: 'invalid' });
  const options = parseJSON(await readFile(prepared.configuration)); assert.equal(options.command, 'recover-report');
  for (const field of ['request', 'qualificationRequest', 'historyRequest']) assert.equal(Object.hasOwn(options, field), false);
});


test('native bootstrap evidence seals exact receipt and bounded public proofs without installed signing keys', async t => {
  const { fixture, env } = await setup(t);
  await prepareWorkflow(env);
  const directory = join(fixture.directory, 'shop-composition-private'), proofs = join(directory, 'controller-evidence'); await mkdir(proofs,{mode:0o700});
  const result = {receipt:{payload:{synthetic:true}},readiness:{nativeQualificationComplete:true,executionScope:'fixture/provider-loopback',awsImageQualified:false}};
  await writeFile(join(directory,'result.private.json'),canonical(result),{mode:0o600});
  const proof = `native-qualification-${'a'.repeat(64)}.json`; await writeFile(join(proofs,proof),canonical(result.receipt),{mode:0o600});
  await writeFile(join(proofs,'external-installed-key.pem'),'excluded synthetic key',{mode:0o600});
  const sealed=await sealWorkflow(env); assert.equal(sealed.historicalReleaseRetained,false);
  const retained=join(fixture.directory,'shop-composition-retained/shop-composition-private');
  assert.deepEqual(parseJSON(await readFile(join(retained,'result.private.json'))),result);
  const inventory=parseJSON(await readFile(join(retained,'workflow-inventory.private.json')));
  assert.equal(inventory.schema,'shop.workflow-evidence/v2'); assert.ok(inventory.inventory.some(ref=>ref.path===`native-evidence/${proof}`));
  assert.equal(inventory.inventory.some(ref=>ref.path.includes('external-installed') || ref.path.endsWith('.pem')),false);
});
