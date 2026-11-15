import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, sha256 } from './data.mjs';
import { protocolPolicy, assetManifest } from './provider-protocol-builders.mjs';
import { createRetainedAssetResolver } from './custody-observations.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { hostedProtocolFixture } from './testing/hosted-protocol-service.mjs';

function workPolicy() {
  const fixture = protocolFixture();
  return protocolPolicy({ ...fixture.policy, workInventory: { databaseId: '00000000-0000-4000-8000-000000000000', queries: ['product-images', 'story-video', 'print-assets'].map(family => ({ family, component: 'native', sql: `SELECT artifact_digest AS artifactDigest, format FROM accepted_jobs WHERE status IN ('accepted','running','retry') AND format='${family}-v1'` })) } });
}

test('default accepted-work adapter signs real D1 request bytes and observes every installed family', async () => {
  const policy = workPolicy(), service = await hostedProtocolFixture({ policy, targets: [], realCredentials: true });
  try {
    for (const family of ['product-images', 'story-video', 'print-assets']) service.workDb.prepare('INSERT INTO accepted_jobs VALUES(?,?,?,?)').run('native', 'a'.repeat(64), `${family}-v1`, 'accepted');
    const result = await service.broker.workInventory(); assert.equal(result.complete, true); assert.equal(result.jobs.length, 3); assert.equal(result.queryDigest, digest(policy.workInventory));
    assert.deepEqual((await service.broker.workInventory()).jobs, result.jobs);
    assert.equal(service.transcript.filter(item => item.url.endsWith('/query')).length, 6);
    for (const sql of ['SELECT artifactDigest,format FROM accepted_jobs LIMIT 1', 'SELECT artifactDigest,format FROM accepted_jobs; DELETE FROM accepted_jobs', 'SELECT artifactDigest,format FROM accepted_jobs -- hidden']) assert.throws(() => protocolPolicy({ ...policy, workInventory: { ...policy.workInventory, queries: policy.workInventory.queries.map((item,index) => index ? item : { ...item, sql }) } }), /SELECT/);
  } finally { await service.close(); }
});

test('default custody asset resolver reads the full exact retained manifest and rejects changed or missing bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'custody-assets-')), bytes = Buffer.from('<main>retained</main>');
  try {
    await mkdir(join(directory, 'assets')); await writeFile(join(directory, 'assets/index.html'), bytes);
    const assets = [{ path: 'index.html', type: 'text/html', bytes }], manifestDigest = digest(assetManifest(assets).manifest);
    const resolve = createRetainedAssetResolver({ bundle: directory, entries: [{ resource: 'worker', manifestDigest, assets: [{ name: 'index.html', type: 'text/html', ref: { path: 'assets/index.html', sha256: sha256(bytes), bytes: bytes.length } }] }] });
    assert.deepEqual(await resolve({ resource: 'worker', manifestDigest }), assets); await assert.rejects(resolve({ resource: 'different', manifestDigest }), /catalog/);
    await writeFile(join(directory, 'assets/index.html'), 'changed'); await assert.rejects(resolve({ resource: 'worker', manifestDigest }), /bytes|digest|identity|differs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
