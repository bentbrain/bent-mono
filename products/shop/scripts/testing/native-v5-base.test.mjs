import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrieveNativeBaseOci } from './native-v5-base.mjs';
import { sha256 } from '../release-v2/data.mjs';

const pinnedManifest = await readFile(new URL('./native-v5-base.fixture.json', import.meta.url));
test('base retrieval binds the actual public registry manifest and stops on unavailable original blobs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-base-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  await assert.rejects(retrieveNativeBaseOci(join(root, 'base'), { send: async (url, options) => {
    calls.push({ url, options }); return calls.length === 1 ? new Response(pinnedManifest, { status: 200 }) : new Response(null, { status: 503 });
  } }), /registry read failed/);
  assert.equal(calls.length, 2); assert.match(calls[0].url, /^https:\/\/mcr\.microsoft\.com\/v2\/playwright\/manifests\/sha256:[a-f0-9]{64}$/);
  assert.match(calls[1].url, /^https:\/\/mcr\.microsoft\.com\/v2\/playwright\/blobs\/sha256:[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(call => Object.keys(call.options.headers)), [['accept'], ['accept']]);
  assert.deepEqual(await readdir(join(root, 'base/blobs/sha256')), [sha256(pinnedManifest)]);
});
test('base retrieval rejects digest substitution and off-origin redirect before writing', async () => {
  await assert.rejects(retrieveNativeBaseOci('/unused-source-fixture', { send: async () => new Response('{}') }), /manifest\/config differs/);
  let calls = 0;
  await assert.rejects(retrieveNativeBaseOci('/unused-source-fixture', { send: async () => { calls++; return new Response(null, { status: 307, headers: { location: 'https://other.invalid/blob' } }); } }), /origin differs/);
  assert.equal(calls, 1);
  await assert.rejects(retrieveNativeBaseOci('/unused-source-fixture', { send: async () => new Response(Buffer.alloc(1024 * 1024 + 1)) }), /manifest exceeds bound/);
});
