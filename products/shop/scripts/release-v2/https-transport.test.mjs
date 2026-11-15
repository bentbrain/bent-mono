import assert from 'node:assert/strict';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createHttpsTransport, validateDispatchTarget } from './https-transport.mjs';
import { authorizeRequest } from './signing.mjs';
import { assetManifest, protocolPolicy, requestBuilders } from './provider-protocol-builders.mjs';
import { digest, sha256 } from './data.mjs';
import { nativeProbeFamilies } from './native-qualification-policy.mjs';
import { responseBytes } from './provider-protocol.mjs';
import { transcriptSigner } from './testing/provider-protocol-service.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';

async function authorized(policy, request) { const identity = transcriptSigner(policy); return authorizeRequest({ policy, request, ...identity }); }

function completeRequests() {
  const fixture = protocolFixture(), base = fixture.policy, main = fixture.functionName, failure = 'serving-failure';
  const uuid = '00000000-0000-4000-8000-000000000005', databaseId = '00000000-0000-4000-8000-000000000009';
  const isolated = ['isolated-main', 'isolated-failure'], payload = { probe: 'synthetic' };
  const metadata = { main_module: 'index.mjs', compatibility_date: '2026-11-01', bindings: [{ name: 'SHOP_NATIVE_SERVING_TARGET_JSON', type: 'plain_text', text: '$nativeServingTarget' }] };
  const policy = protocolPolicy({ ...base,
    workers: [{ ...base.workers[0], versionContentApi: 'workers-beta/v1' }, { name: 'serving-business', metadataDigest: digest(metadata), nativeServingMetadata: 'native-serving/v1' }],
    functions: [...base.functions, ...[failure, ...isolated].map(name => ({ ...base.functions[0], name }))],
    github: { repository: base.github.repository, environment: base.github.environment, reporting: 'per-release' },
    workInventory: { databaseId, queries: ['print-assets', 'product-images', 'story-video'].map(family => ({ family, component: 'native', sql: 'SELECT artifactDigest, format FROM jobs' })) },
    nativeQualification: { schema: 'shop.native-qualification-policy/v1', executionScope: 'aws/provider',
      resources: isolated.map((name, index) => ({ name, bindingDigest: 'a'.repeat(64), concurrency: 2,
        eventInvokeConfig: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 0, DestinationConfig: {} },
        eventSourceMapping: index === 0 ? null : { id: uuid, digest: 'b'.repeat(64), restoreFunctionArn: `arn:aws:lambda:${base.region}:${base.awsAccountId}:function:${name}:1` } })),
      probes: nativeProbeFamilies.map(family => ({ id: `probe-${family}`, family, resource: isolated[0], invocationType: 'Event', payloadDigest: digest(payload),
        observation: { databaseId, sql: 'SELECT outcome FROM native_proofs', params: [], expectedRows: [{ ok: true }] } })),
      fixtureLifecycle: { schema: 'shop.native-fixture-policy/v1', databaseId, artworkBucket: 'synthetic-artwork', videoBucket: 'synthetic-video',
        templateDigest: sha256('template'), grantKey: { id: 'fixture-key', version: 'one', secretSha256: sha256('synthetic-key') } } },
    nativeServing: { schema: 'shop.native-serving-policy/v1', component: 'native', businessComponent: 'business', environment: 'development', mainResource: main, failureResource: failure,
      failureMapping: { id: '00000000-0000-4000-8000-000000000006', eventSourceArn: `arn:aws:sqs:${base.region}:${base.awsAccountId}:serving-failures`,
        configuration: { UUID: '00000000-0000-4000-8000-000000000006', EventSourceArn: `arn:aws:sqs:${base.region}:${base.awsAccountId}:serving-failures`, BatchSize: 10 },
        initialFunctionArn: `arn:aws:lambda:${base.region}:${base.awsAccountId}:function:${failure}:1` }, grantKeyId: 'serving-key' } });
  const b = requestBuilders(policy), hash = sha256('fixture'), key = `designs/${uuid}/artwork/${hash}`, probe = policy.nativeQualification.probes[0].id;
  const module = { name: 'index.mjs', type: 'application/javascript+module', bytes: Buffer.from('export default {};') };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json' }));
  const requests = {
    nativeFixtureQuery: b.nativeFixtureQuery('deleteMarker', [uuid, 'run']),
    nativeFixtureObjectGet: b.nativeFixtureObjectGet('synthetic-artwork', key), nativeFixtureObjectPut: b.nativeFixtureObjectPut('synthetic-artwork', key, Buffer.from('fixture')),
    nativeFixtureObjectDelete: b.nativeFixtureObjectDelete('synthetic-artwork', key), servingConfigure: b.servingConfigure(main, { Variables: { STORY_BUILD_ID: hash } }, 'revision'),
    servingEventMapping: b.servingEventMapping(), servingUpdateMapping: b.servingUpdateMapping('2'), nativeConcurrency: b.nativeConcurrency(isolated[0]),
    nativeEventConfig: b.nativeEventConfig(isolated[0]), nativeEventMapping: b.nativeEventMapping(isolated[1]), nativeUpdateMapping: b.nativeUpdateMapping(isolated[1], '2'),
    nativeInvoke: b.nativeInvoke(probe, '2', payload), nativeObservation: b.nativeObservation(probe), nativeDeleteVersion: b.nativeDeleteVersion(isolated[0], '2'),
    nativeRestore: b.nativeRestore(isolated[0], hash, 'revision'), ecrCheckLayers: b.ecrCheckLayers(main, [hash]), ecrInitiateLayer: b.ecrInitiateLayer(main),
    ecrUploadPart: b.ecrUploadPart(main, uuid, Buffer.from('layer'), 0), ecrCompleteLayer: b.ecrCompleteLayer(main, uuid, hash),
    ecrPutImage: b.ecrPutImage(main, manifest, sha256(manifest)), ecrGetImage: b.ecrGetImage(main, hash), workerVersions: b.workerVersions(fixture.worker),
    workerVersionContent: b.workerVersionContent(fixture.worker, uuid), workerVersion: b.workerVersion(fixture.worker, uuid), workerDeployments: b.workerDeployments(fixture.worker),
    workerSettings: b.workerSettings(fixture.worker), workerContent: b.workerContent(fixture.worker),
    workerUpload: b.workerUpload('serving-business', { entrypoint: module.name, metadata, modules: [module], expectedInventory: [{ name: module.name, type: module.type, bytes: module.bytes.length, sha256: sha256(module.bytes) }] }),
    workerActivate: b.workerActivate(fixture.worker, uuid), assetSession: b.assetSession(fixture.worker, fixture.assets),
    assetUpload: b.assetUpload(fixture.assets, assetManifest(fixture.assets).inventory.map(item => item.hash), 'synthetic.session.token'),
    lambdaVersions: b.lambdaVersions(main), lambdaFunction: b.lambdaFunction(main, '2'), lambdaLatest: b.lambdaLatest(main), lambdaAlias: b.lambdaAlias(main, 'active'),
    lambdaUpload: b.lambdaUpload(main, hash, 'revision'), lambdaActivate: b.lambdaActivate(main, 'active', '2', 'revision'), lambdaCreateAlias: b.lambdaCreateAlias(main, 'active', '2'),
    storeGet: b.storeGet('head.json'), storePut: b.storePut('head.json', Buffer.from('{}'), null), workQuery: b.workQuery(0),
    deploymentInventory: b.deploymentInventory('a'.repeat(40)), deploymentCreate: b.deploymentCreate({ head: 'a'.repeat(40), compositionDigest: hash, eventDigest: hash }),
    reportStatuses: b.reportStatuses('123'), reportSuccess: b.reportSuccess('123', hash),
  };
  assert.deepEqual(Object.keys(requests).sort(), Object.keys(b).sort(), 'Every production builder needs a transport acceptance case');
  return { policy, requests: [...Object.entries(requests), ['nativeFixtureRead', b.nativeFixtureQuery('readDesign', [uuid, 'owner'])]] };
}

