import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from './data.mjs';
import { assetManifest, requestBuilders } from './provider-protocol-builders.mjs';
import { rehydrateProviderRequest } from './request-rehydration.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';

test('custody reconstructs exact production serialization for every admitted provider operation', async () => {
  const f = protocolFixture(), b = requestBuilders(f.policy), uuid = '00000001-0000-4000-8000-000000000000';
  const requests = [b.storeGet('head.json'), b.storePut('head.json', Buffer.from('{}'), '"old-head"'), b.workerVersions(f.worker, 2), b.workerVersion(f.worker, uuid), b.workerDeployments(f.worker), b.workerSettings(f.worker), b.workerContent(f.worker), b.workerUpload(f.worker, { entrypoint: 'index.js', metadata: f.metadata, modules: f.modules, expectedInventory: f.expectedInventory }), b.workerActivate(f.worker, uuid), b.assetSession(f.worker, f.assets), b.assetUpload(f.assets, [...new Set(assetManifest(f.assets).inventory.map(item => item.hash))], 'synthetic.jwt.token')];
  requests.push(b.lambdaVersions(f.functionName, 'synthetic-marker'), b.lambdaFunction(f.functionName, '7'), b.lambdaLatest(f.functionName), b.lambdaAlias(f.functionName, 'active'), b.lambdaUpload(f.functionName, 'a'.repeat(64), 'revision-1'), b.lambdaActivate(f.functionName, 'active', '7', 'revision-2'), b.reportStatuses('123', 2), b.reportSuccess('123', 'a'.repeat(64)));
  for (const request of requests) assert.equal(digest(await rehydrateProviderRequest(structuredClone(request), { policy: f.policy, assets: f.assets })), digest(request));
});

test('custody rejects endpoint, framing, policy and protected multipart mutations before signing', async () => {
  const f = protocolFixture(), b = requestBuilders(f.policy), valid = b.workerUpload(f.worker, { entrypoint: 'index.js', metadata: f.metadata, modules: f.modules, expectedInventory: f.expectedInventory });
  for (const change of [{ url: valid.url.replace('api.cloudflare.com', 'example.com') }, { policyDigest: 'f'.repeat(64) }, { headers: { ...valid.headers, 'x-unadmitted': 'yes' } }, { bodySha256: 'f'.repeat(64) }, { operation: 'worker.activate' }]) await assert.rejects(rehydrateProviderRequest({ ...structuredClone(valid), ...change }, { policy: f.policy }), /Custody|Worker|version|metadata|Unexpected|JSON/);
});
