import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, sha256 } from './data.mjs';
import { packagePortableBundle, verifyPortableBundle, readPortableArtifact, materializePortableBundle } from './portable-bundle.mjs';
import { stageRequest, verifyContent } from './artifact-transport.mjs';
import { conforms } from './composition.mjs';
import { drainJourneyWork } from '../testing/linux-journey.mjs';
import { createPortableFixture as fixture } from './testing/portable-fixture.mjs';


test('retains complete modules, maps, WASM, assets and source snapshots with composition-compatible refs', async t => {
  const { verified, root } = await fixture(t);
  assert.equal(verified.manifest.awsImageQualified, false);
  assert.equal(verified.components.size, 3);
  assert.ok(verified.sourceInventory.root.startsWith('snapshots/'));
  for (const id of ['business', 'native', 'storefront']) {
    const imported = await readPortableArtifact(verified, id);
    assert.equal(imported.files.length, 4);
    assert.ok(imported.files.some(file => file.path.endsWith('.map')));
    assert.ok(imported.files.some(file => file.path.endsWith('.wasm')));
    assert.ok(imported.files.some(file => file.path.endsWith('.woff2')));
    assert.equal(imported.component.codeDigest, imported.artifact.codeDigest);
    assert.equal(imported.artifact.inputsDigest, imported.closure.buildDigest);
    assert.equal(digest(imported.runtime), imported.artifact.runtimeDigest);
  }
  const component = verified.components.get('business');
  const assembly = await materializePortableBundle(verified, join(root, 'hosted-assembly'));
  const config = { schema: 'shop.binding-installation/v1', scope: 'isolated-qualification', component: 'business', bindings: [] };
  const bytes = Buffer.from(JSON.stringify(config)), path = 'bindings/business-test-config.json';
  await mkdir(join(assembly.root, 'bindings'), { mode: 0o700 }); await writeFile(join(assembly.root, path), bytes, { mode: 0o600 });
  // The existing transport independently checks exact artifact bytes and files.
  const upload = await stageRequest(assembly.root, { artifact: component.artifactRef, provenance: component.provenanceRef,
    config: { path, bytes: bytes.length, sha256: sha256(bytes) } });
  conforms(component.provenance, 'hostedProvenance');
  assert.equal(verifyContent(upload.upload, { ...component.component, config: upload.config }, 'isolated-qualification').codeDigest, component.artifact.codeDigest);
  await verifyPortableBundle(verified.root, verified.expected);
  assert.equal(JSON.parse(Buffer.from(upload.upload.artifact, 'base64')).codeDigest, component.artifact.codeDigest);
});

test('requires an externally pinned manifest, exact origin/lineage, hosted authority and runtime identity', async t => {
  const { verified } = await fixture(t);
  await assert.rejects(verifyPortableBundle(verified.root, {}), /externally authenticated/i);
  await assert.rejects(verifyPortableBundle(verified.root, { ...verified.expected, manifestSha256: '0'.repeat(64) }), /manifest identity/);
  await assert.rejects(verifyPortableBundle(verified.root, { ...verified.expected, originSourceCommit: '2'.repeat(40) }), /origin or authenticated/);
  await assert.rejects(verifyPortableBundle(verified.root, { ...verified.expected, lineage: { ...verified.lineage, dirtySnapshot: false } }), /origin or authenticated/);
  await assert.rejects(verifyPortableBundle(verified.root, { ...verified.expected, requireHostedLineage: true }), /hosted artifact lineage/);
  await assert.rejects(verifyPortableBundle(verified.root, { ...verified.expected, runtimeDigests: { business: '0'.repeat(64) } }), /target runtime/);
});

test('rechecks complete bytes before consumption and rejects extra, missing, modified and changed-mode files', async t => {
  for (const change of ['extra', 'missing', 'bytes', 'mode', 'group-mode', 'directory']) {
    await t.test(change, async child => {
      const { verified } = await fixture(child), path = join(verified.root, 'payload/business/index.js');
      if (change === 'extra') await writeFile(join(verified.root, 'payload/business/unknown.js'), 'unknown', { mode: 0o600 });
      if (change === 'missing') await rm(path);
      if (change === 'bytes') await writeFile(path, 'changed');
      if (change === 'mode') await chmod(path, 0o700);
      if (change === 'group-mode') await chmod(path, 0o640);
      if (change === 'directory') await mkdir(join(verified.root, 'unexpected-empty-directory'), { mode: 0o700 });
      await assert.rejects(readPortableArtifact(verified, 'business'), /inventory|mode|directory/);
    });
  }
});

