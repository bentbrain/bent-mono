import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { canonical, check, digest, same, sha256 } from './data.mjs';
import { exactFields, assertPolicy, requestBuilders, isReadRequest } from './provider-protocol-builders.mjs';
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
  let sequence=0,inflightCalls=0;const checkpoints=new WeakMap();
  const call = async (action, owner, request = null, intent = null) => {
    sequence++;inflightCalls++;try{
    check(fenceAdmission.payload.expiresAt > now(), 'Credential custody admission expired');
    const nonce = randomUUID(), sentAt = now();
    const input = { schema: 'shop.credential-broker-call/v1', action, nonce, fenceDigest: fenceAdmission.digest, environmentId: fenceAdmission.payload.environmentId, owner, request, intent };
    const result = await boundary(input), payload = verifyEnvelope(result, fenceAdmission.keys);
    exactFields(payload, ['schema', 'action', 'nonce', 'fenceDigest', 'owner', 'issuedAt', 'callDigest', 'result']);
    check(payload.schema === 'shop.credential-broker-result/v1' && payload.action === action && payload.nonce === nonce && payload.callDigest === digest(input) && payload.fenceDigest === fenceAdmission.digest &&
      (action === 'open' ? typeof payload.owner === 'string' && /^[a-f0-9-]{36}$/.test(payload.owner) : payload.owner === owner) && Number.isSafeInteger(payload.issuedAt) && payload.issuedAt >= sentAt - 1000 && payload.issuedAt <= now(), 'Credential broker response identity differs');
    if (action === 'open') check(payload.result.exclusive === true && payload.result.outstanding === 0, 'Credential broker ownership is not exclusive and drained');
    return payload;}finally{inflightCalls--;}
  };
  const readBatch=async(requests,owner)=>{
    check(Array.isArray(requests)&&requests.length>0&&requests.length<=32&&requests.every(isReadRequest),'Bounded exact custody read batch required');
    const result=(await call('read-many',owner,requests)).result;exactFields(result,['schema','complete','results']);check(result.schema==='shop.custody-read-batch/v1'&&result.complete===true&&Array.isArray(result.results)&&result.results.length===requests.length&&Buffer.byteLength(canonical(result))<=32*1024*1024,'Complete signed read batch required');
    return result.results.map((item,index)=>{exactFields(item,['requestDigest','response','provenance']);check(item.requestDigest===requestDigest(requests[index])&&item.provenance?.kind==='authenticated-provider','Read batch member differs');responseBytes(item.response);return item.response;});
  };
  const broker = Object.freeze({ fenceAdmission,
    open: async (journalNamespace = null) => {
      check(journalNamespace === null || /^native-qualification\/[a-f0-9]{64}$/.test(journalNamespace), 'Exact native qualification journal namespace required');
      return (await call('open', null, null, journalNamespace === null ? null : { journalNamespace })).owner;
    },
    assertOwner: async owner => { const result = (await call('assert', owner)).result; check(result.current === true, 'Credential broker rejected stale writer'); },
    close: async owner => { const result = (await call('close', owner)).result; check(result.closed === true && result.outstanding === 0, 'Credential broker cannot release outstanding dispatch'); },
    nativeFixtureGrant: async (owner, intent) => {
      exactFields(intent, ['journalNamespace', 'eventDigest', 'probeId']);
      check(/^native-qualification\/[a-f0-9]{64}$/.test(intent.journalNamespace) && hash(intent.eventDigest) && /^[a-z][a-z0-9-]{0,63}$/.test(intent.probeId), 'Exact admitted native fixture intent required');
      const handle = (await call('native-fixture-grant', owner, null, intent)).result;
      check(typeof handle === 'string' && /^custody_[a-f0-9-]{36}\.grant$/.test(handle), 'Opaque custody native fixture grant required'); return handle;
    },
    workInventory: async () => { const value = (await call('work-inventory', null)).result; exactFields(value, ['schema', 'complete', 'environmentId', 'queryDigest', 'observedAt', 'jobs']); check(value.schema === 'shop.accepted-work-observation/v1' && value.complete === true && value.environmentId === fenceAdmission.payload.environmentId && hash(value.queryDigest) && Number.isSafeInteger(value.observedAt) && value.observedAt <= now() && now() - value.observedAt <= 30000 && Array.isArray(value.jobs) && value.jobs.length <= 4096, 'Complete signed accepted-work observation required'); for (const job of value.jobs) { exactFields(job, ['component', 'artifactDigest', 'format']); check(hash(job.artifactDigest) && typeof job.component === 'string' && typeof job.format === 'string', 'Accepted work identity differs'); } return value; },
    readMany: async requests => readBatch(requests,null),
    checkpoint: async(owner,requests)=>{check(inflightCalls===0,'Custody checkpoint cannot overlap broker operations');const expected=sequence+1,responses=await readBatch(requests,owner);check(sequence===expected,'Custody checkpoint request intervened');const token=Object.freeze({});checkpoints.set(token,{owner,sequence,responses:structuredClone(responses),consumed:false});return {token,responses};},
    consumeCheckpoint:(token,owner)=>{const value=checkpoints.get(token);check(value&&value.owner===owner&&value.sequence===sequence&&!value.consumed,'Custody checkpoint changed, intervened or replayed');value.consumed=true;return structuredClone(value.responses);},
    checkpointCurrent:token=>checkpoints.get(token)?.sequence===sequence,
    journalSnapshot: async (journalNamespace=null) => {
      check(journalNamespace===null||/^native-qualification\/[a-f0-9]{64}$/.test(journalNamespace),'Exact snapshot journal namespace required');let anchor=null,before=null,head=null;const events=[];let expected=null;
      for(let page=0;page<4096;page++){
        const value=(await call('journal-snapshot',null,null,{journalNamespace,anchor,before})).result;exactFields(value,['schema','head','events','next','complete']);check(value.schema==='shop.custody-journal-page/v1'&&Array.isArray(value.events)&&value.events.length<=64&&typeof value.complete==='boolean'&&value.complete===(value.next===null),'Complete anchored journal page required');
        if(head===null&&value.head!==null){head=value.head;exactFields(head,['bodyBase64','etag','versionId','provenance']);check(head.provenance?.kind==='authenticated-provider','Journal snapshot requires fresh authenticated head');const parsed=JSON.parse(Buffer.from(head.bodyBase64,'base64'));anchor={headDigest:sha256(Buffer.from(head.bodyBase64,'base64')),etag:head.etag,versionId:head.versionId};expected={eventDigest:parsed.eventDigest,generation:parsed.generation};}
        check(same(head,value.head),'Journal snapshot head changed across pages');
        for(const item of value.events){exactFields(item,['eventDigest','bodyBase64','provenance']);const bytes=Buffer.from(item.bodyBase64,'base64'),parsed=JSON.parse(bytes);check(expected&&item.eventDigest===expected.eventDigest&&digest(parsed)===item.eventDigest&&Buffer.from(canonical(parsed)).equals(bytes)&&parsed.generation===expected.generation&&['authenticated-provider','custody-verified-immutable-event'].includes(item.provenance?.kind),'Journal snapshot chain changed or provenance differs');events.push(item);check(events.length<=4096,'Journal snapshot exceeds complete-history bound');expected=parsed.previous===null?null:{eventDigest:parsed.previous,generation:parsed.generation-1};}
        if(value.complete){check(value.head===null?events.length===0:expected===null,'Truncated journal snapshot');return {head,events};}
        check(value.events.length>0&&same(expected,value.next),'Journal snapshot continuation differs');before=value.next;
      }
      throw Error('Journal snapshot pagination exceeded bound');
    },
    journalAppend: async(owner,requests)=>{
      check(Array.isArray(requests)&&requests.length===2&&requests.every(request=>request.service==='s3'&&request.operation==='store.put'),'Exact paired journal requests required');const result=(await call('journal-append',owner,requests)).result;exactFields(result,['schema','complete','acknowledgement','readbacks']);check(result.schema==='shop.custody-journal-append/v1'&&result.complete===true&&['confirmed','reconciled'].includes(result.acknowledgement)&&Array.isArray(result.readbacks)&&result.readbacks.length===2,'Complete authenticated journal append required');for(let index=0;index<2;index++){const item=result.readbacks[index];exactFields(item,['requestDigest','response','provenance']);check(item.requestDigest===requestDigest(requests[index])&&item.provenance?.kind==='authenticated-provider','Journal append readback differs');responseBytes(item.response);}return result;
    },
    read: async request => { check(isReadRequest(request), 'Custody read path permits exact read operations only'); return (await call('read', null, request)).result; },
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
export function createHostedWriter({ policy, store, broker, fenceAdmission, eventCacheDirectory, journalNamespace = null, beforeMutation = async () => {} }) {
  assertCredentialBroker(broker); check(fences.has(fenceAdmission) && broker.fenceAdmission === fenceAdmission, 'Matching protected writer custody admission required');
  check(typeof beforeMutation === 'function', 'Protected mutation admission boundary required');
  check(journalNamespace === null || /^native-qualification\/[a-f0-9]{64}$/.test(journalNamespace) && policy.nativeQualification, 'Independently installed native qualification journal required');
  let active = null,lastVerifiedEnvelope=null,pendingSend=null,reusableHead=null,inventoryObservation=null;
  if (!store) { assertPolicy(policy); check(digest(policy) === fenceAdmission.payload.policyDigest, 'Writer policy differs'); const builders = requestBuilders(policy); store = protectedStore({ builders: {
    storeGet: key => builders.storeGet(key, journalNamespace), storePut: (key, bytes, etag) => builders.storePut(key, bytes, etag, journalNamespace)
  }, readJournalSnapshot:()=>broker.journalSnapshot(journalNamespace),appendJournal:requests=>{check(active&&!active.failed,'Active admitted paired journal writer required');return broker.journalAppend(active.owner,requests);}, send: async request => { const response = request.method === 'GET' ? await broker.read(request) : (check(active && !active.failed, 'Active admitted hosted writer required'), await broker.journal(active.owner, request)); responseBytes(response); if ([409, 412].includes(response.status)) throw new ProtocolConflict(request.operation); if (response.status < 200 || response.status >= 300) throw new ProtocolFailure(request.operation, response.status); return response; } }, policy,
    { eventCacheDirectory, eventCacheNamespace: digest({ policyDigest: digest(policy), fenceDigest: fenceAdmission.digest, ...(journalNamespace === null ? {} : { journalNamespace }) }) }); }
  const readEnvelope = async (fresh = false,immutable=false) => {
    if(inventoryObservation&&!fresh)return structuredClone(inventoryObservation.snapshot);
    if(immutable&&lastVerifiedEnvelope)return structuredClone(lastVerifiedEnvelope);
    if (active && !fresh) return active.current;
    const current = await readProtectedJournal(store);
    if (current) {
      exactFields(current.state, ['schema', 'environmentId', 'policyDigest', 'controller', 'provider']);
      check(current.state.schema === 'shop.hosted-controller-journal/v1' && current.state.environmentId === fenceAdmission.payload.environmentId && current.state.policyDigest === fenceAdmission.payload.policyDigest, 'Protected journal environment authority differs');
      exactFields(current.state.provider, ['versions', 'operations', 'requests', 'reports']);
      for (const field of ['versions', 'operations', 'requests', 'reports']) check(Array.isArray(current.state.provider[field]) && current.state.provider[field].length <= 4096, 'Protected provider journal inventory exceeds bound');
    }
    lastVerifiedEnvelope=structuredClone(current);return current;
  };
  const assertOwner = async () => { check(active && !active.failed, 'Active admitted hosted writer required');if(pendingSend){broker.consumeCheckpoint(pendingSend.token,active.owner);reusableHead=pendingSend;pendingSend=null;return;}await broker.assertOwner(active.owner); };
  const update = async mutate => {
    // Both journal PUTs cross the broker's atomic owner check. A separate
    // assertion RPC cannot strengthen that send boundary.
    check(active && !active.failed, 'Active admitted hosted writer required');
    await beforeMutation();
    const observed = active.current;
    const next = structuredClone(observed?.state ?? { schema: 'shop.hosted-controller-journal/v1', environmentId: fenceAdmission.payload.environmentId, policyDigest: fenceAdmission.payload.policyDigest, controller: null, provider: emptyProvider() });
    await mutate(next);
    try { pendingSend=null;reusableHead=null;inventoryObservation=null;active.current = await appendProtectedJournal(store, observed, next);lastVerifiedEnvelope=structuredClone(active.current); return active.current; }
    catch (error) { active.failed = true; throw error; }
  };
  const expose=current=>current?.state.controller?{head:structuredClone(current.head),state:structuredClone(current.state.controller)}:null;
  const readHead = async () => {if(reusableHead){const value=reusableHead;reusableHead=null;check(broker.checkpointCurrent(value.token),'Custody send head observation intervened');return expose(value.snapshot);}return expose(await readEnvelope(true));};
  const readSendCheckpoint=async()=>{check(active&&!active.failed,'Active admitted send checkpoint required');const request=requestBuilders(policy).storeGet('head.json',journalNamespace),observed=await broker.checkpoint(active.owner,[request]),response=observed.responses[0];check(response.status===200,'Fresh send head unavailable');const actual=store.acceptReadback('head.json',response);check(active.current&&actual.bytes.equals(Buffer.from(canonical(active.current.head)))&&actual.etag===active.current.etag&&actual.versionId===active.current.versionId,'Saved intent checkpoint head changed');pendingSend={token:observed.token,snapshot:structuredClone(active.current)};return expose(active.current);};
  const withInventoryRead=async(requests,work)=>{
    check(!inventoryObservation&&Array.isArray(requests)&&typeof work==='function','Single complete inventory observation required');
    if(active){const responses=[];for(let offset=0;offset<requests.length;offset+=32)responses.push(...await broker.readMany(requests.slice(offset,offset+32)));return work(responses);}
    if(!lastVerifiedEnvelope)await readEnvelope(true);
    const headRequest=requestBuilders(policy).storeGet('head.json',journalNamespace),all=[headRequest,...requests],responses=[];
    for(let offset=0;offset<all.length;offset+=32)responses.push(...await broker.readMany(all.slice(offset,offset+32)));
    const response=responses.shift();if(lastVerifiedEnvelope){check(response.status===200,'Complete inventory baseline head required');const actual=store.acceptReadback('head.json',response);check(actual.bytes.equals(Buffer.from(canonical(lastVerifiedEnvelope.head)))&&actual.etag===lastVerifiedEnvelope.etag&&actual.versionId===lastVerifiedEnvelope.versionId,'Inventory baseline head changed');}else check(response.status===404,'Empty inventory baseline changed');
    const observation={snapshot:structuredClone(lastVerifiedEnvelope)};inventoryObservation=observation;try{return await work(responses);}finally{if(inventoryObservation===observation)inventoryObservation=null;}
  };
  const writer = {
    readHead, assertOwner,...(store.acceptReadback?{readSendCheckpoint,withInventoryRead}:{}),
    cacheMeasurements: async () => typeof store.cacheMeasurements === 'function' ? store.cacheMeasurements() : null,
    readProviderState: async () => structuredClone((await readEnvelope())?.state.provider ?? emptyProvider()),
    recordProvider: async mutate => { const current = await update(envelope => mutate(envelope.provider)); return current.head.eventDigest; },
    readVerification: async eventDigest => { check(hash(eventDigest), 'Exact immutable runtime verification identity required'); const current = await readEnvelope(false,true); const found = current?.events.find(item => item.digest === eventDigest && item.event.state.controller?.phase === 'runtime-verified' && (current.events[current.events.indexOf(item) - 1]?.event.state.controller?.generation ?? null) !== item.event.state.controller.generation); check(found?.event.state.controller.verification && found.event.state.controller.lastVerified, 'Immutable verified runtime event is unavailable'); return structuredClone(found.event.state.controller); },
    verificationRef: async () => {
      const current = await readEnvelope();
      const found = current?.events.findLast((item, index) => item.event.state.controller?.phase === 'runtime-verified' && (current.events[index - 1]?.event.state.controller?.generation ?? null) !== item.event.state.controller.generation);
      check(found && found.event.state.controller.verification && found.event.state.controller.lastVerified, 'Immutable runtime verification event required'); return found.digest;
    },
    dispatch: async (request, eventDigest) => { check(active && !active.failed, 'Active admitted hosted writer required'); await beforeMutation(); return broker.dispatch(active.owner, request, { requestDigest: requestDigest(request), eventDigest, ...(journalNamespace === null ? {} : { journalNamespace }) }); },
    nativeFixtureGrant: async (probeId, eventDigest) => {
      check(active && !active.failed && journalNamespace !== null, 'Active admitted native fixture writer required'); await beforeMutation();
      return broker.nativeFixtureGrant(active.owner, { journalNamespace, eventDigest, probeId });
    },
    readVerifiedHistory: async () => { const current = await readEnvelope(false,true); return current?.state.controller ? { state: structuredClone(current.state.controller) } : null; },
    withWriter: async work => {
      if (active) {
        check(active.persistent && !active.running && !active.failed, 'Hosted writer invocation already active');
        return transaction(work);
      }
      return ownership(() => transaction(work), false);
    },
    withSession: async work => ownership(work, true)

  };

  async function transaction(work) {
    check(active && !active.running && !active.failed, 'Active admitted hosted writer required'); active.running = true;
    try {
      const initial = structuredClone(active.current?.state.controller ?? null);
      const commit = async (state, fault = () => {}) => {
        state.generation = (active.current?.state.controller?.generation ?? 0) + 1;
        fault('before-event'); await update(envelope => { envelope.controller = structuredClone(state); }); fault('after-head'); return state;
      };
      return await work({ initial, commit, assertOwner });
    } catch (error) { active.failed = true; throw error; }
    finally { active.running = false; }
  }
  async function ownership(work, persistent) {
    check(!active, 'Hosted writer invocation already active'); const owner = await broker.open(journalNamespace);
    const current = await readEnvelope(true); active = { owner, current, failed: false, persistent, running: false }; let completed = false;
    try { const result = await work(); completed = true; return result; }
    finally {
      const session = active; active = null;
      // Unknown sends and failed CAS retain ownership for explicit stop/drain/revoke.
      if (completed && !session.failed) await broker.close(owner);
    }
  }
  return Object.freeze(writer);
}
