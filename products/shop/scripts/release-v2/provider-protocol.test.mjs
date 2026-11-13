import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, parseJSON, sha256 } from './data.mjs';
import { protocolPolicy, assetManifest, requestBuilders, protocolClient, ProtocolConflict, UncertainWrite, verifyWorkerReadback, responseBytes, verifyLambdaQualified, lambdaBindingProjection, assertLambdaBinding, verifyWorkerBindings } from './provider-protocol.mjs';
import { requestDigest } from './signing.mjs';
import { appendProtectedJournal, readProtectedJournal, protectedStore, recoverReportingOnly } from './protected-store.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { loopbackProtocolTransport, protocolTranscriptService, transcriptSigner } from './testing/provider-protocol-service.mjs';

async function scenario(work, options = {}) {
  const fixture = protocolFixture(), faults = options.faults ?? {}, service = await protocolTranscriptService({ policy: fixture.policy, assets: fixture.assets, metadata: fixture.metadata, faults });
  const identity = transcriptSigner(fixture.policy, options.transform), client = protocolClient({ policy: fixture.policy, ...identity, transport: loopbackProtocolTransport(service.origin) });
  try { return await work({ ...fixture, service, faults, client, ...identity }); } finally { await service.close(); }
}
const uploadFor = fixture => ({ entrypoint: 'index.js', metadata: { ...fixture.metadata, assets: { ...fixture.metadata.assets, jwt: 'completion.session.token' } }, modules: fixture.modules, expectedInventory: fixture.expectedInventory });
const response = (value, extra = {}) => { const bytes = Buffer.from(canonical(value)); return { status: 200, complete: true, headers: { 'content-length': String(bytes.length) }, bodyBase64: bytes.toString('base64'), ...extra }; };

