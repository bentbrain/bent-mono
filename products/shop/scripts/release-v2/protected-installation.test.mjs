import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { chmod, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, digest, sha256 } from './data.mjs';
import { installedSigningKey, installProtectedPackage, readProtectedInstallation, readReportingInstallation } from './protected-installation.mjs';
import { createBootstrapFixture, createProtectedPackageFixture } from './testing/bootstrap-fixture.mjs';
import { importHostedPortable } from './artifact-intake.mjs';
import { assembleHostedRelease } from './source-issuance.mjs';
import { hostedController } from './hosted-controller.mjs';

const fixture = t => createBootstrapFixture(t, { root: process.env.SHOP_BOOTSTRAP_TEST_ROOT ?? tmpdir() });
const options = f => ({ path: f.installationPath, digest: f.installationDigest, identity: f.identity, artifactDirectories: [f.portable.root, f.destination] });
async function updateInstallation(f, change) {
  const contract = structuredClone(f.installationContract); await change(contract);
  const bytes = Buffer.from(canonical(contract)); await writeFile(f.installationPath, bytes, { mode: 0o600 });
  return { ...options(f), digest: sha256(bytes) };
}

test('private installation pins raw root bytes, separate key identities, targets and component configuration', async t => {
  const f = await fixture(t), installed = await readProtectedInstallation(options(f));
  assert.equal(installed.rootDigest, sha256(await readFile(installed.rootPath)));
  assert.notEqual(installed.sourceKeyPath, installed.compositionKeyPath);
  assert.notEqual((await installedSigningKey(installed, 'source')).keyId, (await installedSigningKey(installed, 'composition')).keyId);
  assert.equal(installed.plan.providerPolicy.github.environment, 'Preview');
  assert.equal(installed.template.schema, 'shop.hosted-composition-template/v1');
  assert.equal(Object.hasOwn(installed.template, 'intentCommits'), false);
});

test('raw root SHA remains exact when installed JSON formatting changes', async t => {
  const f = await fixture(t), raw = Buffer.from(`${JSON.stringify(f.root, null, 2)}\n`);
  await writeFile(f.installation.rootPath, raw, { mode: 0o600 });
  await assert.rejects(readProtectedInstallation(options(f)), /Installed document bytes differ/);
  const updated = await updateInstallation(f, contract => { contract.root.sha256 = sha256(raw); });
  const installed = await readProtectedInstallation(updated);
  assert.equal(installed.rootDigest, sha256(raw)); assert.notEqual(installed.rootDigest, digest(f.root));
});

test('source and artifact directories cannot install their own authority', async t => {
  const f = await fixture(t);
  await assert.rejects(readProtectedInstallation({ ...options(f), artifactDirectories: [f.directory] }), /outside source and artifact/);
  const alternate = join(f.directory, 'installation-link.json'); await symlink(f.installationPath, alternate);
  await assert.rejects(readProtectedInstallation({ ...options(f), path: alternate }), /Private independently owned/);
});

test('world-readable installation and changed Actions identity fail before signing', async t => {
  const f = await fixture(t);
  await chmod(f.installationPath, 0o644);
  await assert.rejects(readProtectedInstallation(options(f)), /Private independently owned/);
  await chmod(f.installationPath, 0o600);
  await assert.rejects(readProtectedInstallation({ ...options(f), identity: { ...f.identity, repositoryName: 'other/repository' } }), /source or Actions invocation/);
});

test('private signing bytes must match independently pinned source SPKI', async t => {
  const f = await fixture(t);
  await writeFile(f.installation.sourceKeyPath, await readFile(f.installation.compositionKeyPath), { mode: 0o600 });
  await assert.rejects(installedSigningKey(f.installation, 'source'), /SPKI differs/);
});

