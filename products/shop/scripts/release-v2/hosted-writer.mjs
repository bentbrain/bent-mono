import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { canonical, check, digest, same } from './data.mjs';
import { exactFields, assertPolicy, requestBuilders } from './provider-protocol-builders.mjs';
import { appendProtectedJournal, readProtectedJournal, protectedStore } from './protected-store.mjs';
import { ProtocolConflict, ProtocolFailure, responseBytes } from './provider-protocol.mjs';
import { requestDigest } from './signing.mjs';

const fences = new WeakSet(), brokerBoundaries = new WeakSet();
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function rootKeys(keys) {
  check(Array.isArray(keys) && keys.length > 0 && keys.length <= 8 && new Set(keys.map(key => key.id)).size === keys.length, 'Protected credential custody trust roots required');
  return keys.map(key => {
    exactFields(key, ['id', 'publicKeyPem']);
    check(typeof key.id === 'string' && /^[a-z0-9-]{1,64}$/.test(key.id) && typeof key.publicKeyPem === 'string' && key.publicKeyPem.length <= 4096 && /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\n?$/.test(key.publicKeyPem), 'Public custody attestation key required');
    const publicKey = createPublicKey(key.publicKeyPem); check(publicKey.asymmetricKeyType === 'ed25519', 'Ed25519 custody attestation key required'); return { id: key.id, publicKey };
  });
}
function verifyEnvelope(envelope, keys) {
  exactFields(envelope, ['keyId', 'payload', 'signature']); const key = keys.find(item => item.id === envelope.keyId);
  check(key && typeof envelope.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature) && verify(null, Buffer.from(canonical(envelope.payload)), key.publicKey, Buffer.from(envelope.signature, 'base64')), 'Credential custody attestation signature differs');
  return envelope.payload;
}
export function admitCredentialFence(receipt, { keys, policy, environmentId, brokerId, implementationDigest, now = Date.now() }) {
  assertPolicy(policy); const trustedKeys = rootKeys(keys), payload = verifyEnvelope(receipt, trustedKeys);
  exactFields(payload, ['schema', 'scope', 'environmentId', 'policyDigest', 'brokerId', 'implementationDigest', 'credentialCustody', 'ownership', 'sendBoundary', 'reassignment', 'issuedAt', 'expiresAt']);
  check(payload.schema === 'shop.credential-fence/v1' && payload.scope === 'protected-provider-writer' && payload.environmentId === environmentId &&
    payload.policyDigest === digest(policy) && payload.brokerId === brokerId && payload.implementationDigest === implementationDigest && hash(implementationDigest) &&
    payload.credentialCustody === 'broker-exclusive' && payload.ownership === 'non-expiring-single-writer' && payload.sendBoundary === 'atomic-owner-check-and-dispatch' &&
    payload.reassignment === 'stop-drain-revoke-before-reassign' && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt) && payload.issuedAt <= now && payload.expiresAt > now && payload.expiresAt - payload.issuedAt <= 3600000, 'Admitted exclusive credential custody fence required');
  const admission = Object.freeze({ payload: Object.freeze(structuredClone(payload)), digest: digest(receipt), keys: trustedKeys }); fences.add(admission); return admission;
}

