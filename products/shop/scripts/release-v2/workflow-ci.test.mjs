import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, stat } from 'node:fs/promises';
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
  assert.deepEqual(permissions, { contents: 'read', actions: 'read', checks: 'read', statuses: 'read', 'pull-requests': 'read' });
  assert.doesNotMatch(text, /^\s+[a-z-]+: write$/m);
  assert.match(text, /environment: Preview/);
  assert.match(text, /github\.ref == 'refs\/heads\/main'/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /if: always\(\)\n\s+run: node products\/shop\/scripts\/release-v2\/workflow-ci\.mjs seal/);
  assert.match(text, /path: \$\{\{ runner\.temp \}\}\/shop-composition-sealed/);
});

async function setup(t) {
  const fixture = await createBootstrapFixture(t, { root: process.env.TMPDIR });
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
  const inventory = parseJSON(await readFile(join(evidence, 'workflow-inventory.private.json')));
  assert.deepEqual(inventory.inventory.map(item => item.path), ['workflow-preparation.private.json']);
  await assert.rejects(prepareWorkflow(env), { code: 'EEXIST' });
});

test('package digest substitution and noncanonical workflow identity fail before installation', async t => {
  const { env } = await setup(t);
  await assert.rejects(prepareWorkflow({ ...env, SHOP_COMPOSITION_INSTALLATION_PACKAGE_SHA256: '0'.repeat(64) }), /package bytes differ/);
  await assert.rejects(prepareWorkflow({ ...env, GITHUB_REF: 'refs/heads/other' }), /Canonical protected workflow/);
});
