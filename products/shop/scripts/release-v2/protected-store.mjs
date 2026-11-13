import { canonical, check, digest, parseJSON, same, sha256 } from './data.mjs';
import { exactFields, protocolItemLimit } from './provider-protocol-builders.mjs';
import { ProtocolConflict, ProtocolFailure, UncertainWrite, responseBytes } from './provider-protocol.mjs';
import { createImmutableEventCache } from './immutable-event-cache.mjs';

const etag = value => { check(typeof value === 'string' && /^"[A-Za-z0-9-]{1,128}"$/.test(value), 'Missing exact protected store ETag'); return value; };
const encoded = value => Buffer.from(canonical(value));
export function protectedStore(client, policy, { eventCacheDirectory, eventCacheNamespace = digest(policy), eventCacheLimits = {} } = {}) {
  let cache = null;
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
    if (!identity || !eventCacheDirectory) return remoteGet(key);
    const current = await getCache(), cached = await current.read(identity);
    if (cached) { eventData(cached.bytes, identity); return cached; }
    const found = await remoteGet(key); if (!found) return null;
    eventData(found.bytes, identity); await current.write(identity, found.bytes); return found;
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
    if (identity && eventCacheDirectory) { eventData(observed.bytes, identity); await (await getCache()).write(identity, observed.bytes); }
    return { ...observed, acknowledgement: uncertain ? 'reconciled' : 'confirmed' };
  };
  return Object.freeze({ get, put, cacheMeasurements: async () => cache ? (await cache).measurements() : null });
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
export async function readProtectedJournal(store) {
  const object = await store.get('head.json'); if (!object) return null;
  const head = headData(object.bytes), events = [], seen = new Set(); let next = head.eventDigest, generation = head.generation;
  check(generation <= protocolItemLimit, 'Protected journal replay exceeds bound');
  while (next !== null) {
    check(!seen.has(next) && events.length < protocolItemLimit, 'Protected journal contains a cycle or exceeds replay bound'); seen.add(next);
    const found = await store.get(`events/${next}.json`); check(found, 'Protected immutable event is missing');
    const event = eventData(found.bytes, next); check(event.generation === generation, 'Protected journal generation gap');
    events.push({ digest: next, event }); generation--; next = event.previous;
  }
  check(generation === 0, 'Protected journal history is incomplete');
  return { head, etag: object.etag, versionId: object.versionId, state: events[0].event.state, events: events.reverse() };
}
export async function appendProtectedJournal(store, expected, state) {
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
  await store.put('head.json', encoded(head), current?.etag ?? null);
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