// boundary is the authenticated custody service's network adapter. Its reviewed
// implementation owns credentials, atomic ownership checks and request dispatch.
// Signed challenge responses bind this client to that exact installation. A
// local lock, expiring lease or CI concurrency flag cannot create this capability.
export function credentialBrokerBoundary({ fenceAdmission, boundary, now = Date.now }) {
  check(fences.has(fenceAdmission) && typeof boundary === 'function', 'Admitted custody service network boundary required');
  const call = async (action, owner, request = null, intent = null) => {
    check(fenceAdmission.payload.expiresAt > now(), 'Credential custody admission expired');
    const nonce = randomUUID(), sentAt = now();
    const input = { schema: 'shop.credential-broker-call/v1', action, nonce, fenceDigest: fenceAdmission.digest, environmentId: fenceAdmission.payload.environmentId, owner, request, intent };
    const result = await boundary(input), payload = verifyEnvelope(result, fenceAdmission.keys);
    exactFields(payload, ['schema', 'action', 'nonce', 'fenceDigest', 'owner', 'issuedAt', 'callDigest', 'result']);
    check(payload.schema === 'shop.credential-broker-result/v1' && payload.action === action && payload.nonce === nonce && payload.callDigest === digest(input) && payload.fenceDigest === fenceAdmission.digest &&
      (action === 'open' ? typeof payload.owner === 'string' && /^[a-f0-9-]{36}$/.test(payload.owner) : payload.owner === owner) && Number.isSafeInteger(payload.issuedAt) && payload.issuedAt >= sentAt - 1000 && payload.issuedAt <= now(), 'Credential broker response identity differs');
    if (action === 'open') check(payload.result.exclusive === true && payload.result.outstanding === 0, 'Credential broker ownership is not exclusive and drained');
    return payload;
  };
  const broker = Object.freeze({ fenceAdmission,
    open: async () => (await call('open', null)).owner,
    assertOwner: async owner => { const result = (await call('assert', owner)).result; check(result.current === true, 'Credential broker rejected stale writer'); },
    close: async owner => { const result = (await call('close', owner)).result; check(result.closed === true && result.outstanding === 0, 'Credential broker cannot release outstanding dispatch'); },
    workInventory: async () => { const value = (await call('work-inventory', null)).result; exactFields(value, ['schema', 'complete', 'environmentId', 'queryDigest', 'observedAt', 'jobs']); check(value.schema === 'shop.accepted-work-observation/v1' && value.complete === true && value.environmentId === fenceAdmission.payload.environmentId && hash(value.queryDigest) && Number.isSafeInteger(value.observedAt) && value.observedAt <= now() && now() - value.observedAt <= 30000 && Array.isArray(value.jobs) && value.jobs.length <= 4096, 'Complete signed accepted-work observation required'); for (const job of value.jobs) { exactFields(job, ['component', 'artifactDigest', 'format']); check(hash(job.artifactDigest) && typeof job.component === 'string' && typeof job.format === 'string', 'Accepted work identity differs'); } return value; },
    read: async request => { check(request.method === 'GET', 'Custody read path permits GET only'); return (await call('read', null, request)).result; },
    journal: async (owner, request) => { check(request.service === 's3' && request.operation === 'store.put' && request.method === 'PUT', 'Custody journal path permits conditional S3 PUT only'); return (await call('journal', owner, request)).result; },
    dispatch: async (owner, request, intent) => {
      check(request.method !== 'GET' && intent && intent.requestDigest === requestDigest(request) && hash(intent.eventDigest), 'Durable exact request intent required at custody boundary');
      return (await call('dispatch', owner, request, intent)).result;
    }
  }); brokerBoundaries.add(broker); return broker;
}
export function assertCredentialFence(admission) { check(fences.has(admission), 'Verified protected credential fence required'); }
export function assertCredentialBroker(broker) { check(brokerBoundaries.has(broker), 'Verified exclusive credential custody broker required'); }

