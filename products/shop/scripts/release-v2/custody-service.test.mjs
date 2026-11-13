import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseJSON } from './data.mjs';
import { requestBuilders } from './provider-protocol-builders.mjs';
import { requestDigest } from './signing.mjs';
import { responseBytes } from './provider-protocol.mjs';
import { createHostedWriter } from './hosted-writer.mjs';
import { createCredentialCustody } from './custody-service.mjs';
import { hostedProtocolFixture } from './testing/hosted-protocol-service.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';

async function fixture(work) {
  const f = protocolFixture(), service = await hostedProtocolFixture({ policy: f.policy, targets: [], assets: f.assets });
  try { await work(f, service); } finally { await service.close(); }
}

test('production custody requires an independent journal, authenticated principal and explicit installation replacement', async () => {
  await fixture(async (f, service) => {
    await assert.rejects(createCredentialCustody({ ...service.factoryOptions, custodyPolicy: f.policy }), /Independently pinned/);
    await assert.rejects(createCredentialCustody({ ...service.factoryOptions, authenticate: null }), /identity/);
    await assert.rejects(createCredentialCustody(service.factoryOptions), /Existing credential installation remains held/);
    const input = { schema: 'shop.credential-broker-call/v1', action: 'open', nonce: randomUUID(), fenceDigest: service.fenceAdmission.digest, environmentId: 'synthetic-qualification', owner: null, request: null, intent: null };
    await assert.rejects(service.executor.handle(input, {}), /authenticated controller/);
    const installation = service.signRoot({ ...service.installation.payload, installationId: randomUUID(), credentialEpoch: 'epoch-two' });
    const proof = { schema: 'shop.custody-installation-replacement/v1', fenceDigest: service.fenceAdmission.digest, previousInstallationId: service.installation.payload.installationId, previousCredentialEpoch: service.installation.payload.credentialEpoch, newInstallationId: installation.payload.installationId, credentialsRevoked: true, stopped: true, drained: true, issuedAt: Date.now(), expiresAt: Date.now() + 60000 };
    for (const field of ['credentialsRevoked', 'stopped', 'drained']) await assert.rejects(createCredentialCustody({ ...service.factoryOptions, installation, replacement: service.signRoot({ ...proof, [field]: false }) }), /Stopped, drained and revoked/);
    await createCredentialCustody({ ...service.factoryOptions, installation, replacement: service.signRoot(proof) });
    await assert.rejects(service.broker.open(), /installation changed/);
    assert.equal(service.transcript.filter(item => item.method === 'POST').length, 0);
  });
});

test('asset upload capabilities stay in production custody and each exact wire request is durably claimed', async () => {
  await fixture(async (f, service) => {
    const builders = requestBuilders(f.policy), writer = createHostedWriter({ policy: f.policy, broker: service.broker, fenceAdmission: service.fenceAdmission });
    await writer.withWriter(async ({ commit }) => {
      await commit({ phase: 'stage-reconcile', operation: { id: 'synthetic-stage' } });
      const dispatch = async request => {
        const event = await writer.recordProvider(state => state.requests.push({ requestDigest: requestDigest(request), operationId: 'synthetic-stage', method: request.method, url: request.url, bodySha256: request.bodySha256, status: 'intent', target: { resource: f.worker } }));
        return parseJSON(responseBytes(await writer.dispatch(request, event))).result;
      };
      const session = await dispatch(builders.assetSession(f.worker, f.assets)); assert.match(session.jwt, /^custody\./);
      const completed = await dispatch(builders.assetUpload(f.assets, session.buckets[0], session.jwt)); assert.match(completed.jwt, /^custody\./);
      const upload = builders.workerUpload(f.worker, { entrypoint: 'index.js', metadata: { ...f.metadata, assets: { ...f.metadata.assets, jwt: completed.jwt } }, modules: f.modules, expectedInventory: f.expectedInventory });
      const saved = await dispatch(upload); assert.match(saved.id, /^[a-f0-9-]{36}$/);
      const mainJournal = [...service.objects.values()].map(item => item.bytes.toString()).join('');
      assert(!mainJournal.includes('private.upload.capability')); assert(!mainJournal.includes('private.completion.capability'));
      const custody = await service.executor.readState(); assert.equal(custody.tokens.length, 2); assert(custody.tokens.every(item => !Object.hasOwn(item, 'value')));
      const claim = custody.requests.find(item => item.requestDigest === requestDigest(upload)); assert(claim); assert.notEqual(claim.wireRequestDigest, claim.requestDigest); assert.equal(claim.status, 'acknowledged');
      assert.equal(service.transcript.filter(item => item.method === 'POST' && item.url.endsWith('/versions')).length, 1);
    });
  });
});