test('every production builder traverses the real HTTPS validator and framing path', async () => {
  const { policy, requests } = completeRequests(), received = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, bytes: Buffer.concat(chunks) }); response.writeHead(204); response.end();
  });
  server.listen(0, '127.0.0.1'); await new Promise(accept => server.once('listening', accept));
  const loopbackAgent = new Agent({ keepAlive: true }); let networkCalls = 0;
  const transport = createHttpsTransport({ policy, networkRequest: (options, callback) => {
    networkCalls++; return httpRequest({ ...options, agent: loopbackAgent, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port }, callback);
  } });
  try {
    for (const [name, request] of requests) {
      const signed = await authorized(policy, request), count = networkCalls;
      const foreign = new URL(request.url); foreign.pathname += '/unadmitted';
      for (const patch of [{ method: request.method === 'GET' ? 'DELETE' : 'GET' }, { url: `${request.url}${request.url.includes('?') ? '&' : '?'}unexpected=1` }, { operation: 'native.unadmitted' }, { url: foreign.href }]) {
        await assert.rejects(transport({ ...signed, ...patch }), undefined, `${name} rejects altered method/query/operation`);
        assert.equal(networkCalls, count);
      }
      assert.equal((await transport(signed)).status, 204, name);
      assert.equal(received.at(-1).method, request.method); assert.equal(received.at(-1).path, new URL(request.url).pathname + new URL(request.url).search);
      assert.equal(sha256(received.at(-1).bytes), request.bodySha256);
    }
    assert.equal(networkCalls, requests.length);
    const byName = Object.fromEntries(requests);
    for (const [name, replace] of [
      ['servingConfigure', url => url.replace('protocol-synthetic-renderer', 'isolated-main')],
      ['servingUpdateMapping', url => url.replace('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000005')],
      ['nativeFixtureObjectPut', url => url.replace('synthetic-artwork', 'foreign-bucket')],
      ['nativeFixtureObjectDelete', url => url.replace(/artwork\/[a-f0-9]{64}$/, 'private-file')],
      ['workerUpload', url => url.replace('serving-business', 'protocol-synthetic-worker')],
    ]) {
      const signed = await authorized(policy, byName[name]);
      await assert.rejects(transport({ ...signed, url: replace(signed.url) }));
      assert.equal(networkCalls, requests.length, 'An otherwise allowed resource cannot acquire another operation');
    }
  } finally { transport.close(); loopbackAgent.destroy(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
});
test('HTTPS dispatch pins exact origins, resources, operations, framing and credentials before network access', async () => {
  const { policy, worker } = protocolFixture(), base = await authorized(policy, requestBuilders(policy).workerDeployments(worker));
  assert.equal(validateDispatchTarget(base, policy).url.origin, 'https://api.cloudflare.com');
  for (const patch of [{ url: 'https://evil.example/' }, { url: `${base.url}?include=secret` }, { url: `${base.url}/../../other` }, { method: 'DELETE' }, { operation: 'worker.upload' }, { headers: { ...base.headers, host: 'evil.example' } }, { headers: { ...base.headers, 'content-length': '1' } }, { headers: { ...base.headers, 'proxy-authorization': 'secret' } }, { policyDigest: 'f'.repeat(64) }]) assert.throws(() => validateDispatchTarget({ ...base, ...patch }, policy));
  const transport = createHttpsTransport({ policy, networkRequest: () => { throw Error('Network must remain untouched'); } });
  await assert.rejects(transport({ ...base, url: 'https://evil.example/' }), /origin|Cloudflare/);
});

