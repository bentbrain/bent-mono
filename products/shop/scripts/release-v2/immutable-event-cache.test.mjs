import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, digest } from './data.mjs';
import { protectedStore, readProtectedJournal } from './protected-store.mjs';
import { requestBuilders } from './provider-protocol-builders.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { ProtocolConflict, ProtocolFailure, UncertainWrite } from './provider-protocol.mjs';

async function fixture(t) {
  const base = process.env.SHOP_BOOTSTRAP_TEST_ROOT ?? tmpdir();
  assert.equal(typeof base, 'string', 'Set a private test root');
  await mkdir(base, { mode: 0o700, recursive: true });
  const root = await realpath(await mkdtemp(join(base, 'immutable-cache-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const policy = protocolFixture().policy, objects = new Map(), calls = [], faults = {};
  let previous = null;
  for (let generation = 1; generation <= 5; generation++) {
    const event = { schema: 'shop.protected-journal-event/v1', generation, previous, state: { counter: generation } };
    previous = digest(event); objects.set(`events/${previous}.json`, Buffer.from(canonical(event)));
  }
  objects.set('head.json', Buffer.from(canonical({ schema: 'shop.protected-journal-head/v1', generation: 5, eventDigest: previous })));
  const client = { builders: requestBuilders(policy), send: async request => {
    const key = new URL(request.url).pathname.slice(policy.store.prefix.length + 2); calls.push({ key, method: request.method });
    if (request.method === 'PUT') {
      if (faults.conflict) throw new ProtocolConflict(request.operation);
      if (!faults.dropBefore) objects.set(key, Buffer.from(request.bodyBase64, 'base64'));
      if (faults.dropBefore || faults.dropAfter) throw new UncertainWrite(request.operation);
      return { status: 200, complete: true, headers: {}, bodyBase64: '' };
    }
    assert.equal(request.method, 'GET'); const bytes = objects.get(key);
    if (!bytes) throw new ProtocolFailure(request.operation, 404);
    return { status: 200, complete: true, headers: { 'content-length': String(bytes.length), etag: '"synthetic-version"',
      'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': policy.store.kmsKeyArn,
      'x-amz-version-id': 'synthetic-version' }, bodyBase64: bytes.toString('base64') };
  } };
  return { root, directory: join(root, 'cache'), policy, client, calls, objects, faults };
}

test('fresh store instances keep head live and fetch each immutable event once across a private persistent cache', async t => {
  const f = await fixture(t);
  for (let run = 0; run < 3; run++) {
    const store = protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory });
    const journal = await readProtectedJournal(store); assert.equal(journal.events.length, 5); assert.equal(journal.state.counter, 5);
  }
  assert.equal(f.calls.filter(call => call.key === 'head.json').length, 3);
  assert.equal(f.calls.filter(call => call.key.startsWith('events/')).length, 5, 'Repeated full-chain provider GET amplification');
});

test('each fetched immutable event is strictly parsed once before journal replay', async t => {
  const f = await fixture(t), store = protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory });
  await readProtectedJournal(store);
  const original = JSON.parse; let parsedEvents = 0;
  JSON.parse = function (text, ...arguments_) {
    const value = original(text, ...arguments_);
    if (value?.schema === 'shop.protected-journal-event/v1') parsedEvents++;
    return value;
  };
  try { assert.equal((await readProtectedJournal(store)).events.length, 5); }
  finally { JSON.parse = original; }
  assert.equal(parsedEvents, 5, 'Duplicate full event parsing during one replay');
});

test('validation handoff rejects changed bytes and never reuses caller-mutated event state', async t => {
  const f = await fixture(t), store = protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory });
  const retained = new Map();
  const replay = { get: async key => {
    if (key === 'head.json') return store.get(key);
    if (!retained.has(key)) retained.set(key, await store.get(key));
    return retained.get(key);
  } };
  const first = await readProtectedJournal(replay); first.state.counter = 999;
  assert.equal((await readProtectedJournal(replay)).state.counter, 5);
  const altered = { get: async key => {
    const found = await store.get(key);
    if (key.startsWith('events/')) found.bytes[0] ^= 1;
    return found;
  } };
  await assert.rejects(readProtectedJournal(altered), /Protected immutable event bytes differ/);
});