test('unknown installed fields, secret versions and provider policy substitutions fail closed', async t => {
  const f = await fixture(t);
  const extra = await updateInstallation(f, contract => { contract.callerApproved = true; });
  await assert.rejects(readProtectedInstallation(extra), /Unexpected protocol fields/);
  const secret = await updateInstallation(f, contract => { contract.secretInstallations = [{ name: 'NEW_SECRET', version: 'v2', sha256: '0'.repeat(64) }]; });
  await assert.rejects(readProtectedInstallation(secret), /secret versions differ/);
  const policy = await updateInstallation(f, async contract => {
    const plan = structuredClone(f.plan); plan.providerPolicy.awsAccountId = '111111111111';
    const bytes = Buffer.from(canonical(plan)); await writeFile(contract.targetPlan.path, bytes); contract.targetPlan.sha256 = sha256(bytes);
  });
  await assert.rejects(readProtectedInstallation(policy), /same-account|policy|targets/i);
});

test('reporting recovery reads only the independently installed root and fence', async t => {
  const f = await fixture(t);
  for (const path of [f.installation.sourceKeyPath, f.installation.compositionKeyPath, f.installationContract.compositionTemplate.path,
    f.installationContract.runnerFile.path, f.installationContract.targetPlan.path, f.installationContract.artifactPrivateKeyFile,
    ...f.installationContract.componentConfigurations.map(item => item.config.path)]) await rm(path);
  await rm(f.portable.root, { recursive: true });
  const recovery = await readReportingInstallation(options(f));
  assert.deepEqual(recovery, { rootPath: f.installation.rootPath, rootDigest: f.installation.rootDigest, fencePath: f.installation.fencePath });
  await assert.rejects(readReportingInstallation({ ...options(f), digest: '0'.repeat(64) }), /installation digest differs/);
  await writeFile(f.installation.fencePath, '{}');
  await assert.rejects(readReportingInstallation(options(f)), /Installed document bytes differ/);
});

test('independently pinned package materializes exact root and signing keys without manual path pins', async t => {
  const f = await fixture(t), original = await createProtectedPackageFixture(f);
  const installed = await installProtectedPackage(original);
  assert.equal(installed.packageDigest, original.digest);
  assert.equal(sha256(await readFile(installed.packagePath)), original.digest);
  assert.equal(sha256(await readFile(installed.path)), installed.digest);
  assert.equal(installed.installation.rootDigest, f.installation.rootDigest);
  assert.equal((await installedSigningKey(installed.installation, 'source')).keyId, 'source-authority');
  assert.equal((await installedSigningKey(installed.installation, 'composition')).keyId, 'composition-authority');
  assert.equal(installed.installation.artifactIntake.githubConfigDirectory, join(original.destination, 'github'));
  const imported = await importHostedPortable({ request: f.intake.request, installation: installed.installation.artifactIntake,
    privateKeyFile: installed.installation.artifactPrivateKeyFile, destination: join(f.directory, 'package-intake'), api: f.intake.api });
  const assembled = await assembleHostedRelease({ ...f, installation: installed.installation, imported, destination: join(f.directory, 'package-assembly') });
  const plan = await hostedController({ ...assembled.options, env: f.env, command: 'plan' });
  assert.equal(plan.phase, 'plan-admitted'); assert.equal(plan.readiness.awsImageQualified, false); assert.equal(plan.providerWrites, 0);
  await assert.rejects(installProtectedPackage(original), { code: 'EEXIST' });
});

test('package mutation, path traversal, file digest substitution and unknown mode fields stop materialization', async t => {
  const f = await fixture(t), original = await createProtectedPackageFixture(f);
  await writeFile(original.path, `${canonical(original.packed)}\n`);
  await assert.rejects(installProtectedPackage(original), /package digest differs/);
  for (const mutate of [
    packed => { packed.files[0].path = '../escape'; },
    packed => { packed.files[0].sha256 = '0'.repeat(64); },
    packed => { packed.files[0].mode = '0700'; },
    packed => { packed.directories.push('unknown'); },
  ]) {
    const packed = structuredClone(original.packed); mutate(packed); const bytes = Buffer.from(canonical(packed));
    await writeFile(original.path, bytes);
    await assert.rejects(installProtectedPackage({ ...original, digest: sha256(bytes) }), /Malformed|differs|Unexpected/);
  }
});
