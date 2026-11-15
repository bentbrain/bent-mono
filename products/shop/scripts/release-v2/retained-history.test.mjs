import assert from 'node:assert/strict';
import test from 'node:test';
import { sign } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, digest, parseJSON, sha256 } from './data.mjs';
import { assertHostedNativeQualificationReceipt, importHostedNativeQualificationReceipt, assertHostedReleaseHistory, importHostedReleaseHistory, packageHostedReleaseHistory } from './retained-history.mjs';
import { createBootstrapFixture } from './testing/bootstrap-fixture.mjs';
import { createCompletedHistoryArtifactFixture, createHistoryIntakeFixture, createNativeQualificationArtifactFixture } from './testing/history-intake-fixture.mjs';

const root = process.env.SHOP_ARTIFACT_INTAKE_TEST_ROOT ?? tmpdir();
if (process.platform === 'darwin') assert.ok(root.startsWith('/Volumes/MacMiniDevelopment/'), 'Historical test artifacts require the private SSD');
let sequence = 0;
const fixtureFor = t => createHistoryIntakeFixture(t, { root });
const run = (fixture, options = {}) => importHostedReleaseHistory({ ...fixture, destination: join(fixture.root, `history-import-${sequence++}`), ...options });
const doc = (fixture, suffix) => fixture.documents[`/repos/bentbrain/bent-mono${suffix ? `/${suffix}` : ''}`];
const cloneEntries = entries => entries.map(entry => ({ ...entry, ...(entry.data ? { data: Buffer.from(entry.data) } : {}) }));
function inventory(entries) {
  const target = entries.find(entry => entry.path === 'shop-composition-private/workflow-inventory.private.json'), document = JSON.parse(target.data);
  document.inventory = entries.filter(entry => entry.type !== '5' && entry !== target).map(entry => ({ path: entry.path.slice('shop-composition-private/'.length), bytes: entry.data.length, sha256: sha256(entry.data), executable: entry.mode === 0o700 })).sort((a, b) => a.path < b.path ? -1 : 1);
  target.data = Buffer.from(JSON.stringify(document));
}

test('fresh runner authenticates original encrypted workflow and reconstructs exact historical bytes without old directories', async t => {
  const fixture = await fixtureFor(t), originalHash = sha256(fixture.archive);
  await rm(fixture.originalOptions.bundle, { recursive: true }); await rm(fixture.verified.root, { recursive: true }); await rm(fixture.original, { recursive: true });
  const result = await run(fixture), locator = parseJSON(await readFile(join(result.rollbackDirectory, 'verified-release.private.json')));
  assert.equal(result.remoteVerificationRequired, true); assert.equal(result.evidence.transport, 'explicit-artifact-api');
  assert.equal(locator.eventDigest, fixture.descriptor.eventDigest); assert.equal(locator.compositionDigest, fixture.descriptor.compositionDigest);
  assert.notEqual(locator.options.bundle, fixture.originalOptions.bundle); assert.equal(Object.hasOwn(locator.options, 'fence'), false); assert.equal(Object.hasOwn(locator.options, 'trustRoot'), false);
  assert.deepEqual(await readFile(locator.options.authority), fixture.authorityBytes); assert.deepEqual(await readFile(locator.options.manifest), fixture.envelopeBytes);
  const originalAuthority = parseJSON(fixture.authorityBytes), runner = originalAuthority.payload.policy.runner.script;
  const restoredRunner = await readFile(join(locator.options.bundle, runner.path));
  assert.equal(sha256(restoredRunner), runner.sha256); assert.equal(restoredRunner.length, runner.bytes);
  assert.equal(result.history.files.some(file => /\.pem$|signing-key|credentials/.test(file.path)), false);
  assert.equal(sha256(fixture.archive), originalHash); assert.equal((await assertHostedReleaseHistory(result)).rollbackDirectory, result.rollbackDirectory);
  await assert.rejects(assertHostedReleaseHistory({ ...result }), /in-process/);
  const manifest = parseJSON(await readFile(locator.options.manifest)); manifest.payload.intentSourceCommit = '2'.repeat(40);
  await writeFile(locator.options.manifest, JSON.stringify(manifest)); await assert.rejects(assertHostedReleaseHistory(result), /Referenced bytes differ/);
});

