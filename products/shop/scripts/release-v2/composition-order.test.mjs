import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './data.mjs';
import { admit } from './composition.mjs';
import { codeIdentity } from './component-identity.mjs';
import { scopedFixture } from './testing/scoped-fixtures.mjs';

async function orderedComposition(t, order) {
  const f = await scopedFixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const payload = await f.scopedPayload(f.trust.intentCommits[1]), component = payload.components[0];
  const artifact = JSON.parse(await readFile(join(f.bundle, component.artifact.path)));
  const extra = [];
  for (const path of ['a/file.mjs', 'a.mjs']) extra.push({ ...await f.put(`${artifact.root}/${path}`, 'export const retained = true;'), mediaType: 'application/javascript' });
  const original = artifact.files[0];
  artifact.files = order === 'recursive' ? [extra[0], extra[1], original] : order === 'global' ? [extra[1], extra[0], original] : [original, extra[0], extra[1]];
  artifact.codeDigest = codeIdentity(artifact); component.codeDigest = artifact.codeDigest;
  component.artifact = await f.put(component.artifact.path, artifact);
  const provenance = JSON.parse(await readFile(join(f.bundle, component.provenance.path))); provenance.artifactFilesDigest = digest(artifact.files);
  component.provenance = await f.put(component.provenance.path, provenance);
  for (let index = 0; index < component.componentProofs.length; index++) {
    const ref = component.componentProofs[index], { signature: _signature, ...proof } = JSON.parse(await readFile(join(f.bundle, ref.path)));
    proof.codeDigest = artifact.codeDigest;
    component.componentProofs[index] = await f.put(ref.path, f.signComponentProof(proof));
  }
  return { f, payload, manifest: await f.seal(payload, 'ordered-composition.json') };
}

for (const order of ['global', 'recursive']) test(`composition preserves exact ${order} retained artifact order`, async t => {
  const { f, payload, manifest } = await orderedComposition(t, order);
  const result = await admit({ bundle: f.bundle, manifest, trustPath: f.trustPath });
  assert.equal(result.compositionDigest, digest(payload));
  assert.equal(result.artifacts.get(payload.components[0].id).codeDigest, payload.components[0].codeDigest);
});

test('composition rejects arbitrary retained artifact order even with matching signatures', async t => {
  const { f, manifest } = await orderedComposition(t, 'arbitrary');
  await assert.rejects(admit({ bundle: f.bundle, manifest, trustPath: f.trustPath }), /canonical path or directory order/);
});