test('dedicated executable exercises production serialization and socket-level uncertain acknowledgements', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'shop-protocol-cli-'))), output = join(directory, 'evidence');
  try {
    const executable = fileURLToPath(new URL('./testing/provider-protocol-transcript.mjs', import.meta.url));
    const result = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [executable, '--output', output], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); child.on('error', reject);
      child.on('close', code => { clearTimeout(timeout); accept({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, result.stderr);
    const summary = parseJSON(await readFile(join(output, 'summary.private.json'))), transcript = parseJSON(await readFile(join(output, 'transcript.private.json')));
    assert.equal(summary.cloudQualified, false); assert.equal(summary.requests, transcript.length); assert.equal(summary.moduleParts, 4);
    assert.equal(summary.noMutationReplay, true); assert.equal(summary.reportingRecoveryReadOnly, true);
    assert.equal((await stat(join(output, 'transcript.private.json'))).mode & 0o077, 0);
    const versionUpload = transcript.find(record => record.method === 'POST' && record.url.endsWith('/versions'));
    assert.equal(versionUpload.parts.length, 4); assert(versionUpload.parts.some(part => part.name === 'index.js.map')); assert(versionUpload.parts.some(part => part.name === 'renderer.wasm'));
    assert.equal(transcript.filter(record => record.method === 'POST' && new URL(record.url).origin === 'https://api.github.com').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('protocol policies have exact origins, resource allowlists and no endpoint override', () => {
  const fixture = protocolFixture(), builders = requestBuilders(fixture.policy), changed = structuredClone(fixture.policy);
  assert.throws(() => protocolPolicy({ ...changed, endpoint: 'https://example.com' }), /fields/);
  assert.throws(() => protocolPolicy({ ...changed, region: 'us-east-1' }), /policy/);
  assert.throws(() => protocolPolicy({ ...changed, store: { ...changed.store, prefix: 'journal name' } }), /URL-safe/);
  assert.throws(() => protocolPolicy({ ...changed, functions: [{ ...changed.functions[0], imageRepository: '000000000001.dkr.ecr.ap-southeast-2.amazonaws.com/other' }] }), /same-account/);
  assert.throws(() => builders.reportSuccess('999', 'a'.repeat(64)), /allowlist/);
  assert.throws(() => builders.storeGet('../head.json'), /relative path/);
  assert.throws(() => builders.storePut('events/' + 'a'.repeat(64) + '.json', Buffer.from('{}'), '"previous"'), /create-only/);
  assert.throws(() => builders.lambdaActivate(fixture.functionName, 'active', '$LATEST', 'revision'), /qualified numbered/);
  assert.throws(() => builders.lambdaActivate(fixture.functionName, 'other', '7', 'revision'), /allowlist/);
  assert.throws(() => builders.lambdaCreateAlias(fixture.functionName, 'other', '7'), /allowlist/);
  assert.throws(() => builders.lambdaCreateAlias(fixture.functionName, 'active', '$LATEST'), /qualified numbered/);
  assert.deepEqual(parseJSON(Buffer.from(builders.lambdaCreateAlias(fixture.functionName, 'active', '7').bodyBase64, 'base64')), { Name: 'active', FunctionVersion: '7', RoutingConfig: { AdditionalVersionWeights: {} } });
  const request = builders.lambdaUpload(fixture.functionName, 'a'.repeat(64), 'revision');
  assert.equal(new URL(request.url).origin, 'https://lambda.ap-southeast-2.amazonaws.com');
  assert.deepEqual(parseJSON(Buffer.from(request.bodyBase64, 'base64')), { ImageUri: `${changed.functions[0].imageRepository}@sha256:${'a'.repeat(64)}`, Publish: true, RevisionId: 'revision' });
});

test('complete module/map inventory and protected binding metadata are mandatory', async () => {
  const fixture = protocolFixture(), builders = requestBuilders(fixture.policy), upload = uploadFor(fixture);
  const request = builders.workerUpload(fixture.worker, upload), multipart = await new Response(Buffer.from(request.bodyBase64, 'base64'), { headers: { 'content-type': request.headers['content-type'] } }).formData();
  assert.deepEqual([...multipart.keys()].sort(), ['metadata', ...fixture.modules.map(part => part.name)].sort());
  assert.throws(() => builders.workerUpload(fixture.worker, { ...upload, modules: fixture.modules.filter(part => !part.name.endsWith('.map')) }), /complete inventory/);
  assert.throws(() => builders.workerUpload(fixture.worker, { ...upload, modules: [...fixture.modules, fixture.modules[0]] }), /Duplicate/);
  assert.throws(() => builders.workerUpload(fixture.worker, { ...upload, metadata: { ...upload.metadata, compatibility_date: '2026-11-02' } }), /protected policy/);
  assert.throws(() => builders.workerUpload(fixture.worker, { ...upload, metadata: { ...upload.metadata, assets: { ...upload.metadata.assets, jwt: 'bad' } } }), /completion JWT/);
  const changed = structuredClone(fixture.expectedInventory); changed[0].sha256 = 'f'.repeat(64);
  assert.throws(() => builders.workerUpload(fixture.worker, { ...upload, expectedInventory: changed }), /complete inventory/);
});

test('signing rejects changed payload, origin, policy, credential scope, expiry and key before dispatch', async () => {
  const mutations = [
    value => ({ ...value, signature: Buffer.alloc(64).toString('base64') }),
    value => ({ ...value, keyId: 'untrusted' }),
    value => ({ ...value, payload: { ...value.payload, requestDigest: 'f'.repeat(64) } }),
    value => ({ ...value, payload: { ...value.payload, policyDigest: 'e'.repeat(64) } }),
    value => ({ ...value, payload: { ...value.payload, expiresAt: value.payload.issuedAt - 1 } }),
    value => ({ ...value, credentialHeaders: { ...value.credentialHeaders, host: 'evil.example' } }),
    value => ({ ...value, credentialHeaders: { ...value.credentialHeaders, 'x-amz-content-sha256': '0'.repeat(64) } }),
    value => ({ ...value, credentialHeaders: { ...value.credentialHeaders, authorization: value.credentialHeaders.authorization.replace('/lambda/', '/sts/') } })
  ];
  for (const transform of mutations) await scenario(async ({ client, functionName, service }) => {
    await assert.rejects(client.send(client.builders.lambdaUpload(functionName, 'a'.repeat(64), 'revision')));
    assert.equal(service.transcript.length, 0);
  }, { transform });
  await scenario(async ({ client, worker, service }) => {
    const request = client.builders.workerDeployments(worker);
    await assert.rejects(client.send({ ...request, url: 'https://evil.example' }), /protected policy builder/);
    assert.equal(service.transcript.length, 0);
    assert.notEqual(requestDigest(request), requestDigest({ ...request, url: 'https://evil.example' }));
  });
});

test('inventories distinguish active from latest and reject truncation', async () => {
  await scenario(async ({ client, worker, functionName }) => {
    const workers = await client.workerInventory(worker), functions = await client.lambdaInventory(functionName);
    assert.equal(workers.versions.length, 101); assert.equal(await client.workerActive(worker), workers.versions[2].id);
    assert.notEqual(await client.workerActive(worker), workers.versions.at(-1).id);
    assert.equal((await client.lambdaActive(functionName, 'active')).FunctionVersion, '7'); assert.equal(functions.versions.at(-1).Version, '9');
  });
  await scenario(async ({ client, worker }) => assert.rejects(client.workerInventory(worker), /truncated/), { faults: { truncateInventory: true } });
  await scenario(async ({ client, worker, service }) => { assert.equal((await client.workerInventory(worker)).versions.length, 101); assert.equal(service.transcript.length, 3); }, { faults: { noInventoryInfo: true } });
});

test('Lambda 412 and conditional store CAS never replay the failed mutation', async () => {
  await scenario(async ({ client, functionName, policy, service }) => {
    await assert.rejects(client.send(client.builders.lambdaActivate(functionName, 'active', '9', 'stale-revision')), ProtocolConflict);
    assert.equal(service.transcript.filter(record => record.method === 'PUT').length, 1);
    const store = protectedStore(client, policy), a = await appendProtectedJournal(store, null, { phase: 'admitted' });
    const b = await appendProtectedJournal(store, a, { phase: 'intent' });
    await assert.rejects(appendProtectedJournal(store, a, { phase: 'other' }), /CAS observation changed/);
    assert.equal((await readProtectedJournal(store)).head.eventDigest, b.head.eventDigest);
    await assert.rejects(store.put('head.json', Buffer.from('{}'), a.etag), ProtocolConflict);
  });
});

test('uncertain S3 acknowledgements reconcile present bytes and hold absent bytes without replay', async () => {
  await scenario(async ({ client, policy, faults, service }) => {
    const store = protectedStore(client, policy), first = await appendProtectedJournal(store, null, { phase: 'admitted' });
    faults.dropStoreAfter = 'head.json'; const second = await appendProtectedJournal(store, first, { phase: 'intent' });
    assert.equal(second.head.generation, 2);
    assert.equal(service.transcript.filter(record => record.method === 'PUT' && record.url.endsWith('/head.json')).length, 2);
    const key = `events/${'f'.repeat(64)}.json`; faults.dropStoreBefore = key;
    await assert.rejects(store.put(key, Buffer.from('{}'), null), UncertainWrite);
    assert.equal(service.transcript.filter(record => record.method === 'PUT' && record.url.endsWith(key)).length, 1);
  });
});

test('immutable journal replay rejects missing and changed historical events', async () => {
  await scenario(async ({ client, policy, service }) => {
    const store = protectedStore(client, policy), first = await appendProtectedJournal(store, null, { phase: 'one' });
    await appendProtectedJournal(store, first, { phase: 'two' });
    const key = `events/${first.head.eventDigest}.json`, original = service.objects.get(key);
    service.objects.set(key, { ...original, bytes: Buffer.from('{}') });
    await assert.rejects(readProtectedJournal(store), /immutable event bytes differ/);
    service.objects.delete(key); await assert.rejects(readProtectedJournal(store), /immutable event is missing/);
  });
});

test('report recovery requires immutable verification evidence and performs GET only', async () => {
  await scenario(async ({ client, policy, service }) => {
    const store = protectedStore(client, policy), verifiedState = { phase: 'runtime-verified', verification: { version: '7' }, lastVerified: { version: '7' } };
    const verified = await appendProtectedJournal(store, null, verifiedState);
    const outbox = await appendProtectedJournal(store, verified, { ...verifiedState, phase: 'report-reconcile', report: { eventDigest: verified.head.eventDigest, compositionDigest: digest(verifiedState.lastVerified), verificationDigest: digest(verifiedState.verification) } });
    const before = service.transcript.filter(record => record.method !== 'GET').length;
    assert.equal((await recoverReportingOnly({ client, store, deploymentId: '123' })).status, 'held');
    assert.equal(service.transcript.filter(record => record.method !== 'GET').length, before);
    await appendProtectedJournal(store, outbox, { ...outbox.state, report: { ...outbox.state.report, eventDigest: 'e'.repeat(64) } });
    await assert.rejects(recoverReportingOnly({ client, store, deploymentId: '123' }), /immutable runtime verification/);
  });
});

test('response framing rejects truncated, ambiguous and oversized responses', () => {
  assert.throws(() => responseBytes(response({}, { complete: false })), /Incomplete/);
  assert.throws(() => responseBytes(response({}, { headers: { 'content-length': '99' } })), /Truncated/);
  assert.throws(() => responseBytes(response({}, { bodyBase64: 'ew' })), /Ambiguous/);
  assert.throws(() => responseBytes(response({}, { headers: { Location: 'https://example.com' } })), /headers/);
});

test('content readback includes every binary module and source map', async () => {
  await scenario(async fixture => {
    const upload = uploadFor(fixture), request = fixture.client.builders.workerUpload(fixture.worker, upload);
    await fixture.client.json(request);
    const content = await fixture.client.send(fixture.client.builders.workerContent(fixture.worker));
    assert.deepEqual(await verifyWorkerReadback(content, upload), fixture.expectedInventory);
    await assert.rejects(verifyWorkerReadback(content, { ...upload, expectedInventory: fixture.expectedInventory.slice(1) }), /readback differs/);
  });
});


test('simultaneous journal writers have one conditional CAS winner', async () => {
  await scenario(async ({ client, policy, service }) => {
    const store = protectedStore(client, policy), first = await appendProtectedJournal(store, null, { phase: 'start' });
    const results = await Promise.allSettled([appendProtectedJournal(store, first, { phase: 'writer-a' }), appendProtectedJournal(store, first, { phase: 'writer-b' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await readProtectedJournal(store)).head.generation, 2);
    assert.equal(service.transcript.filter(record => record.method === 'PUT' && record.url.endsWith('/head.json')).length, 3);
  });
});

test('crash before head leaves an immutable orphan and repeated uncertain writes remain held', async () => {
  await scenario(async ({ client, policy, faults, service }) => {
    const store = protectedStore(client, policy); faults.dropStoreBefore = 'head.json';
    await assert.rejects(appendProtectedJournal(store, null, { phase: 'intent' }), UncertainWrite);
    assert.equal(await readProtectedJournal(store), null);
    assert.equal([...service.objects.keys()].filter(key => key.startsWith('events/')).length, 1);
    const mutations = service.transcript.filter(record => record.method === 'PUT').length;
    await assert.rejects(appendProtectedJournal(store, null, { phase: 'intent' }), /mutation replay refused/);
    assert.equal(service.transcript.filter(record => record.method === 'PUT').length, mutations);
  });
});


test('qualified Lambda readback verifies exact code digest and complete target binding projection', async () => {
  await scenario(async ({ client, policy, functionName }) => {
    const response = await client.json(client.builders.lambdaFunction(functionName, '9'));
    const expectedBinding = lambdaBindingProjection({ Architectures: ['x86_64'], MemorySize: 3008, Timeout: 120, Role: `arn:aws:iam::${policy.awsAccountId}:role/protocol-synthetic-runtime`, EphemeralStorage: { Size: 1024 }, Environment: { Variables: { STORY_BUILD_ID: 'b'.repeat(64) } } });
    const expected = { policy, name: functionName, version: '9', imageDigest: 'a'.repeat(64), expectedBinding };
    assert.equal(verifyLambdaQualified(response, expected).version, '9');
    assert.throws(() => verifyLambdaQualified({ ...response, Configuration: { ...response.Configuration, Version: '$LATEST' } }, expected), /code identity/);
    assert.throws(() => verifyLambdaQualified({ ...response, Code: { ...response.Code, ResolvedImageUri: response.Code.ResolvedImageUri.replace(/a{64}$/, 'f'.repeat(64)) } }, expected), /resolved image/);
    assert.throws(() => verifyLambdaQualified({ ...response, Configuration: { ...response.Configuration, MemorySize: 128 } }, expected), /target bindings/);
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bindings = [{ type: 'assets', name: 'ASSETS' }], runtime = { compatibility_date: '2026-11-01', compatibility_flags: ['nodejs_compat'] };
    assert.equal(verifyWorkerBindings({ success: true, result: { id, resources: { bindings, script_runtime: runtime } } }, { version: id, bindings, runtime }).version, id);
    assert.throws(() => verifyWorkerBindings({ success: true, result: { id, resources: { bindings: [], script_runtime: runtime } } }, { version: id, bindings, runtime }), /bindings differ/);
  });
});


test('GitHub pagination follows only the fixed repository continuation and rejects truncated framing', async () => {
  await scenario(async ({ client, service, faults }) => {
    service.reports.push(...Array.from({ length: 101 }, (_, id) => ({ id: id + 1, state: 'success' })));
    assert.equal((await client.reportInventory('123')).records.length, 101);
    faults.badReportNext = true; await assert.rejects(client.reportInventory('123'), /continuation origin/); delete faults.badReportNext;
    faults.omitReportNext = true; await assert.rejects(client.reportInventory('123'), /continuation evidence/); delete faults.omitReportNext;
    faults.truncateResponse = true; await assert.rejects(client.reportInventory('123'), /truncated|aborted|reset/i);
    assert(service.transcript.every(record => !record.url.includes('evil.example')));
  });
});

test('lost Worker version POST acknowledgement cannot be replayed by the same client', async () => {
  await scenario(async fixture => {
    const request = fixture.client.builders.workerUpload(fixture.worker, uploadFor(fixture));
    await assert.rejects(fixture.client.send(request), UncertainWrite);
    await assert.rejects(fixture.client.send(fixture.client.builders.workerUpload(fixture.worker, uploadFor(fixture))), /mutation replay refused/);
    assert.equal(fixture.service.transcript.filter(record => record.method === 'POST').length, 1);
  }, { faults: { dropWorkerAfter: true } });
});


test('source-map readback accepts complete equivalent JSON while preserving all map data', async () => {
  await scenario(async fixture => {
    const upload = uploadFor(fixture); await fixture.client.json(fixture.client.builders.workerUpload(fixture.worker, upload));
    fixture.faults.mapWhitespace = true;
    const content = await fixture.client.send(fixture.client.builders.workerContent(fixture.worker));
    const actual = await verifyWorkerReadback(content, upload), map = actual.find(part => part.name.endsWith('.map')), expectedMap = fixture.expectedInventory.find(part => part.name.endsWith('.map'));
    assert.notEqual(map.sha256, expectedMap.sha256); assert.equal(map.sourceMapDataSha256, expectedMap.sourceMapDataSha256);
    const changed = structuredClone(fixture.expectedInventory); changed.find(part => part.name.endsWith('.map')).sourceMapDataSha256 = 'f'.repeat(64);
    await assert.rejects(verifyWorkerReadback(content, { ...upload, expectedInventory: changed }), /map readback differs/);
  });
});


test('static asset hashes use the filename extension and consistent deduplicated content types', () => {
  const bytes = Buffer.from('same bytes'), files = [{ path: 'directory.ext/file', type: 'text/plain', bytes }, { path: 'other/file', type: 'text/plain', bytes }];
  const manifest = assetManifest(files);
  assert.equal(manifest.inventory[0].hash, sha256(bytes.toString('base64')).slice(0, 32));
  assert.equal(manifest.inventory[0].hash, manifest.inventory[1].hash);
  assert.throws(() => assetManifest([files[0], { ...files[1], type: 'text/html' }]), /Conflicting asset hash/);
});

test('Worker binding order is immaterial while duplicates, changed targets and nested data remain exact', () => {
  const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', runtime = { compatibility_date: '2026-11-01' };
  const bindings = [{ name: 'ASSETS', type: 'assets' }, { name: 'API', type: 'service', service: 'synthetic-business', environment: 'preview' }];
  const readback = values => ({ success: true, result: { id: version, resources: { bindings: values, script_runtime: runtime } } });
  const first = verifyWorkerBindings(readback(bindings), { version, bindings, runtime });
  assert.deepEqual(verifyWorkerBindings(readback([...bindings].reverse()), { version, bindings, runtime }), first);
  assert.throws(() => verifyWorkerBindings(readback([bindings[0], bindings[0]]), { version, bindings, runtime }), /Duplicate/);
  assert.throws(() => verifyWorkerBindings(readback([bindings[0], { ...bindings[1], service: 'different' }]), { version, bindings, runtime }), /bindings differ/);
  assert.throws(() => verifyWorkerBindings(readback([bindings[0], { ...bindings[1], extra: 'changed' }]), { version, bindings, runtime }), /bindings differ/);
});


test('qualified Lambda bindings require every field and typed nested values before readback', () => {
  const { policy } = protocolFixture();
  const binding = lambdaBindingProjection({ Architectures: ['arm64'], MemorySize: 1024, Timeout: 60,
    Role: `arn:aws:iam::${policy.awsAccountId}:role/path/runtime`, EphemeralStorage: { Size: 1024 },
    Environment: { Variables: { MODE: 'synthetic' } }, ImageConfigResponse: { ImageConfig: { Command: ['index.handler'], EntryPoint: [], WorkingDirectory: '/var/task' } },
    VpcConfig: { SubnetIds: [], SecurityGroupIds: [], VpcId: '', Ipv6AllowedForDualStack: false }, FileSystemConfigs: [], Layers: [],
    DeadLetterConfig: {}, LoggingConfig: { LogFormat: 'JSON', SystemLogLevel: 'INFO' }, TracingConfig: { Mode: 'Active' }, SnapStart: { ApplyOn: 'None', OptimizationStatus: 'Off' } });
  assert.deepEqual(assertLambdaBinding(binding, policy), binding);
  for (const key of Object.keys(binding)) { const missing = { ...binding }; delete missing[key]; assert.throws(() => assertLambdaBinding(missing, policy), /binding contract/); }
  for (const patch of [{ Architectures: [] }, { EphemeralStorage: { Size: 0 } }, { Layers: [{ Arn: false }] }, { TracingConfig: { Mode: 'unknown' } },
    { ImageConfigResponse: { ImageConfig: { Command: 'index.handler' } } }, { Runtime: {} }, { Environment: { Error: {} } }]) assert.throws(() => assertLambdaBinding({ ...binding, ...patch }, policy), /binding contract/);
});