const emptyProvider = () => ({ versions: [], operations: [], requests: [], reports: [] });
export function createHostedWriter({ policy, store, broker, fenceAdmission, eventCacheDirectory }) {
  assertCredentialBroker(broker); check(fences.has(fenceAdmission) && broker.fenceAdmission === fenceAdmission, 'Matching protected writer custody admission required');
  let active = null;
  if (!store) { assertPolicy(policy); check(digest(policy) === fenceAdmission.payload.policyDigest, 'Writer policy differs'); store = protectedStore({ builders: requestBuilders(policy), send: async request => { const response = request.method === 'GET' ? await broker.read(request) : (await assertOwner(), await broker.journal(active.owner, request)); responseBytes(response); if ([409, 412].includes(response.status)) throw new ProtocolConflict(request.operation); if (response.status < 200 || response.status >= 300) throw new ProtocolFailure(request.operation, response.status); return response; } }, policy,
    { eventCacheDirectory, eventCacheNamespace: digest({ policyDigest: digest(policy), fenceDigest: fenceAdmission.digest }) }); }
  const readEnvelope = async () => {
    const current = await readProtectedJournal(store);
    if (current) {
      exactFields(current.state, ['schema', 'environmentId', 'policyDigest', 'controller', 'provider']);
      check(current.state.schema === 'shop.hosted-controller-journal/v1' && current.state.environmentId === fenceAdmission.payload.environmentId && current.state.policyDigest === fenceAdmission.payload.policyDigest, 'Protected journal environment authority differs');
      exactFields(current.state.provider, ['versions', 'operations', 'requests', 'reports']);
      for (const field of ['versions', 'operations', 'requests', 'reports']) check(Array.isArray(current.state.provider[field]) && current.state.provider[field].length <= 4096, 'Protected provider journal inventory exceeds bound');
    }
    return current;
  };
  const assertOwner = async () => { check(active && !active.failed, 'Active admitted hosted writer required'); await broker.assertOwner(active.owner); };
  const update = async mutate => {
    await assertOwner();
    const observed = await readEnvelope(); check(same(observed?.head ?? null, active.current?.head ?? null), 'Protected writer journal changed');
    const next = structuredClone(observed?.state ?? { schema: 'shop.hosted-controller-journal/v1', environmentId: fenceAdmission.payload.environmentId, policyDigest: fenceAdmission.payload.policyDigest, controller: null, provider: emptyProvider() });
    await mutate(next);
    try { active.current = await appendProtectedJournal(store, observed, next); return active.current; }
    catch (error) { active.failed = true; throw error; }
  };
  const readHead = async () => { const current = await readEnvelope(); return current?.state.controller ? { head: current.head, state: current.state.controller } : null; };
  const writer = {
    readHead, assertOwner,
    cacheMeasurements: async () => typeof store.cacheMeasurements === 'function' ? store.cacheMeasurements() : null,
    readProviderState: async () => structuredClone((await readEnvelope())?.state.provider ?? emptyProvider()),
    recordProvider: async mutate => { const current = await update(envelope => mutate(envelope.provider)); return current.head.eventDigest; },
    readVerification: async eventDigest => { check(hash(eventDigest), 'Exact immutable runtime verification identity required'); const current = await readEnvelope(); const found = current?.events.find(item => item.digest === eventDigest && item.event.state.controller?.phase === 'runtime-verified'); check(found?.event.state.controller.verification && found.event.state.controller.lastVerified, 'Immutable verified runtime event is unavailable'); return structuredClone(found.event.state.controller); },
    verificationRef: async () => {
      const current = await readEnvelope();
      const found = current?.events.findLast(item => item.event.state.controller?.phase === 'runtime-verified');
      check(found && found.event.state.controller.verification && found.event.state.controller.lastVerified, 'Immutable runtime verification event required'); return found.digest;
    },
    dispatch: async (request, eventDigest) => { await assertOwner(); return broker.dispatch(active.owner, request, { requestDigest: requestDigest(request), eventDigest }); },
    withWriter: async work => {
      check(!active, 'Hosted writer invocation already active'); const owner = await broker.open();
      active = { owner, current: await readEnvelope(), failed: false }; let completed = false;
      try {
        const initial = structuredClone(active.current?.state.controller ?? null);
        const commit = async (state, fault = () => {}) => {
          await assertOwner(); state.generation = (active.current?.state.controller?.generation ?? 0) + 1;
          fault('before-event'); await update(envelope => { envelope.controller = structuredClone(state); }); fault('after-head'); return state;
        };
        const result = await work({ initial, commit, assertOwner }); completed = true; return result;
      } finally {
        // An interrupted or uncertain owner stays held. Admission expiry never
        // releases it. The custody installation must stop, drain and revoke it
        // before allowing a different process to acquire ownership.
        const session = active; active = null;
        if (completed && !session.failed) await broker.close(owner);
      }
    }
  };
  return Object.freeze(writer);
}
