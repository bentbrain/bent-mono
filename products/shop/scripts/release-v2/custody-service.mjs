import { randomUUID, verify } from 'node:crypto';
import { canonical, check, digest, parseJSON, same } from './data.mjs';
import { assertPolicy, exactFields, isReadRequest, requestBuilders } from './provider-protocol-builders.mjs';
import { appendProtectedJournal, protectedStore, readProtectedJournal } from './protected-store.mjs';
import { protocolClient, ProtocolFailure, responseBytes } from './provider-protocol.mjs';
import { assertCredentialFence } from './hosted-writer.mjs';
import { requestDigest } from './signing.mjs';
import { createProviderSigner } from './provider-credentials.mjs';
import { createHttpsTransport } from './https-transport.mjs';
import { createWorkObserver, createRetainedAssetResolver } from './custody-observations.mjs';
import { createActionsAuthenticator } from './actions-authentication.mjs';
import { rehydrateProviderRequest, materializeProviderCapabilities } from './request-rehydration.mjs';

function rootReceipt(envelope, admission) {
  exactFields(envelope, ['keyId', 'payload', 'signature']); const key = admission.keys.find(item => item.id === envelope.keyId);
  check(key && typeof envelope.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature) && verify(null, Buffer.from(canonical(envelope.payload)), key.publicKey, Buffer.from(envelope.signature, 'base64')), 'Custody root signature differs'); return envelope.payload;
}
function installationReceipt(receipt, admission, custodyPolicy) {
  const value = rootReceipt(receipt, admission);
  exactFields(value, ['schema', 'fenceDigest', 'environmentId', 'installationId', 'credentialEpoch', 'custodyPolicyDigest', 'issuedAt', 'expiresAt']);
  check(value.schema === 'shop.credential-installation/v1' && value.fenceDigest === admission.digest && value.environmentId === admission.payload.environmentId &&
    /^[a-f0-9-]{36}$/.test(value.installationId) && /^[a-z0-9-]{1,128}$/.test(value.credentialEpoch) && value.custodyPolicyDigest === digest(custodyPolicy) &&
    Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) && value.issuedAt <= Date.now() && value.expiresAt > Date.now(), 'Pinned credential installation receipt required'); return value;
}

export async function preflightCustodyRequests({ policy, custodyPolicy, fenceAdmission, installation, assetCatalog }) {
  assertPolicy(policy); assertPolicy(custodyPolicy); assertCredentialFence(fenceAdmission);
  check(fenceAdmission.payload.policyDigest === digest(policy) && (custodyPolicy.store.bucket !== policy.store.bucket || custodyPolicy.store.prefix !== policy.store.prefix), 'Independently pinned custody request graph required');
  const installed = installationReceipt(installation, fenceAdmission, custodyPolicy), main = requestBuilders(policy), custody = requestBuilders(custodyPolicy), requests = [], eventDigest = '0'.repeat(64);
  for (const builders of [main, custody]) {
    requests.push({ request: builders.storeGet('head.json'), deferred: [] }, { request: builders.storeGet(`events/${eventDigest}.json`), deferred: ['eventDigest'] },
      { request: builders.storePut('head.json', Buffer.from(canonical({ schema: 'shop.protected-journal-head/v1', generation: 1, eventDigest })), null), deferred: ['generation', 'eventDigest', 'if-match'] },
      { request: builders.storePut(`events/${eventDigest}.json`, Buffer.from(canonical({ schema: 'shop.protected-journal-event/v1', generation: 1, previous: null, state: { installation: installed } })), null), deferred: ['journalState', 'eventDigest'] });
  }
  if (policy.workInventory) for (let index = 0; index < policy.workInventory.queries.length; index++) requests.push({ request: main.workQuery(index), deferred: [] });
  const manifests = [];
  if (assetCatalog) {
    const resolve = createRetainedAssetResolver(assetCatalog);
    for (const entry of assetCatalog.entries) { check(policy.workers.some(worker => worker.name === entry.resource), 'Custody asset resource differs from admitted policy'); const assets = await resolve({ resource: entry.resource, manifestDigest: entry.manifestDigest }); const session = main.assetSession(entry.resource, assets); requests.push({ request: session, deferred: [] }); manifests.push({ resource: entry.resource, manifestDigest: entry.manifestDigest }); }
  }
  return Object.freeze({ schema: 'shop.custody-request-graph/v1', policyDigest: digest(policy), custodyPolicyDigest: digest(custodyPolicy), fenceDigest: fenceAdmission.digest, installationId: installed.installationId, credentialEpoch: installed.credentialEpoch, requests, assetManifests: manifests, digest: digest({ requests, manifests }), providerWrites: 0 });
}