test('original workflow repository, owner, source, attempt, job and success authenticate before artifact download', async t => {
  const fixture = await fixtureFor(t), baseline = structuredClone(fixture.documents);
  for (const mutate of [
    () => { doc(fixture, '').owner.id++; }, () => { doc(fixture, 'actions/runs/123').head_sha = '2'.repeat(40); },
    () => { doc(fixture, 'actions/runs/123').run_attempt = 2; }, () => { doc(fixture, 'actions/runs/123').conclusion = 'failure'; },
    () => { doc(fixture, 'actions/runs/123').head_branch = 'other'; }, () => { doc(fixture, 'actions/runs/123').event = 'pull_request'; },
    () => { doc(fixture, 'actions/runs/123/attempts/1/jobs?per_page=100').jobs[0].name = 'Other job'; },
    () => { doc(fixture, 'actions/artifacts/789').name = 'shop-linux-private-123-1'; }, () => { doc(fixture, 'actions/artifacts/789').expired = true; },
  ]) {
    for (const key of Object.keys(baseline)) fixture.documents[key] = structuredClone(baseline[key]); mutate(); let downloads = 0;
    await assert.rejects(run(fixture, { api: { ...fixture.api, async downloadArtifact() { downloads++; throw Error('must not download'); } } })); assert.equal(downloads, 0);
  }
  await assert.rejects(run(fixture, { installation: { ...fixture.installation, workflow: { ...fixture.installation.workflow, path: '.github/workflows/unknown.yml' } } }), /supported Linux producer/);
});

test('ZIP framing, ciphertext, missing inventories and substituted historical source cannot create a rollback locator', async t => {
  const fixture = await fixtureFor(t);
  fixture.setArchive(Buffer.concat([fixture.archive, Buffer.from('trailing')])); await assert.rejects(run(fixture), /ZIP/);
  await fixture.sealEntries(fixture.entries, { zipEntries: entries => entries.map(entry => entry.name.endsWith('.enc') ? { ...entry, data: Buffer.from(entry.data).fill(42, 100, 110) } : entry) });
  await assert.rejects(run(fixture));
  await fixture.sealEntries(fixture.entries, { zipEntries: entries => [...entries, { name: 'unexpected-key.pem', data: Buffer.from('never import') }] });
  await assert.rejects(run(fixture), /ZIP|sealed/);
  const missing = cloneEntries(fixture.entries).filter(entry => entry.path !== 'shop-composition-private/workflow-inventory.private.json');
  await fixture.sealEntries(missing); await assert.rejects(run(fixture), /ENOENT/);
  const changed = cloneEntries(fixture.entries), body = changed.find(entry => entry.path.endsWith('/history-package.private.json')), parsed = JSON.parse(body.data);
  parsed.identity.head = '2'.repeat(40); body.data = Buffer.from(JSON.stringify(parsed)); inventory(changed);
  await fixture.sealEntries(changed); await assert.rejects(run(fixture), /historical package identity/);
});

test('incomplete attempts cannot export history and complete inner inventory detects missing bytes', async t => {
  const fixture = await fixtureFor(t);
  await assert.rejects(packageHostedReleaseHistory({ verifiedReleaseFile: fixture.verifiedReleaseFile, result: { ...fixture.result, controller: { ...fixture.result.controller, phase: 'reporting-pending' } },
    identity: fixture.identity, destination: join(fixture.root, 'must-not-export') }), /Only a complete/);
  const entries = cloneEntries(fixture.entries), removed = entries.find(entry => entry.path.includes('/portable/payload/business/') && entry.type !== '5');
  entries.splice(entries.indexOf(removed), 1); inventory(entries); await fixture.sealEntries(entries);
  await assert.rejects(run(fixture), /complete inventory differs/);
});


