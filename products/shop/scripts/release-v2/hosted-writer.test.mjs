import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { canonical, digest, sha256 } from './data.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { admitCredentialFence, credentialBrokerBoundary, createHostedWriter } from './hosted-writer.mjs';

function signedFence(patch = {}) {
  const { policy } = protocolFixture(), keys = generateKeyPairSync('ed25519'), id = 'protected-custody-test', now = Date.now();
  const payload = { schema: 'shop.credential-fence/v1', scope: 'protected-provider-writer', environmentId: 'synthetic-qualification', policyDigest: digest(policy), brokerId: 'synthetic-custody', implementationDigest: sha256('synthetic-reviewed-custody'), credentialCustody: 'broker-exclusive', ownership: 'non-expiring-single-writer', sendBoundary: 'atomic-owner-check-and-dispatch', reassignment: 'stop-drain-revoke-before-reassign', issuedAt: now, expiresAt: now + 60000, ...patch };
  const envelope = value => ({ keyId: id, payload: value, signature: sign(null, Buffer.from(canonical(value)), keys.privateKey).toString('base64') });
  const receipt = envelope(payload), options = { keys: [{ id, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }], policy, environmentId: 'synthetic-qualification', brokerId: 'synthetic-custody', implementationDigest: sha256('synthetic-reviewed-custody') };
  return { policy, payload, receipt, options, envelope };
}

test('fence admission rejects local custody, expiring takeover, wrong installation, expired and forged authority', () => {
  const fixture = signedFence(); assert(admitCredentialFence(fixture.receipt, fixture.options));
  for (const patch of [{ scope: 'inactive-loopback' }, { credentialCustody: 'controller-environment' }, { ownership: 'expiring-lease' }, { reassignment: 'lease-expiry-takeover' }, { sendBoundary: 'check-then-return-credentials' }, { policyDigest: 'f'.repeat(64) }, { implementationDigest: 'a'.repeat(64) }, { expiresAt: Date.now() - 1 }]) { const changed = signedFence(patch); assert.throws(() => admitCredentialFence(changed.receipt, changed.options), /custody fence/); }
  assert.throws(() => admitCredentialFence({ ...fixture.receipt, signature: Buffer.alloc(64).toString('base64') }, fixture.options), /signature/);
  assert.throws(() => createHostedWriter({ policy: fixture.policy, broker: {}, fenceAdmission: {} }), /custody broker/);
});