test('fresh authenticated head advances fetch only its new event and validate the full cached predecessor chain', async t => {
  const f = await fixture(t), store = protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory });
  const prior = await readProtectedJournal(store);
  const event = { schema: 'shop.protected-journal-event/v1', generation: 6, previous: prior.head.eventDigest, state: { counter: 6 } };
  f.objects.set(`events/${digest(event)}.json`, Buffer.from(canonical(event)));
  f.objects.set('head.json', Buffer.from(canonical({ schema: 'shop.protected-journal-head/v1', generation: 6, eventDigest: digest(event) })));
  const next = await readProtectedJournal(protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory }));
  assert.equal(next.events.length, 6); assert.equal(next.state.counter, 6);
  assert.equal(f.calls.filter(call => call.key.startsWith('events/')).length, 6);
  assert.equal(f.calls.filter(call => call.key === 'head.json').length, 2);
});

test('corrupt cached bytes, symlink members and broad permissions fail closed after a live head read', async t => {
  for (const corrupt of ['bytes', 'symlink', 'mode']) await t.test(corrupt, async t => {
    const f = await fixture(t), store = protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory });
    const journal = await readProtectedJournal(store), cacheRoot = join(f.directory, digest(f.policy));
    const path = join(cacheRoot, `${journal.head.eventDigest}.json`);
    if (corrupt === 'bytes') await writeFile(path, '{}');
    else if (corrupt === 'mode') await chmod(path, 0o644);
    else { const target = join(f.root, 'outside.json'); await writeFile(target, await readFile(path), { mode: 0o600 }); await rm(path); await symlink(target, path); }
    const before = f.calls.length;
    await assert.rejects(readProtectedJournal(protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory })), /cache (content|member)|Private regular immutable/);
    assert.deepEqual(f.calls.slice(before).map(call => call.key), ['head.json']);
  });
});

test('cache capacity falls back to authenticated reads with explicit measurements', async t => {
  const f = await fixture(t), options = { eventCacheDirectory: f.directory, eventCacheLimits: { maximumEntries: 2 } };
  const first = protectedStore(f.client, f.policy, options); assert.equal((await readProtectedJournal(first)).events.length, 5);
  assert.equal((await first.cacheMeasurements()).capacitySkips, 3);
  const second = protectedStore(f.client, f.policy, options); assert.equal((await readProtectedJournal(second)).events.length, 5);
  assert.equal((await second.cacheMeasurements()).capacitySkips, 3);
  assert.equal((await readdir(join(f.directory, digest(f.policy)))).length, 2);
  assert.equal(f.calls.filter(call => call.key.startsWith('events/')).length, 8);
});

test('cached immutable content cannot confirm an unknown PUT acknowledgement or replace a remote precondition', async t => {
  const f = await fixture(t), store = protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory });
  const journal = await readProtectedJournal(store), key = `events/${journal.head.eventDigest}.json`, bytes = f.objects.get(key);
  f.objects.delete(key); f.faults.dropBefore = true;
  const before = f.calls.length; await assert.rejects(store.put(key, bytes, null), UncertainWrite);
  assert.deepEqual(f.calls.slice(before).map(call => [call.method, call.key]), [['PUT', key], ['GET', key]]);
  assert.equal((await store.get(key)).provenance.kind, 'local-immutable-event-cache');
  delete f.faults.dropBefore; f.faults.dropAfter = true;
  assert.equal((await store.put(key, bytes, null)).acknowledgement, 'reconciled');
  delete f.faults.dropAfter; f.faults.conflict = true;
  await assert.rejects(store.put('head.json', f.objects.get('head.json'), '"wrong"'), ProtocolConflict);
});

