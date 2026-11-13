import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scopedFixture } from './testing/scoped-fixtures.mjs';
import { simulator } from './testing/provider-fixtures.mjs';
import { cli } from './testing/cli.mjs';
import { admit } from './composition.mjs';
import { canonical, digest } from './data.mjs';
import { readHead } from './journal.mjs';
import { codeIdentity, selectedVersion } from './component-identity.mjs';

async function finish(f, p) {
  for (let count = 0; count < 40; count++) {
    const result = await cli(f, p.origin);
    assert.equal(result.code, 0, result.stderr);
    if ((await readHead(f.journal))?.state.phase === 'complete') return;
  }
  assert.fail('Controller did not complete within its transition bound');
}

test('actual CLI composes a storefront change with the original native artifact/proof and makes zero native writes', async t => {
  const f = await scopedFixture(), p = await simulator(); t.after(() => p.close());
  const [a, b] = f.trust.intentCommits;
  const first = await f.scopedPayload(a); f.manifest = await f.seal(first, 'first.json');
  await finish(f, p);
  const firstNative = first.components.find(component => component.id === 'consumer'), oldProofs = structuredClone(firstNative.componentProofs);
  p.state.jobs.push({ component: firstNative.id, format: 'job-v1', artifactDigest: firstNative.codeDigest });
  const second = await f.scopedPayload(b, first); f.manifest = await f.seal(second, 'second.json');
  const native = second.components.find(component => component.id === 'consumer');
  assert.equal(native.originSourceCommit, a); assert.equal(second.intentSourceCommit, b);
  assert.equal(native.codeDigest, firstNative.codeDigest); assert.deepEqual(native.componentProofs, oldProofs);
  const before = p.state.operations.length;
  const begin = await cli(f, p.origin, { command: 'begin' }); assert.equal(begin.code, 0, begin.stderr);
  await finish(f, p);
  assert.deepEqual(p.state.operations.slice(before).map(operation => `${operation.kind}/${operation.result.component}`), ['stage/producer', 'activate/producer']);
  assert.ok(p.state.active.some(version => version.component === 'consumer' && version.artifactDigest === native.codeDigest));
  assert.equal((await readHead(f.journal)).state.lastVerified.intentSourceCommit, b);
  assert.deepEqual(p.state.jobs, [{ component: firstNative.id, format: 'job-v1', artifactDigest: firstNative.codeDigest }]);
});

test('code identity survives binding/provenance changes while binding installation version changes', async () => {
  const f = await scopedFixture(), value = await f.scopedPayload(f.trust.intentCommits[1]);
  const component = value.components[0], artifact = JSON.parse(await readFile(join(f.bundle, component.artifact.path)));
  const sameCode = { ...artifact, originSourceCommit: 'd'.repeat(40), inputsDigest: 'e'.repeat(64) };
  assert.equal(codeIdentity(artifact), codeIdentity(sameCode));
  assert.notEqual(selectedVersion(component).version, selectedVersion({ ...component, config: { ...component.config, sha256: 'f'.repeat(64) } }).version);
});

test('expired, forged, revoked or stale component proof cannot advance the real CLI', async t => {
  for (const failure of ['expired', 'forged', 'revoked', 'binding', 'runtime', 'origin', 'proof']) {
    const f = await scopedFixture(), p = await simulator(); t.after(() => p.close());
    const value = await f.scopedPayload(f.trust.intentCommits[1]), component = value.components[0];
    const receipt = JSON.parse(await readFile(join(f.bundle, component.componentProofs[1].path)));
    const { signature: _signature, ...payload } = receipt;
    if (failure === 'expired') { payload.createdAt = Date.now() - 10000; payload.expiresAt = Date.now() - 1; }
    if (failure === 'binding') payload.bindingDigest = 'f'.repeat(64);
    if (failure === 'runtime') payload.runtimeDigest = 'f'.repeat(64);
    if (failure === 'origin') payload.originSourceCommit = 'f'.repeat(40);
    if (failure === 'proof') payload.proofInputsDigest = 'f'.repeat(64);
    const changed = failure === 'forged' ? { ...receipt, signature: Buffer.from('forged').toString('base64') } : f.signComponentProof(payload);
    component.componentProofs[1] = await f.put(`component-proofs/${failure}.json`, changed);
    if (failure === 'revoked') {
      f.trust.revokedReceipts.push(digest(changed)); await writeFile(f.trustPath, canonical(f.trust), { mode: 0o600 }); value.policyDigest = digest(f.trust);
    }
    f.manifest = await f.seal(value, `${failure}.json`);
    assert.equal((await cli(f, p.origin)).code, 1, failure); assert.equal(p.state.operations.length, 0);
  }
});

test('a newly added native input and a swapped root mode fail admission with the old proof', async () => {
  for (const failure of ['native-source', 'mode']) {
    const f = await scopedFixture(), value = await f.scopedPayload(f.trust.intentCommits[1]);
    const snapshot = f.trust.snapshots[1];
    if (failure === 'native-source') await f.put(`${snapshot.root}/new-undeclared-native.mjs`, 'new input');
    else snapshot.files[0].mode = '100755';
    await writeFile(f.trustPath, canonical(f.trust), { mode: 0o600 }); value.policyDigest = digest(f.trust);
    const manifest = await f.seal(value, `${failure}.json`);
    await assert.rejects(admit({ bundle: f.bundle, manifest, trustPath: f.trustPath }));
  }
});