test('broker requires exact signed challenge, request-call digest and installation for every boundary crossing', async () => {
  for (const field of ['nonce', 'callDigest', 'fenceDigest', 'action']) {
    const fixture = signedFence(), admission = admitCredentialFence(fixture.receipt, fixture.options);
    const broker = credentialBrokerBoundary({ fenceAdmission: admission, boundary: async input => fixture.envelope({ schema: 'shop.credential-broker-result/v1', action: input.action, nonce: input.nonce, callDigest: digest(input), fenceDigest: admission.digest, owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', issuedAt: Date.now(), result: { exclusive: true, outstanding: 0 }, [field]: 'wrong' }) });
    await assert.rejects(broker.open(), /response identity/);
  }
});

test('signed work inventory requires completeness, freshness and exact accepted artifact identities', async () => {
  const variants = [{ complete: false }, { observedAt: Date.now() - 60000 }, { jobs: [{ component: 'native', artifactDigest: 'bad', format: 'job-v5' }] }, { environmentId: 'other-environment' }];
  for (const patch of variants) {
    const fixture = signedFence(), admission = admitCredentialFence(fixture.receipt, fixture.options);
    const broker = credentialBrokerBoundary({ fenceAdmission: admission, boundary: async input => fixture.envelope({ schema: 'shop.credential-broker-result/v1', action: input.action, nonce: input.nonce, callDigest: digest(input), fenceDigest: admission.digest, owner: null, issuedAt: Date.now(), result: { schema: 'shop.accepted-work-observation/v1', complete: true, environmentId: 'synthetic-qualification', queryDigest: sha256('synthetic read-only query'), observedAt: Date.now(), jobs: [], ...patch } }) });
    await assert.rejects(broker.workInventory(), /work observation|work identity/);
  }
});

async function writerFixture(beforeMutation) {
  const f = signedFence(), admission = admitCredentialFence(f.receipt, f.options), actions = [], objects = new Map();
  let owner = null, version = 0, reads = 0;
  const boundary = async input => {
    actions.push(input.action); let result;
    if (input.action === 'open') { assert.equal(owner, null); owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; result = { exclusive: true, outstanding: 0 }; }
    else { assert.equal(input.owner, owner); assert(owner); result = input.action === 'close' ? { closed: true, outstanding: 0 } : { current: true }; }
    const responseOwner = owner; if (input.action === 'close') owner = null;
    return f.envelope({ schema: 'shop.credential-broker-result/v1', action: input.action, nonce: input.nonce, fenceDigest: admission.digest,
      owner: responseOwner, issuedAt: Date.now(), callDigest: digest(input), result });
  };
  const store = { get: async key => { reads++; const found = objects.get(key); return found ? { ...found, bytes: Buffer.from(found.bytes) } : null; },
    put: async (key, bytes, expected) => {
      assert.equal(objects.get(key)?.etag ?? null, expected); version++;
      const found = { bytes: Buffer.from(bytes), etag: `"${version}"`, versionId: String(version), provenance: { kind: 'authenticated-provider' } };
      objects.set(key, found); return { ...found, bytes: Buffer.from(bytes) };
    } };
  const broker = credentialBrokerBoundary({ fenceAdmission: admission, boundary });
  return { writer: createHostedWriter({ policy: f.policy, store, broker, fenceAdmission: admission, beforeMutation }), store, objects, actions, reads: () => reads, owner: () => owner };
}

test('one release session retains exclusive ownership and immutable history while remote heads stay fresh', async () => {
  const f = await writerFixture();
  await f.writer.withSession(async () => {
    await f.writer.withWriter(async ({ initial, commit }) => { assert.equal(initial, null); await commit({ phase: 'prepared', value: 1 }); });
    const before = f.reads();
    assert.equal((await f.writer.readVerifiedHistory()).state.value, 1);
    await f.writer.readProviderState(); assert.equal(f.reads(), before, 'Immutable history reread through provider lookup');
    await f.writer.readHead(); assert.equal(f.reads(), before + 1, 'Current head was not remotely fetched');
    await f.writer.withWriter(async ({ initial, commit }) => { assert.equal(initial.generation, 1); initial.value = 2; await commit(initial); });
    assert.equal((await f.writer.readHead()).state.generation, 2);
  });
  assert.deepEqual(f.actions, ['open', 'close']); assert.equal(f.owner(), null);
  await f.writer.withWriter(async ({ initial }) => assert.equal(initial.value, 2));
  assert.deepEqual(f.actions, ['open', 'close', 'open', 'close']);
});

test('an externally advanced journal cannot be adopted by an active transaction and failure keeps the owner held', async () => {
  const f = await writerFixture();
  await assert.rejects(f.writer.withSession(async () => {
    await f.writer.withWriter(async ({ commit }) => commit({ phase: 'prepared' }));
    const head = f.objects.get('head.json'); head.etag = '"external-owner"';
    await f.writer.withWriter(async ({ initial, commit }) => commit(initial));
  }), /CAS observation changed/);
  assert.deepEqual(f.actions, ['open']); assert(f.owner());
});


test('a fresh mutation admission failure stops before journal writes and retains the exclusive owner', async () => {
  let admissions = 0;
  const f = await writerFixture(async () => { admissions++; throw Error('signed operation expired'); });
  await assert.rejects(f.writer.withSession(() => f.writer.withWriter(({ commit }) => commit({ phase: 'prepared' }))), /operation expired/);
  assert.equal(admissions, 1); assert.equal(f.objects.size, 0); assert.deepEqual(f.actions, ['open']); assert(f.owner());
});

test('native fixture grants cross an exact signed scope and expose only an opaque handle', async () => {
  const f = signedFence(), admission = admitCredentialFence(f.receipt, f.options), calls = [], owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let result = `custody_${owner}.grant`;
  const broker = credentialBrokerBoundary({ fenceAdmission: admission, boundary: async input => {
    calls.push(input);
    return f.envelope({ schema: 'shop.credential-broker-result/v1', action: input.action, nonce: input.nonce, fenceDigest: admission.digest,
      owner, issuedAt: Date.now(), callDigest: digest(input), result });
  } });
  const intent = { journalNamespace: `native-qualification/${'a'.repeat(64)}`, eventDigest: 'b'.repeat(64), probeId: 'probe-v5' };
  assert.equal(await broker.nativeFixtureGrant(owner, intent), result);
  assert.equal(calls[0].action, 'native-fixture-grant'); assert.equal(calls[0].request, null); assert.deepEqual(calls[0].intent, intent);
  for (const changed of [{ ...intent, probeId: '../escape' }, { ...intent, eventDigest: 'bad' }, { ...intent, journalNamespace: null }]) await assert.rejects(broker.nativeFixtureGrant(owner, changed), /fixture intent/);
  assert.equal(calls.length, 1);
  result = 'secret.signature'; await assert.rejects(broker.nativeFixtureGrant(owner, intent), /Opaque custody/);
});
