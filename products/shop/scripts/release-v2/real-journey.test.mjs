import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseJSON, sha256 } from './data.mjs';
import { realJourneyService, verifyClosure, journeyEvents } from './testing/real-journey-service.mjs';

test('actual observation JSON retains fractional browser geometry while admission JSON stays strict', () => {
  const bytes = Buffer.from('{"events":[{"operation":"direct-editor-gesture","cropX":0.4053354507181181}],"blocked":[]}');
  assert.equal(journeyEvents(bytes).events[0].cropX, 0.4053354507181181);
  assert.throws(() => parseJSON(bytes), /Ambiguous JSON number/);
  assert.throws(() => journeyEvents(Buffer.from('{"events":[]}')), /observation arrays/);
});

test('strict JSON supports a native-sized base64 string and still rejects trailing duplicate keys', () => {
  const data = 'A'.repeat(28 * 1024 * 1024);
  assert.equal(parseJSON(Buffer.from(JSON.stringify({ data, tail: 1 })), 32 * 1024 * 1024).data.length, data.length);
  assert.throws(() => parseJSON(Buffer.from(`{"data":"${data}","tail":1,"tail":2}`), 32 * 1024 * 1024), /Duplicate JSON key/);
  assert.throws(() => parseJSON(Buffer.from('{"escaped\\\"key":1,"escaped\\u0022key":2}')), /Duplicate JSON key/);
});

test('real journey service rejects stale closure, unauthorized requests, wrong subjects and nonce reuse before process execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shop-real-journey-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.mjs'), 'original');
  const identity = { scope: 'inactive-local-real-journey', awsImageQualified: false,
    executable: { path: process.execPath, sha256: sha256(await readFile(process.execPath)) },
    groups: [{ name: 'source', root, complete: true, files: [{ path: 'source.mjs', bytes: 8, sha256: sha256('original') }] }] };
  await verifyClosure(identity);
  await writeFile(join(root, 'source.mjs'), 'replaced');
  await assert.rejects(() => verifyClosure(identity), /Referenced bytes differ/);
  await writeFile(join(root, 'source.mjs'), 'original');
  await writeFile(join(root, 'unknown.mjs'), 'unknown');
  await assert.rejects(() => verifyClosure(identity), /inventory changed/);
  await rm(join(root, 'unknown.mjs'));
  const expected = { schema: 'shop.fixture-journey-request/v1', compositionDigest: 'a'.repeat(64) }, token = randomUUID();
  const output = await mkdtemp(join(tmpdir(), 'shop-real-journey-output-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const service = await realJourneyService({ identity, expected, output, checkout: root, capsule: root, token, fault: () => true });
  t.after(() => service.close());
  const request = { ...expected, nonce: randomUUID(), phase: 'candidate', evidenceRoot: '/untrusted' };
  const post = async (body, auth = token) => fetch(`${service.origin}/execute`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  assert.match((await (await post(request, 'wrong')).json()).error, /authorization/);
  assert.match((await (await post({ ...request, compositionDigest: 'b'.repeat(64) })).json()).error, /identity differs/);
  assert.equal(service.executions.size, 0);
  assert.match((await (await post(request)).json()).error, /Injected local journey failure/);
  assert.equal(service.executions.size, 1);
  assert.match((await (await post(request)).json()).error, /Fresh journey nonce/);
});