test('three fresh Node processes reuse byte identity while fetching every current head from the authenticated boundary', async t => {
  const f = await fixture(t), model = join(f.root, 'model.json'), audit = join(f.root, 'calls.jsonl');
  await writeFile(model, canonical({ policy: f.policy, objects: Object.fromEntries([...f.objects].map(([key, bytes]) => [key, bytes.toString('base64')])) }), { mode: 0o600 });
  const script = `
    import { appendFile, readFile } from 'node:fs/promises';
    import { protectedStore, readProtectedJournal } from ${JSON.stringify(new URL('./protected-store.mjs', import.meta.url).href)};
    import { protocolPolicy, requestBuilders } from ${JSON.stringify(new URL('./provider-protocol-builders.mjs', import.meta.url).href)};
    const [modelPath, cachePath, auditPath] = process.argv.slice(1), model = JSON.parse(await readFile(modelPath));
    const policy = protocolPolicy(model.policy), client = { builders: requestBuilders(policy), send: async request => {
      const key = new URL(request.url).pathname.slice(policy.store.prefix.length + 2);
      await appendFile(auditPath, JSON.stringify({key,method:request.method}) + '\\n', {mode:0o600});
      const bytes = Buffer.from(model.objects[key], 'base64');
      return {status:200,complete:true,headers:{'content-length':String(bytes.length),etag:JSON.stringify('synthetic-version'),
        'x-amz-server-side-encryption':'aws:kms','x-amz-server-side-encryption-aws-kms-key-id':policy.store.kmsKeyArn,
        'x-amz-version-id':'synthetic-version'},bodyBase64:bytes.toString('base64')};
    }};
    const store = protectedStore(client,policy,{eventCacheDirectory:cachePath}), journal = await readProtectedJournal(store);
    process.stdout.write(JSON.stringify({generation:journal.head.generation,cache:await store.cacheMeasurements()}));
  `;
  for (let run = 0; run < 3; run++) {
    const result = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, model, f.directory, audit],
        { env: { PATH: '/usr/bin:/bin', TMPDIR: f.root }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); child.once('error', reject);
      child.once('close', code => { clearTimeout(timeout); accept({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).generation, 5);
  }
  const calls = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(call => call.key === 'head.json').length, 3);
  assert.equal(calls.filter(call => call.key.startsWith('events/')).length, 5);
});

test('a valid content hash cannot bypass cached event schema or linked generation checks', async t => {
  for (const corrupt of ['schema', 'generation']) await t.test(corrupt, async t => {
    const f = await fixture(t), store = protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory });
    const before = await readProtectedJournal(store), previous = before.events[2].digest;
    const event = { schema: corrupt === 'schema' ? 'unexpected' : 'shop.protected-journal-event/v1', generation: 5, previous, state: {} };
    const identity = digest(event); await writeFile(join(f.directory, digest(f.policy), `${identity}.json`), canonical(event), { mode: 0o600 });
    f.objects.set('head.json', Buffer.from(canonical({ schema: 'shop.protected-journal-head/v1', generation: 5, eventDigest: identity })));
    await assert.rejects(readProtectedJournal(protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory })), /Malformed protected immutable event|generation gap/);
  });
});

test('replacing an initialized cache namespace with a symlink fails before local cache mutation', async t => {
  const f = await fixture(t), store = protectedStore(f.client, f.policy, { eventCacheDirectory: f.directory });
  await readProtectedJournal(store);
  const root = join(f.directory, digest(f.policy)), outside = join(f.root, 'outside'); await mkdir(outside, { mode: 0o700 });
  await rename(root, `${root}-original`); await symlink(outside, root);
  const event = { schema: 'shop.protected-journal-event/v1', generation: 1, previous: null, state: {} };
  await assert.rejects(store.put(`events/${digest(event)}.json`, Buffer.from(canonical(event)), null), /private event cache directory/);
  await assert.rejects(access(join(outside, '.write-lock')), { code: 'ENOENT' });
});