test('native receipt import requires authenticated successful archive and exact real-provider signed receipt', async t => {
  const fixture = await fixtureFor(t), trust = await createBootstrapFixture(t, { root });
  const payload = { schema: 'shop.native-qualification-receipt/v1', scope: 'aws/provider', awsImageQualified: true, environmentId: trust.root.credentialBroker.environmentId,
    ...Object.fromEntries(['sourceDigest','imageDigest','recipeDigest','secretVersionsDigest','planDigest','requestGraphDigest','policyDigest','qualificationPolicyDigest','artifactDigest','codeDigest','runtimeDigest','authorityDigest','evidenceDigest','cleanupDigest'].map(key => [key, 'a'.repeat(64)])),
    operationId: 'synthetic-qualified', resources: [{name:'native-a',version:'7',bindingDigest:'b'.repeat(64)},{name:'native-b',version:'8',bindingDigest:'b'.repeat(64)}], issuedAt: Date.now() - 1000 };
  const envelope = value => ({payload: value, signature: {algorithm:'ECDSA_SHA_256',keyId:trust.sourceKey.entry.id,payloadDigest:digest(value),signature:sign('sha256', Buffer.from(canonical(value)), trust.sourceKey.privateKey).toString('base64')}});
  const seal = async (receipt = envelope(payload), readiness = {nativeQualificationComplete:true,executionScope:'aws/provider',awsImageQualified:true}) => {
    const entries = cloneEntries(fixture.entries).filter(entry => !entry.path.includes('/release-history/'));
    const result = entries.find(entry => entry.path.endsWith('/result.private.json')); result.data = Buffer.from(canonical({receipt,readiness})); inventory(entries); await fixture.sealEntries(entries);
  };
  await seal();
  const options = () => ({...fixture,root:trust.root,expected:{imageDigest:payload.imageDigest},destination:join(fixture.root, `qualification-import-${sequence++}`)});
  const result = await importHostedNativeQualificationReceipt(options()); assert.deepEqual(result.payload, payload);
  await assertHostedNativeQualificationReceipt(result,{root:trust.root});
  await assert.rejects(assertHostedNativeQualificationReceipt({...result},{root:trust.root}),/Authenticated native/);
  await assert.rejects(importHostedNativeQualificationReceipt({...options(),expected:{imageDigest:'c'.repeat(64)}}),/exact retained subject/);
  await assert.rejects(importHostedNativeQualificationReceipt({...options(),root:{...trust.root,revokedAuthorities:[digest(result.receipt)]}}),/revoked/);
  await seal(envelope({...payload,scope:'fixture/provider-loopback',awsImageQualified:false})); await assert.rejects(importHostedNativeQualificationReceipt(options()),/Real AWS/);
  await seal(envelope(payload), {nativeQualificationComplete:false,executionScope:'aws/provider',awsImageQualified:true}); await assert.rejects(importHostedNativeQualificationReceipt(options()),/Complete real-provider/);
  const corrupt=envelope(payload); corrupt.signature.signature=Buffer.alloc(70).toString('base64'); await seal(corrupt); await assert.rejects(importHostedNativeQualificationReceipt(options()),/signature differs/);
});


test('history packaging rejects unrecognized protected fields before copying', async t => {
  const fixture = await fixtureFor(t);
  const descriptor = {...fixture.descriptor,options:{...fixture.descriptor.options,sourceSigningKey:'synthetic-secret'}};
  await writeFile(fixture.verifiedReleaseFile,canonical(descriptor));
  await assert.rejects(packageHostedReleaseHistory({verifiedReleaseFile:fixture.verifiedReleaseFile,result:fixture.result,identity:fixture.identity,destination:join(fixture.root,'must-not-copy-key')}),/unsupported protected fields/);
});


test('completed release transport helpers preserve earlier original archive and use isolated fresh paths', async t => {
  const fixture = await fixtureFor(t), initial = Buffer.from(fixture.archive);
  const completed = await createCompletedHistoryArtifactFixture(t,{verifiedReleaseFile:fixture.verifiedReleaseFile,result:fixture.result,identity:fixture.identity,portableFixture:fixture,recipientPrivateKeyFile:fixture.privateKeyFile,workflowId:333,originalDirectory:join(fixture.root,'completed-helper')});
  assert.notEqual(completed.root,fixture.root); assert.deepEqual(fixture.archive,initial);
  const imported=await importHostedReleaseHistory({...completed,destination:join(fixture.root,'completed-helper-import')}); await assertHostedReleaseHistory(imported);
  const native=await createNativeQualificationArtifactFixture(t,{result:{receipt:{synthetic:true}},identity:fixture.identity,portableFixture:fixture,recipientPrivateKeyFile:fixture.privateKeyFile,workflowId:333,originalDirectory:join(fixture.root,'native-helper')});
  assert.notEqual(native.root,completed.root); assert.deepEqual(fixture.archive,initial);
});
