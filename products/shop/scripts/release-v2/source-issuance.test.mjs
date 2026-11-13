import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { digest, parseJSON, sha256 } from './data.mjs';
import { assembleHostedRelease, issueHostedAuthority, qualifyHostedSource } from './source-issuance.mjs';
import { hostedController } from './hosted-controller.mjs';
import { verifyHostedAuthority } from './hosted-admission.mjs';
import { createBootstrapFixture } from './testing/bootstrap-fixture.mjs';

const fixture = (t, overrides = {}) => createBootstrapFixture(t, { root: process.env.SHOP_BOOTSTRAP_TEST_ROOT ?? process.env.TMPDIR, ...overrides });
const absent = async path => assert.rejects(access(path), { code: 'ENOENT' });

test('real importer, guard, installed signers and default controller share one source-bound plan route', async t => {
  const f = await fixture(t), result = await assembleHostedRelease(f);
  const authority = verifyHostedAuthority(result.authority, { root: f.root, identity: f.identity });
  assert.equal(authority.payload.acceptedAt, f.acceptedAt);
  assert.equal(authority.payload.tree, f.quality.tree); assert.equal(authority.payload.base, f.quality.base);
  assert.equal(authority.payload.quality.releaseGuardDigest, digest(result.evidence));
  assert.equal(authority.payload.quality.runId, 111);
  assert(f.quality.calls.some(path => path.includes('/check-runs?')));
  assert(f.quality.calls.some(path => path.includes('/statuses?')));
  assert(f.quality.calls.some(path => path.includes('/attempts/1/jobs?')));
  assert.equal(result.evidence.guardImplementationSha256, sha256(await readFile(new URL('../../../../scripts/require-release-checks.mjs', import.meta.url))));
  assert(result.authority.payload.portableManifests.every(item => item.awsImageQualified === false));
  const plan = await hostedController({ ...result.options, env: f.env, command: 'plan' });
  assert.equal(plan.phase, 'plan-admitted'); assert.equal(plan.readiness.awsImageQualified, false); assert.equal(plan.operationalApproval, false); assert.equal(plan.providerWrites, 0);
  let brokerCalls = 0;
  await assert.rejects(hostedController({ ...result.options, env: f.env, command: 'advance' }, { broker: async () => { brokerCalls++; throw Error('unexpected provider credential call'); } }), /target|format|qualification|resource/i);
  assert.equal(brokerCalls, 0);
  const file = parseJSON(await readFile(result.options.authority)); assert.equal(digest(file), digest(result.authority));
});

test('copied import descriptors and copied guard results cannot issue authority', async t => {
  const f = await fixture(t);
  await assert.rejects(assembleHostedRelease({ ...f, imported: { ...f.imported } }), /Authenticated in-process/);
  await absent(f.destination);
  const source = await qualifyHostedSource(f);
  await assert.rejects(issueHostedAuthority({ ...f, composition: { bundle: f.destination, manifest: 'missing.json' }, sourceAdmission: structuredClone(source) }), /Actual exact-source/);
  source.acceptedAt += 1;
  await assert.rejects(issueHostedAuthority({ ...f, composition: { bundle: f.destination, manifest: 'missing.json' }, sourceAdmission: source }), /Actual exact-source/);
});

test('canonical native security and genuine independent PR review must pass the existing guard', async t => {
  const f = await fixture(t);
  const path = [...f.quality.documents.keys()].find(path => path.includes('/check-runs?'));
  f.quality.documents.get(path).check_runs[0].conclusion = 'failure';
  await assert.rejects(assembleHostedRelease(f), /Native CodeQL security analysis/);
  await absent(f.destination);
});

test('latest required quality job failures stop before composition signing or output creation', async t => {
  const f = await fixture(t);
  const path = [...f.quality.documents.keys()].find(path => path.includes('/attempts/1/jobs?'));
  f.quality.documents.get(path).jobs.find(job => job.name === 'Release qualification').conclusion = 'failure';
  await assert.rejects(assembleHostedRelease(f), /Required Quality job.*Release qualification/);
  await absent(f.destination);
});

