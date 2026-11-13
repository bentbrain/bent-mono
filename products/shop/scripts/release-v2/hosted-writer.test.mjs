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