// Run this executor inside the independently admitted credential installation.
// Its controller-facing boundary returns provider responses and signed receipts,
// never provider credential headers. Storage, identity verification and signing
// are explicit protected adapters. Missing adapters fail before installation.
export async function createCredentialCustody({ policy, custodyPolicy, custodyStore, fenceAdmission, installation, replacement = null,
  providerCredentials, signer = providerCredentials ? createProviderSigner({ policy, ...providerCredentials }) : undefined, trust, transport = createHttpsTransport({ policy }), attest, authenticate, authenticationRoot = null, observeWork, assetCatalog, resolveAssets = assetCatalog ? createRetainedAssetResolver(assetCatalog) : undefined }) {
  assertPolicy(policy); assertPolicy(custodyPolicy); assertCredentialFence(fenceAdmission);
  check(fenceAdmission?.payload?.policyDigest === digest(policy) && (custodyPolicy.store.bucket !== policy.store.bucket || custodyPolicy.store.prefix !== policy.store.prefix), 'Independently pinned custody journal namespace required');
  let authenticatePrincipal = authenticate ?? (authenticationRoot ? createActionsAuthenticator({ root: authenticationRoot, policy, fenceAdmission }) : null);
  check(custodyStore && typeof authenticatePrincipal === 'function' && typeof attest === 'function' && (typeof observeWork === 'function' || policy.workInventory) && typeof signer === 'function', 'Protected custody storage, identity, attestation and provider signer adapters required');
  if (providerCredentials?.getCredentials) check(providerCredentials.credentialEpoch === installation.payload?.credentialEpoch, 'Renewable signer epoch differs from installed custody epoch');
  const requestGraph = await preflightCustodyRequests({ policy, custodyPolicy, fenceAdmission, installation, assetCatalog });
  let installed = installationReceipt(installation, fenceAdmission, custodyPolicy), client = protocolClient({ policy, signer, trust, transport }), controllerStore = protectedStore(client, policy);
  const observeAcceptedWork = observeWork ?? createWorkObserver({ policy, client });
  let current = await readProtectedJournal(custodyStore), inflight = 0, queue = Promise.resolve();
  if (current) {
    check(replacement, 'Existing credential installation remains held; explicit stop/drain/credential revocation is required');
    const proof = rootReceipt(replacement, fenceAdmission);
    exactFields(proof, ['schema', 'fenceDigest', 'previousInstallationId', 'previousCredentialEpoch', 'newInstallationId', 'credentialsRevoked', 'stopped', 'drained', 'issuedAt', 'expiresAt']);
    check(proof.schema === 'shop.custody-installation-replacement/v1' && proof.fenceDigest === fenceAdmission.digest && proof.previousInstallationId === current.state.installation.installationId &&
      proof.previousCredentialEpoch === current.state.installation.credentialEpoch && proof.newInstallationId === installed.installationId && proof.credentialsRevoked === true && proof.stopped === true && proof.drained === true &&
      installed.credentialEpoch !== current.state.installation.credentialEpoch && proof.issuedAt <= Date.now() && proof.expiresAt > Date.now(), 'Stopped, drained and revoked previous credential epoch required');
  }
  const state = { schema: 'shop.credential-custody-state/v1', environmentId: fenceAdmission.payload.environmentId, installation: installed, owner: null,
    tokens: current?.state.tokens ?? [], requests: current?.state.requests ?? [], recoveries: current?.state.recoveries ?? [] };
  current = await appendProtectedJournal(custodyStore, current, state);
  const assertInstallation = async () => {
    check(installed.expiresAt > Date.now() && fenceAdmission.payload.expiresAt > Date.now(), 'Credential installation authority expired');
    const headObject = await custodyStore.get('head.json'), observed = headObject ? parseJSON(headObject.bytes) : null;
    check(observed && same(observed, current.head), 'Credential installation changed; stale service cannot dispatch');
  };
  const update = async mutate => {
    await assertInstallation(); const state = structuredClone(current.state); await mutate(state);
    check(state.requests.length <= 4096 && state.recoveries.length <= 128 && current.head.generation < 4096, 'Custody journal bounds exceeded');
    // Startup verifies the full immutable chain. This sole installation retains
    // each verified predecessor, then verifies fresh event/head readbacks and a
    // current ETag for every append. It does not download the same history for
    // every provider GET.
    const event = { schema: 'shop.protected-journal-event/v1', generation: current.head.generation + 1, previous: current.head.eventDigest, state }, eventDigest = digest(event);
    await custodyStore.put(`events/${eventDigest}.json`, Buffer.from(canonical(event)), null);
    const head = { schema: 'shop.protected-journal-head/v1', generation: event.generation, eventDigest }, saved = await custodyStore.put('head.json', Buffer.from(canonical(head)), current.etag);
    current = { head, state, etag: saved.etag, versionId: saved.versionId, events: [...current.events, { digest: eventDigest, event }] }; return current;
  };
  const run = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  async function cloudResponse(request, intentDigest = null) {
    try { return await client.send(request, { intentDigest }); }
    catch (error) {
      if (error instanceof ProtocolFailure) return { status: error.status, complete: true, headers: {}, bodyBase64: Buffer.from('{}').toString('base64') };
      throw error;
    }
  }
  const service = {
    handle: (input, identityContext) => run(async () => {
      exactFields(input, ['schema', 'action', 'nonce', 'fenceDigest', 'environmentId', 'owner', 'request', 'intent']);
      check(input.schema === 'shop.credential-broker-call/v1' && input.fenceDigest === fenceAdmission.digest && input.environmentId === fenceAdmission.payload.environmentId && /^[a-f0-9-]{36}$/.test(input.nonce), 'Exact custody call identity required');
      const principal = await authenticatePrincipal(input, identityContext);
      check(principal && principal.environmentId === input.environmentId && principal.policyDigest === digest(policy) && principal.fenceDigest === fenceAdmission.digest && /^[a-f0-9]{64}$/.test(principal.principalDigest), 'Authenticated protected controller principal required');
      await assertInstallation(); let owner = input.owner, result;
      if (input.action === 'open') {
        check(current.state.owner === null && inflight === 0, 'Credential writer is held; explicit stop/drain/revoke is required'); owner = randomUUID();
        await update(state => { state.owner = { id: owner, principalDigest: principal.principalDigest }; }); result = { exclusive: true, outstanding: 0 };
      } else if (input.action === 'work-inventory') {
        check(input.owner === null && input.request === null, 'Work inventory is a read-only custody action');
        const observed = await observeAcceptedWork();
        check(observed?.complete === true && Array.isArray(observed.jobs) && observed.jobs.length <= 4096 && /^[a-f0-9]{64}$/.test(observed.queryDigest), 'Complete protected accepted-work readback required');
        result = { schema: 'shop.accepted-work-observation/v1', environmentId: input.environmentId, complete: true, queryDigest: observed.queryDigest, observedAt: Date.now(), jobs: observed.jobs };
      } else if (input.action === 'read') {
        const request = await rehydrateProviderRequest(input.request, { policy }); check(input.owner === null && isReadRequest(request), 'Custody read action permits GET only'); result = await cloudResponse(request);
      } else {
        check(current.state.owner?.id === input.owner && current.state.owner.principalDigest === principal.principalDigest, 'Stale credential writer rejected');
        if (input.action === 'assert') result = { current: true };
        else if (input.action === 'close') { check(inflight === 0, 'Custody dispatch remains in flight'); await update(state => { state.owner = null; }); result = { closed: true, outstanding: 0 }; }
        else {
          check(['journal', 'dispatch'].includes(input.action), 'Unsupported custody operation');
          let assets = null;
          if (input.request.operation.startsWith('assets.')) {
            check(typeof resolveAssets === 'function', 'Retained custody asset resolver is required');
            const resource = input.request.operation === 'assets.session' ? policy.workers.find(worker => new URL(input.request.url).pathname.includes(`/${worker.name}/`))?.name : current.state.tokens.find(token => `Bearer ${token.handle}` === input.request.headers.authorization)?.resource;
            const manifestDigest = input.request.operation === 'assets.session' ? digest(parseJSON(Buffer.from(input.request.bodyBase64, 'base64')).manifest) : null;
            assets = await resolveAssets({ ...input, resource, manifestDigest });
          }
          let request = await rehydrateProviderRequest(input.request, { policy, assets }); const identity = requestDigest(request); let controllerRequest = null;
          if (input.action === 'journal') check(request.service === 's3' && request.operation === 'store.put', 'Custody journal action permits exact conditional S3 PUT only');
          else {
            const headObject = await controllerStore.get('head.json'); check(headObject, 'Durable controller intent is missing'); const head = parseJSON(headObject.bytes);
            check(head.eventDigest === input.intent?.eventDigest && input.intent.requestDigest === identity, 'Durable provider request head differs');
            const eventObject = await controllerStore.get(`events/${head.eventDigest}.json`); check(eventObject && digest(parseJSON(eventObject.bytes)) === head.eventDigest, 'Immutable controller request event differs');
            const event = parseJSON(eventObject.bytes), saved = event.state.provider.requests.find(item => item.requestDigest === identity && item.status === 'intent' && item.operationId === event.state.controller.operation?.id);
            controllerRequest = saved;
            if (request.operation === 'report.create-deployment') {
              const report = event.state.provider.reports.find(item => item.kind === 'deployment' && item.requestDigest === identity && item.status === 'intent');
              check(report && report.eventDigest && same(report.release, { head: parseJSON(Buffer.from(request.bodyBase64, 'base64')).ref, compositionDigest: parseJSON(Buffer.from(request.bodyBase64, 'base64')).payload?.compositionDigest }), 'Exact immutable deployment creation intent required');
              const journal = await readProtectedJournal(controllerStore), verified = journal.events.find(item => item.digest === report.eventDigest)?.event.state.controller;
              check(verified?.phase === 'runtime-verified' && digest(verified.lastVerified) === report.release.compositionDigest && parseJSON(Buffer.from(request.bodyBase64, 'base64')).payload?.eventDigest === report.eventDigest, 'Deployment must reference immutable runtime verification');
            } else if (request.operation === 'report.success' && !saved) {
              const report = event.state.provider.reports.find(item => item.requestDigest === identity), deploymentId = new URL(request.url).pathname.split('/').at(-2);
              check(report && report.deploymentId === deploymentId && report.body?.eventDigest === report.eventDigest && report.body.status === 'success', 'Exact immutable reporting intent required');
              const journal = await readProtectedJournal(controllerStore), verified = journal.events.find(item => item.digest === report.eventDigest)?.event.state.controller;
              check(verified?.phase === 'runtime-verified' && digest(verified.lastVerified) === report.body.compositionDigest && digest(verified.verification) === report.body.verificationDigest && verified.report.eventId === report.body.eventId && parseJSON(Buffer.from(request.bodyBase64, 'base64')).description === `Verified release event ${report.eventDigest}`, 'Retained runtime verification reporting subject differs');
            } else check(saved && saved.operationId === event.state.controller.operation?.id && event.state.controller.phase.endsWith('-reconcile') && saved.method === request.method && saved.url === request.url && saved.bodySha256 === request.bodySha256, 'Exact admitted controller request intent required');
          }
          if (request.operation === 'report.success' && policy.github.reporting === 'per-release') {
            const journal = await readProtectedJournal(controllerStore), deploymentId = new URL(request.url).pathname.split('/').at(-2), body = parseJSON(Buffer.from(request.bodyBase64, 'base64'));
            check(journal.state.provider.reports.some(item => item.kind === 'deployment' && item.status === 'acknowledged' && item.deploymentId === deploymentId && body.description === `Verified release event ${item.eventDigest}`), 'Reporting ID lacks exact durable release deployment mapping');
          }
          if (input.action === 'dispatch') request = await materializeProviderCapabilities(input.request, { policy, assets, resolve: async (handle, purpose) => { const token = current.state.tokens.find(item => item.handle === handle && item.purpose === purpose && item.operationId === controllerRequest.operationId && item.resource === controllerRequest.target.resource && item.expiresAt > Date.now()); check(token, 'Private custody asset capability is missing, expired or belongs to another operation'); return token.value; } });
          const scope = input.action === 'journal' ? { action: 'journal', requestDigest: identity } : request.operation === 'report.success' || request.operation === 'report.create-deployment' ? { action: request.operation, eventDigest: request.operation === 'report.success' ? parseJSON(Buffer.from(request.bodyBase64, 'base64')).description.slice('Verified release event '.length) : parseJSON(Buffer.from(request.bodyBase64, 'base64')).payload.eventDigest } : { action: 'dispatch', operationId: controllerRequest.operationId, step: controllerRequest.step ?? request.operation };
          const claimDigest = digest(scope);
          check(!current.state.requests.some(item => item.claimDigest ? item.claimDigest === claimDigest : item.requestDigest === identity), 'Durable custody no-replay fence rejected request');
          await update(state => { state.requests.push({ claimDigest, scope, requestDigest: identity, wireRequestDigest: requestDigest(request), action: input.action, owner: input.owner, controllerEventDigest: input.intent?.eventDigest ?? null, status: 'sending' }); });
          // This serialized executor keeps ownership until the socket has ended.
          // A crash retains the send claim. A new installation cannot acquire
          // credentials through timeout or journal CAS alone.
          inflight++;
          try {
            result = await cloudResponse(request, claimDigest); responseBytes(result);
            const actualResponseDigest = digest(result);
            if (['assets.session', 'assets.upload'].includes(request.operation) && result.status >= 200 && result.status < 300) {
              const body = parseJSON(responseBytes(result));
              if (body.result?.jwt) {
                const handle = `custody.${randomUUID()}.capability`, value = body.result.jwt, purpose = request.operation === 'assets.session' && body.result.buckets?.length ? 'asset-upload' : 'asset-completion';
                await update(state => { state.tokens.push({ handle, value, purpose, operationId: controllerRequest.operationId, resource: controllerRequest.target.resource, expiresAt: Date.now() + 3600000 }); });
                body.result.jwt = handle; const bytes = Buffer.from(canonical(body)); result = { ...result, headers: { ...result.headers, 'content-length': String(bytes.length) }, bodyBase64: bytes.toString('base64') };
              }
            }
            await update(state => { const record = state.requests.find(item => item.claimDigest === claimDigest); record.status = 'acknowledged'; record.responseDigest = digest(result); record.actualResponseDigest = actualResponseDigest; });
          } finally { inflight--; }
        }
      }
      const payload = { schema: 'shop.credential-broker-result/v1', action: input.action, nonce: input.nonce, fenceDigest: fenceAdmission.digest, owner, issuedAt: Date.now(), callDigest: digest(input), result };
      const signed = await attest(payload); check(same(rootReceipt(signed, fenceAdmission), payload), 'Custody response attester changed payload'); return signed;
    }),
    recoverOwner: receipt => run(async () => {
      await assertInstallation(); const proof = rootReceipt(receipt, fenceAdmission);
      exactFields(proof, ['schema', 'fenceDigest', 'installationId', 'owner', 'controllerStopped', 'issuedAt', 'expiresAt']);
      check(proof.schema === 'shop.custody-owner-recovery/v1' && proof.fenceDigest === fenceAdmission.digest && proof.installationId === installed.installationId && proof.owner === current.state.owner?.id && proof.controllerStopped === true && proof.issuedAt <= Date.now() && proof.expiresAt > Date.now() && inflight === 0, 'Stopped controller and drained exclusive owner recovery required');
      await update(state => { state.recoveries.push({ receiptDigest: digest(receipt), owner: state.owner.id, at: Date.now() }); state.owner = null; });
      return { status: 'owner-revoked', pending: current.state.requests.filter(item => item.status === 'sending').map(item => item.requestDigest) };
    }),
    renewAuthority: ({ fenceAdmission: nextFence, installation: receipt }) => run(async () => {
      assertCredentialFence(nextFence); const next = installationReceipt(receipt, nextFence, custodyPolicy);
      check(next.installationId === installed.installationId && next.credentialEpoch === installed.credentialEpoch && next.environmentId === installed.environmentId && next.expiresAt > installed.expiresAt && nextFence.payload.policyDigest === fenceAdmission.payload.policyDigest && nextFence.payload.brokerId === fenceAdmission.payload.brokerId && nextFence.payload.implementationDigest === fenceAdmission.payload.implementationDigest && same(nextFence.keys.map(key => ({ id: key.id, pem: key.publicKey.export({ type: 'spki', format: 'pem' }) })), fenceAdmission.keys.map(key => ({ id: key.id, pem: key.publicKey.export({ type: 'spki', format: 'pem' }) }))), 'Renewal cannot replace credential installation, epoch or custody identity');
      const observed = await custodyStore.get('head.json'); check(observed && same(parseJSON(observed.bytes), current.head), 'Credential installation changed before renewal');
      const previous = installed, oldFence = fenceAdmission, oldAuthenticator = authenticatePrincipal; installed = next; fenceAdmission = nextFence;
      if (authenticationRoot && !authenticate) authenticatePrincipal = createActionsAuthenticator({ root: authenticationRoot, policy, fenceAdmission });
      try { await update(state => { state.installation = next; }); } catch (error) { installed = previous; fenceAdmission = oldFence; authenticatePrincipal = oldAuthenticator; throw error; }
      return { status: 'authority-renewed', owner: current.state.owner?.id ?? null, installationId: installed.installationId, credentialEpoch: installed.credentialEpoch };
    }),
    requestGraph,
    installationId: installed.installationId,
    readState: async () => { const state = structuredClone((await readProtectedJournal(custodyStore)).state); state.tokens = state.tokens.map(({ value, ...token }) => token); return state; }
  };
  return Object.freeze(service);
}