test('canonical main moving during actual guard inspection rejects the source', async t => {
  const f = await fixture(t); let mainReads = 0;
  const qualityApi = async path => path.endsWith('/git/ref/heads/main') && ++mainReads > 1 ? { object: { sha: '2'.repeat(40) } } : f.qualityApi(path);
  await assert.rejects(assembleHostedRelease({ ...f, qualityApi }), /changed during inspection/);
  await absent(f.destination);
});

test('wrong source workflow attempt fails before quality or signing', async t => {
  const f = await fixture(t); f.quality.invocation.run_attempt = 2;
  await assert.rejects(assembleHostedRelease(f), /current source invocation differs/);
  await absent(f.destination);
});

test('older qualified source preserves its accepted time and reports budget overrun with a fresh bounded authority', async t => {
  const acceptedAt = Date.now() - 700000, f = await fixture(t, { acceptedAt });
  const result = await assembleHostedRelease(f), timing = result.readiness.timing;
  assert.equal(result.authority.payload.acceptedAt, acceptedAt);
  assert.equal(timing.acceptedAt, acceptedAt); assert.equal(timing.budgetMs, 600000); assert(timing.elapsedMs >= 700000);
  assert.equal(timing.observedAt - acceptedAt, timing.elapsedMs); assert.equal(timing.exceeded, true); assert.equal(timing.productionDeliveryMeasured, false);
  assert.equal(result.authority.payload.expiresAt - result.authority.payload.issuedAt, f.root.maximumLifetimeMs);
  const verified = verifyHostedAuthority(result.authority, { root: f.root, identity: f.identity }); assert.equal(verified.payload.acceptedAt, acceptedAt);
  assert.equal((await hostedController({ ...result.options, env: f.env, command: 'plan' })).operationalApproval, false);
});

test('caller cannot reset the accepted source clock after qualification', async t => {
  const f = await fixture(t);
  await assert.rejects(assembleHostedRelease({ ...f, acceptedAt: Date.now() }), /differs from canonical merged pull request/);
  await absent(f.destination);
});

test('execution assembly checks every retained target before broker identity or proof signing', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(assembleHostedRelease({ ...f, command: 'begin', boundaries: { broker: async () => { calls++; throw Error('unexpected custody call'); } } }), /target|format|qualification|resource/i);
  assert.equal(calls, 0);
  await absent(`${f.destination}/release-proofs`);
  await absent(`${f.destination}/release-authority.json`);
});

test('source admission mutation during final asynchronous reads cannot reach the source signer', async t => {
  const f = await fixture(t), assembled = await assembleHostedRelease(f);
  let source, armed = false;
  const qualityApi = async path => {
    if (armed && path.endsWith('/git/ref/heads/main')) source.quality.qualityRunId = 999;
    return f.qualityApi(path);
  };
  source = await qualifyHostedSource({ ...f, qualityApi }); armed = true;
  await assert.rejects(issueHostedAuthority({ ...f, composition: { bundle: assembled.options.bundle, manifest: assembled.options.manifest }, sourceAdmission: source }), /Actual exact-source/);
});

test('both installed signing key identities are checked before custody or target access', async t => {
  for (const kind of ['source', 'composition']) await t.test(kind, async t => {
    const f = await fixture(t); let custodyCalls = 0;
    const changed = kind === 'source' ? f.installation.sourceKeyPath : f.installation.compositionKeyPath;
    const replacement = kind === 'source' ? f.installation.compositionKeyPath : f.installation.sourceKeyPath;
    await writeFile(changed, await readFile(replacement), { mode: 0o600 });
    await assert.rejects(assembleHostedRelease({ ...f, command: 'begin', boundaries: { broker: async () => { custodyCalls++; throw Error('unexpected custody access'); } } }), /SPKI differs/);
    assert.equal(custodyCalls, 0); await absent(`${f.destination}/release-proofs`);
  });
});
