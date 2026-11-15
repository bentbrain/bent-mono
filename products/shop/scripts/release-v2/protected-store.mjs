import { canonical, check, digest, parseJSON, same, sha256 } from './data.mjs';
import { exactFields, protocolItemLimit } from './provider-protocol-builders.mjs';
import { ProtocolConflict, ProtocolFailure, UncertainWrite, responseBytes } from './provider-protocol.mjs';
import { createImmutableEventCache } from './immutable-event-cache.mjs';

const etag = value => { check(typeof value === 'string' && /^"[A-Za-z0-9-]{1,128}"$/.test(value), 'Missing exact protected store ETag'); return value; };
const encoded = value => Buffer.from(canonical(value));
export function protectedStore(client, policy, { eventCacheDirectory, eventCacheNamespace = digest(policy), eventCacheLimits = {} } = {}) {
  let cache = null, verifiedSnapshot = null;
  const memory = new Map(); let memoryBytes = 0, memoryHits = 0, memoryCapacitySkips = 0;
  const remember = (identity, bytes) => {
    if (memory.has(identity)) return;
    if (memory.size >= protocolItemLimit || memoryBytes + bytes.length > 64 * 1024 * 1024) { memoryCapacitySkips++; return; }
    memory.set(identity, Buffer.from(bytes)); memoryBytes += bytes.length;
  };
  const getCache = async () => {
    if (!eventCacheDirectory) return null;
    cache ??= createImmutableEventCache({ directory: eventCacheDirectory, namespace: eventCacheNamespace, ...eventCacheLimits });
    return cache;
  };
  const remoteGet = async key => {
    let response;
    try { response = await client.send(client.builders.storeGet(key)); }
    catch (error) { if (error instanceof ProtocolFailure && error.status === 404) return null; throw error; }
    const bytes = responseBytes(response);
    check(response.headers['x-amz-server-side-encryption'] === 'aws:kms' && response.headers['x-amz-server-side-encryption-aws-kms-key-id'] === policy.store.kmsKeyArn &&
      typeof response.headers['x-amz-version-id'] === 'string' && response.headers['x-amz-version-id'] !== 'null' && response.headers['x-amz-version-id'].length > 0, 'Protected encrypted versioned store readback required');
    return { bytes, etag: etag(response.headers.etag), versionId: response.headers['x-amz-version-id'], provenance: { kind: 'authenticated-provider' } };
  };
  const get = async key => {
    const identity = /^events\/([a-f0-9]{64})\.json$/.exec(key)?.[1];
    if (!identity) return remoteGet(key);
    if (memory.has(identity)) { memoryHits++; return validateRead({ bytes: Buffer.from(memory.get(identity)), provenance: { kind: 'process-verified-immutable-event' } }, identity); }
    const current = await getCache(), cached = current ? await current.read(identity) : null;
    if (cached) { validateRead(cached, identity); remember(identity, cached.bytes); return cached; }
    const found = await remoteGet(key); if (!found) return null;
    validateRead(found, identity); remember(identity, found.bytes); if (current) await current.write(identity, found.bytes); return found;
  };
  const put = async (key, bytes, expectedETag) => {
    // Each call sends at most one PUT. An uncertain acknowledgement permits
    // GET reconciliation only, including when GET still returns absent.
    let uncertain = null;
    try { await client.send(client.builders.storePut(key, bytes, expectedETag)); }
    catch (error) { if (!(error instanceof UncertainWrite)) throw error; uncertain = error; }
    // A cached event cannot confirm a PUT, including an uncertain acknowledgement.
    const observed = await remoteGet(key);
    if (!observed || !observed.bytes.equals(bytes)) {
      if (uncertain) throw uncertain;
      throw new ProtocolConflict('store.readback');
    }
    const identity = /^events\/([a-f0-9]{64})\.json$/.exec(key)?.[1];
    if (identity) { eventData(observed.bytes, identity); remember(identity, observed.bytes); if (eventCacheDirectory) await (await getCache()).write(identity, observed.bytes); }
    return { ...observed, acknowledgement: uncertain ? 'reconciled' : 'confirmed' };
  };
  const acceptReadback=(key,response)=>{const bytes=responseBytes(response);check(response.status===200&&response.headers['x-amz-server-side-encryption']==='aws:kms'&&response.headers['x-amz-server-side-encryption-aws-kms-key-id']===policy.store.kmsKeyArn&&typeof response.headers['x-amz-version-id']==='string'&&response.headers['x-amz-version-id']!=='null','Actual authenticated encrypted journal readback required');const value={bytes,etag:etag(response.headers.etag),versionId:response.headers['x-amz-version-id'],provenance:{kind:'authenticated-provider'}};const identity=/^events\/([a-f0-9]{64})\.json$/.exec(key)?.[1];if(identity){eventData(bytes,identity);remember(identity,bytes);}return value;};
  const readSnapshot=typeof client.readJournalSnapshot==='function'?async()=>{
    if(verifiedSnapshot){const current=await remoteGet('head.json');if(current&&same(headData(current.bytes),verifiedSnapshot.head)&&current.etag===verifiedSnapshot.etag&&current.versionId===verifiedSnapshot.versionId)return structuredClone(verifiedSnapshot);}
    const snapshot=await client.readJournalSnapshot();check(snapshot&&Array.isArray(snapshot.events)&&snapshot.events.length<=protocolItemLimit,'Complete signed journal snapshot required');
    if(snapshot.head===null){check(snapshot.events.length===0,'Absent journal has snapshot events');return null;}
    const head=snapshot.head,bytes=Buffer.from(head.bodyBase64,'base64');check(bytes.toString('base64')===head.bodyBase64&&head.provenance?.kind==='authenticated-provider'&&typeof head.versionId==='string'&&head.versionId!=='null','Fresh authenticated journal snapshot head required');
    const value={head:headData(bytes),etag:etag(head.etag),versionId:head.versionId,events:[]};let expected=value.head.eventDigest,generation=value.head.generation;
    for(const item of snapshot.events){const bytes=Buffer.from(item.bodyBase64,'base64');check(bytes.toString('base64')===item.bodyBase64&&item.eventDigest===expected&&['authenticated-provider','custody-verified-immutable-event'].includes(item.provenance?.kind),'Exact verified snapshot event required');const parsed=eventData(bytes,expected);check(parsed.generation===generation,'Journal snapshot generation gap');remember(expected,bytes);value.events.push({digest:expected,event:parsed});expected=parsed.previous;generation--;}
    check(expected===null&&generation===0&&value.events.length===value.head.generation,'Complete journal snapshot history required');value.events.reverse();value.state=value.events.at(-1).event.state;verifiedSnapshot=structuredClone(value);return value;
  }:null;
  const append=typeof client.appendJournal==='function'?async(expected,state)=>{
    if(expected)check(verifiedSnapshot&&same(expected.head,verifiedSnapshot.head)&&expected.etag===verifiedSnapshot.etag&&expected.versionId===verifiedSnapshot.versionId,'Paired journal predecessor lacks verified complete history');
    const event={schema:'shop.protected-journal-event/v1',generation:(expected?.head.generation??0)+1,previous:expected?.head.eventDigest??null,state},bytes=encoded(event),identity=sha256(bytes),head={schema:'shop.protected-journal-head/v1',generation:event.generation,eventDigest:identity};eventData(bytes,identity);
    const requests=[client.builders.storePut(`events/${identity}.json`,bytes,null),client.builders.storePut('head.json',encoded(head),expected?.etag??null)],result=await client.appendJournal(requests);
    const observedEvent=acceptReadback(`events/${identity}.json`,result.readbacks[0].response),observedHead=acceptReadback('head.json',result.readbacks[1].response);check(observedEvent.bytes.equals(bytes)&&observedHead.bytes.equals(encoded(head)),'Paired journal append readback changed');
    const value={head,etag:observedHead.etag,versionId:observedHead.versionId,state,events:[...(verifiedSnapshot?.events??[]),{digest:identity,event}]};verifiedSnapshot=structuredClone(value);return value;
  }:null;
  return Object.freeze({ get, put,acceptReadback,...(readSnapshot?{readSnapshot}:{}),...(append?{append}:{}), cacheMeasurements: async () => ({ ...(cache ? (await cache).measurements() : {}),
    processCache: { entries: memory.size, bytes: memoryBytes, hits: memoryHits, capacitySkips: memoryCapacitySkips } }) });
}
function headData(bytes) {
  const head = parseJSON(bytes);
  exactFields(head, ['schema', 'generation', 'eventDigest']);
  check(head.schema === 'shop.protected-journal-head/v1' && Number.isSafeInteger(head.generation) && head.generation > 0 && /^[a-f0-9]{64}$/.test(head.eventDigest), 'Malformed protected journal head');
  return head;
}
function eventData(bytes, expectedDigest) {
  check(sha256(bytes) === expectedDigest, 'Protected immutable event bytes differ');
  const event = parseJSON(bytes, 16 * 1024 * 1024);
  exactFields(event, ['schema', 'generation', 'previous', 'state']);
  check(event.schema === 'shop.protected-journal-event/v1' && Number.isSafeInteger(event.generation) && event.generation > 0 && event.state && typeof event.state === 'object' && !Array.isArray(event.state) &&
    (event.previous === null || /^[a-f0-9]{64}$/.test(event.previous)), 'Malformed protected immutable event');
  check(Buffer.from(canonical(event)).equals(bytes), 'Protected events require canonical exact bytes'); return event;
}
const journalSnapshots = new WeakMap();
function retainJournal(store, value) {
  const snapshot = structuredClone(value); journalSnapshots.set(store, snapshot); return structuredClone(snapshot);
}
export async function readProtectedJournal(store) {
  if(store.readSnapshot){const snapshot=await store.readSnapshot();return snapshot?retainJournal(store,snapshot):null;}
  const object = await store.get('head.json'); if (!object) return null;
  const previous = journalSnapshots.get(store), parsedHead = headData(object.bytes);
  if (previous && same(previous.head, parsedHead) && previous.etag === object.etag && previous.versionId === object.versionId) return structuredClone(previous);
  const head = parsedHead, events = [], seen = new Set(); let next = head.eventDigest, generation = head.generation;
  check(generation <= protocolItemLimit, 'Protected journal replay exceeds bound');
  while (next !== null) {
    check(!seen.has(next) && events.length < protocolItemLimit, 'Protected journal contains a cycle or exceeds replay bound'); seen.add(next);
    const found = await store.get(`events/${next}.json`); check(found, 'Protected immutable event is missing');
    const event = consumeEvent(found, next); check(event.generation === generation, 'Protected journal generation gap');
    events.push({ digest: next, event }); generation--; next = event.previous;
  }
  check(generation === 0, 'Protected journal history is incomplete');
  return retainJournal(store, { head, etag: object.etag, versionId: object.versionId, state: events[0].event.state, events: events.reverse() });
}
export async function appendProtectedJournal(store, expected, state) {
  if(store.append)return retainJournal(store,await store.append(expected,state));
  // A caller must persist intent before provider dispatch. CAS controls the
  // journal transition; provider fencing needs the separately admitted writer.
  const current = await readProtectedJournal(store);
  check(same(current?.head ?? null, expected?.head ?? null) && (current?.etag ?? null) === (expected?.etag ?? null), 'Protected journal CAS observation changed');
  const event = { schema: 'shop.protected-journal-event/v1', generation: (current?.head.generation ?? 0) + 1,
    previous: current?.head.eventDigest ?? null, state };
  const bytes = encoded(event), eventDigest = sha256(bytes), key = `events/${eventDigest}.json`;
  eventData(bytes, eventDigest);
  try { await store.put(key, bytes, null); }
  catch (error) {
    if (!(error instanceof ProtocolConflict)) throw error;
    const existing = await store.get(key); check(existing && existing.bytes.equals(bytes), 'Conflicting immutable event');
  }
  const head = { schema: 'shop.protected-journal-head/v1', generation: event.generation, eventDigest };
  const acknowledgement = await store.put('head.json', encoded(head), current?.etag ?? null);
  if (acknowledgement?.bytes && acknowledgement.provenance?.kind === 'authenticated-provider') {
    check(same(headData(acknowledgement.bytes), head), 'Protected journal transition readback differs');
    return retainJournal(store, { head, etag: acknowledgement.etag, versionId: acknowledgement.versionId, state,
      events: [...(current?.events ?? []), { digest: eventDigest, event }] });
  }
  const observed = await readProtectedJournal(store); check(same(observed.head, head) && same(observed.state, state), 'Protected journal transition readback differs');
  return observed;
}
export async function reconcileProtectedJournal(store, expectedEventDigest) {
  check(typeof expectedEventDigest === 'string' && /^[a-f0-9]{64}$/.test(expectedEventDigest), 'Exact uncertain event identity required');
  const current = await readProtectedJournal(store);
  // Recovery is observational. An absent/different head never replays a PUT.
  return { status: current?.head.eventDigest === expectedEventDigest ? 'confirmed' : 'held', current };
}
export async function recoverReportingOnly({ client, store, deploymentId }) {
  const journal = await readProtectedJournal(store);
  check(journal && journal.state.phase === 'report-reconcile' && journal.state.verification && journal.state.lastVerified &&
    journal.state.report?.verificationDigest === digest(journal.state.verification), 'Verified durable reporting outbox required');
  const eventDigest = journal.state.report.eventDigest;
  check(typeof eventDigest === 'string' && /^[a-f0-9]{64}$/.test(eventDigest) &&
    journal.state.report.compositionDigest === digest(journal.state.lastVerified) &&
    journal.events.some(item => item.digest === eventDigest && item.event.state.phase === 'runtime-verified' &&
      same(item.event.state.verification, journal.state.verification) && same(item.event.state.lastVerified, journal.state.lastVerified)), 'Reporting outbox must reference its immutable runtime verification event');
  const inventory = await client.reportInventory(deploymentId);
  const matches = inventory.records.filter(record => record.state === 'success' && record.environment === client.policyEnvironment && record.description === `Verified release event ${eventDigest}`);
  check(matches.length <= 1, 'Ambiguous reporting acknowledgement');
  return { status: matches.length === 1 ? 'confirmed' : 'held', eventDigest, complete: inventory.complete };
}

const validatedReads = new WeakMap();
function validateRead(object, identity) {
  const bytes = Buffer.from(object.bytes), event = eventData(bytes, identity);
  validatedReads.set(object, { bytes, identity, event });
  return object;
}
function consumeEvent(object, identity) {
  const validated = validatedReads.get(object); validatedReads.delete(object);
  // The parsed object stays private until this single use. Reused objects and
  // changed bytes must pass complete validation again.
  if (validated?.identity === identity && Buffer.isBuffer(object.bytes) && object.bytes.equals(validated.bytes)) return validated.event;
  return eventData(object.bytes, identity);
}