test('production framing logic preserves cookies and rejects redirects, duplicates, truncation and bounds over actual sockets', async () => {
  const { policy, worker } = protocolFixture(), request = await authorized(policy, requestBuilders(policy).workerDeployments(worker));
  let mode = 'cookies', lastOptions;
  const server = createServer((_request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { location: 'https://evil.example/' }); response.end(); }
    else if (mode === 'duplicate') { response.writeHead(200, ['Content-Type', 'application/json', 'X-Test', 'first', 'X-Test', 'second']); response.end('{}'); }
    else if (mode === 'truncated') { response.writeHead(200, { 'content-length': '100', connection: 'close' }); response.end('{}'); }
    else if (mode === 'oversized') response.end('x'.repeat(32));
    else if (mode === 'timeout') { /* The transport deadline owns cancellation. */ }
    else { response.writeHead(200, { 'set-cookie': ['a=1; Secure', 'b=2; Secure'] }); response.write('{'); response.end('}'); }
  });
  server.listen(0, '127.0.0.1'); await new Promise(accept => server.once('listening', accept));
  const loopbackAgent = new Agent({ keepAlive: true, maxSockets: 1 });
  const networkRequest = (options, callback) => { lastOptions = options; return httpRequest({ ...options, agent: loopbackAgent, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port }, callback); };
  try {
    const transport = createHttpsTransport({ policy, timeoutMs: 1000, maximumResponseBytes: 16, networkRequest }), success = await transport(request);
    assert.equal(responseBytes(success).toString(), '{}'); assert.deepEqual(success.headers['set-cookie'], ['a=1; Secure', 'b=2; Secure']);
    assert.equal(lastOptions.rejectUnauthorized, true); assert.equal(lastOptions.minVersion, 'TLSv1.2'); assert.equal(lastOptions.agent.keepAlive, true); assert.equal(lastOptions.hostname, 'api.cloudflare.com');
    await transport(request); assert.equal(transport.measurements().reusedSockets, 1);
    for (const [next, expected] of [['redirect', /redirects/], ['duplicate', /Duplicate/], ['truncated', /truncated|aborted|reset/], ['oversized', /bound/]]) { mode = next; await assert.rejects(transport(request), expected); }
    mode = 'timeout'; await assert.rejects(createHttpsTransport({ policy, timeoutMs: 20, networkRequest })(request), /deadline/);
  } finally { loopbackAgent.destroy(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
});
