import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityFixture } from './testing/hosted-authority-fixture.mjs';
import { canonical, digest, sha256 } from './data.mjs';
import { actionsIdentity, validateHostedRoot, verifyHostedAuthority, readHostedRoot } from './hosted-admission.mjs';

test('source authority is anchored separately from composition signing and retains the original accepted-source time', async () => {
  const f = await authorityFixture();
  const admitted = verifyHostedAuthority(f.seal(f.payload), f);
  assert.equal(admitted.payload.acceptedAt, f.now - 2000);
  assert.equal(admitted.payload.portableManifests[0].awsImageQualified, false);
  const changed = f.seal(f.payload); changed.payload.providerPolicyDigest = sha256('other-target');
  assert.throws(() => verifyHostedAuthority(changed, f), /signature/);
  const reused = structuredClone(f.root); reused.sourceAuthorityKeys = reused.compositionKeys;
  assert.throws(() => validateHostedRoot(reused), /Duplicate/);
});

test('fresh signatures cannot widen installed target, secret, workflow, repository, validity or invocation admission', async () => {
  const f = await authorityFixture();
  for (const mutate of [
    value => { value.scope = 'production'; },
    value => { value.environment = 'Production'; },
    value => { value.repository.repositoryId++; },
    value => { value.repositoryName = 'other/repo'; },
    value => { value.head = 'e'.repeat(40); },
    value => { value.workflowCommit = value.base; },
    value => { value.workflowPath = '.github/workflows/other.yml'; },
    value => { value.runId++; },
    value => { value.attempt++; },
    value => { value.expiresAt = f.now; },
    value => { value.expiresAt = value.issuedAt + 600001; },
    value => { value.issuedAt = f.now + 1; },
    value => { value.acceptedAt = f.now + 1; },
    value => { value.policy.scope = 'inactive-loopback'; },
    value => { value.policy.schema = 'shop.fixture-trust/v2'; },
    value => { value.providerPolicyDigest = sha256('different-resource'); },
    value => { value.secretInstallations = []; },
    value => { value.secretInstallations.push(value.secretInstallations[0]); },
    value => { value.portableManifests.push(value.portableManifests[0]); },
    value => { value.quality.head = value.base; },
    value => { value.unreviewedField = true; }
  ]) {
    const payload = structuredClone(f.payload); mutate(payload);
    assert.throws(() => verifyHostedAuthority(f.seal(payload), f));
  }
  const envelope = f.seal(f.payload), revoked = { ...f.root, revokedAuthorities: [digest(envelope)] };
  assert.throws(() => verifyHostedAuthority(envelope, { ...f, root: revoked }), /revoked/);
});

test('hosted context binds exact canonical Actions workflow, numeric identities, source and attempt', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/shop-composition-qualification.yml@refs/heads/main',
    GITHUB_REPOSITORY_OWNER_ID: '10', GITHUB_REPOSITORY_ID: '20', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '30', GITHUB_RUN_ATTEMPT: '1' };
  assert.equal(actionsIdentity(env).runId, 30);
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/branch' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_SHA: 'a'.repeat(40) }, { GITHUB_RUN_ATTEMPT: '01' }, { GITHUB_RUN_ID: '9007199254740993' }]) {
    assert.throws(() => actionsIdentity({ ...env, ...change }));
  }
});

test('bundle contents cannot install or replace the external protected root', async () => {
  const f = await authorityFixture(), root = await realpath(await mkdtemp(join(tmpdir(), 'hosted-root-')));
  await chmod(root, 0o700); const path = join(root, 'trust.json'), bundle = join(root, 'bundle'); await mkdir(bundle);
  const bytes = Buffer.from(canonical(f.root)); await writeFile(path, bytes, { mode: 0o600 });
  assert.deepEqual(await readHostedRoot(path, sha256(bytes), bundle), f.root);
  await assert.rejects(readHostedRoot(path, sha256('substitute'), bundle), /digest differs/);
  const internal = join(bundle, 'root.json'); await writeFile(internal, bytes, { mode: 0o600 });
  await assert.rejects(readHostedRoot(internal, sha256(bytes), bundle), /Separate/);
  const alias = join(root, 'alias'); await symlink(path, alias);
  await assert.rejects(readHostedRoot(alias, sha256(bytes), bundle), /Separate/);
  await chmod(path, 0o644); await assert.rejects(readHostedRoot(path, sha256(bytes), bundle), /Separate/);
});