test('rejects payload symlinks and traversal without opening files outside the bundle', async t => {
  const { verified, root } = await fixture(t);
  await symlink(join(root, 'source/package.json'), join(verified.root, 'payload/native/escaped'));
  await assert.rejects(verifyPortableBundle(verified.root, verified.expected), /Symlinks|symlink/);
  await rm(join(verified.root, 'payload/native/escaped'));
  const path = join(verified.root, 'portable-bundle.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.policyRef.path = '../outside.json'; const bytes = Buffer.from(JSON.stringify(manifest)); await writeFile(path, bytes);
  await assert.rejects(verifyPortableBundle(verified.root, { ...verified.expected, manifestSha256: sha256(bytes) }), /Malformed relative path/);
});

test('materializes exact retained bytes into a separate assembly without changing the sealed CI root', async t => {
  const { verified, root } = await fixture(t), destination = join(root, 'assembly');
  const assembly = await materializePortableBundle(verified, destination);
  assert.equal(assembly.kind, 'shop.portable-assembly/v1'); assert.equal(assembly.originManifestSha256, verified.manifestSha256);
  await mkdir(join(destination, 'bindings'), { mode: 0o700 }); await writeFile(join(destination, 'bindings/business.json'), '{}', { mode: 0o600 });
  assert.equal((await verifyPortableBundle(verified.root, verified.expected)).manifestSha256, verified.manifestSha256);
  await assert.rejects(verifyPortableBundle(destination, verified.expected), /inventory/);
  for (const component of assembly.components.values()) for (const file of component.artifact.files)
    assert.equal(sha256(await readFile(join(destination, file.path))), file.sha256);
  await assert.rejects(materializePortableBundle(verified, destination), /EEXIST/);
  await assert.rejects(materializePortableBundle(verified, join(verified.root, 'nested')), /separate/);
});

test('retains origin receipts outside executable code identity and rejects a symlinked import root', async t => {
  const { verified, root, source, components } = await fixture(t);
  const native = components.find(item => item.id === 'native');
  const options = { ...native, identityFiles: ['linux-candidate.json'],
    runtime: { ...native.runtime, identityDirectory: 'metadata/native-candidate' } };
  const packageOne = async name => packagePortableBundle({ destination: join(root, name),
    originSourceCommit: verified.manifest.originSourceCommit, lineage: verified.lineage,
    sourceInventory: verified.sourceInventory, sourceDirectory: source,
    components: components.map(component => component.id === 'native' ? options : component) });
  await writeFile(join(native.directory, 'linux-candidate.json'), '{"source":"first"}');
  const first = await packageOne('first');
  await writeFile(join(native.directory, 'linux-candidate.json'), '{"source":"second"}');
  const second = await packageOne('second');
  assert.equal(first.components.get('native').artifact.codeDigest, second.components.get('native').artifact.codeDigest);
  assert.notEqual(first.manifestSha256, second.manifestSha256);
  assert.ok(first.manifest.files.some(file => file.path === 'metadata/native-candidate/linux-candidate.json'));
  assert.ok(first.components.get('native').artifact.files.every(file => !file.path.endsWith('linux-candidate.json')));
  await symlink(first.root, join(root, 'import-link'));
  await assert.rejects(verifyPortableBundle(join(root, 'import-link'), first.expected), /root symlink/);
});

test('separates a retained component build origin from the current intent closure and source reference', async t => {
  const { verified, root, source, components } = await fixture(t);
  const currentCommit = '2'.repeat(40), changed = Buffer.from('export const changed = true;');
  const intentFiles = verified.sourceInventory.files.map(file => file.path === 'a-other.js' ? { ...file, sha256: sha256(changed) } : file);
  const retained = await packagePortableBundle({ destination: join(root, 'mixed-origin'), originSourceCommit: currentCommit,
    lineage: { kind: 'local-source-build', sourceCommit: currentCommit, dirtySnapshot: true },
    sources: [{ originSourceCommit: verified.manifest.originSourceCommit, inventory: verified.sourceInventory, directory: source },
      { originSourceCommit: currentCommit, inventory: { files: intentFiles },
        readSource: path => path === 'a-other.js' ? Promise.resolve(changed) : readFile(join(source, path)) }],
    components: components.map(component => ({ ...component, originSourceCommit: component.id === 'native' ? component.originSourceCommit : currentCommit })) });
  const native = retained.components.get('native').component;
  assert.equal(native.originSourceCommit, verified.manifest.originSourceCommit);
  assert.notEqual(native.inputsDigest, native.intentInputsDigest);
  assert.notEqual(native.proofInputsDigest, native.intentProofInputsDigest);
  assert.notEqual(native.inputsRef.path, native.intentInputsRef.path);
  assert.equal(native.intentInputsRef.path, retained.sourceInventory.inputsRef.path);
  assert.equal(native.codeDigest, verified.components.get('native').artifact.codeDigest);
});


test('drains follow-up native tasks and queue messages while preserving retries and failures', async () => {
  const print = ['first'], video = [], videoTasks = [];
  const done = await drainJourneyWork({ queues: [['print', print], ['video', video]], videoTasks,
    deliver: async (_name, batch) => {
      if (batch.includes('first')) videoTasks.push(Promise.resolve().then(() => video.push('later')));
      return { outcome: 'ok', retryBatch: { retry: false }, retryMessages: [] };
    } });
  assert.equal(done.messages, 2); assert.equal(done.videoTasks, 1);
  assert.equal(print.length + video.length, 0);
  for (const failure of ['retry', 'transport']) {
    const queue = ['preserve'];
    await assert.rejects(drainJourneyWork({ queues: [['print', queue]], videoTasks: [], deliver: async () => {
      if (failure === 'transport') throw new Error('synthetic transport failure');
      return { outcome: 'ok', retryMessages: ['retry'] };
    } }), /retry|transport/);
    assert.deepEqual(queue, ['preserve']);
  }
  const repeating = ['pending'];
  await assert.rejects(drainJourneyWork({ queues: [['print', repeating]], videoTasks: [], maxRounds: 2,
    deliver: async () => { repeating.push('pending'); return { outcome: 'ok' }; } }), /round bound/);
  assert.deepEqual(repeating, ['pending']);
});


test('synthetic fixture accepts explicit hosted lineage for independent authority tests', async t => {
  const lineage = { kind: 'github-actions', repository: 'bentbrain/bent-mono', sourceCommit: '3'.repeat(40),
    runId: '101', runAttempt: '1', workflowRef: 'bentbrain/bent-mono/.github/workflows/shop-linux-journey.yml@refs/heads/test-fixture', jobId: 'journey' };
  const { verified } = await fixture(t, { lineage });
  assert.deepEqual(verified.lineage, lineage);
  await verifyPortableBundle(verified.root, { ...verified.expected, requireHostedLineage: true });
});
