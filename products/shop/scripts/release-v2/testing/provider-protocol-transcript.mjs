import assert from 'node:assert/strict';
import { mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, check, digest, sha256 } from '../data.mjs';
import { protocolPolicy, protocolClient, assetManifest, ProtocolConflict, UncertainWrite, verifyWorkerReadback, verifyLambdaQualified, lambdaBindingProjection, verifyWorkerBindings } from '../provider-protocol.mjs';
import { protectedStore, readProtectedJournal, appendProtectedJournal, reconcileProtectedJournal, recoverReportingOnly } from '../protected-store.mjs';
import { fixtureEnvironment } from '../provider.mjs';
import { protocolTranscriptService, loopbackProtocolTransport, transcriptSigner } from './provider-protocol-service.mjs';

export function protocolFixture() {
  const metadata = { main_module: 'index.js', compatibility_date: '2026-11-01', compatibility_flags: ['nodejs_compat'], bindings: [{ name: 'ASSETS', type: 'assets' }], assets: { config: { html_handling: 'auto-trailing-slash' } } };
  const modules = [
    { name: 'index.js', type: 'application/javascript+module', bytes: Buffer.from("import route from './chunks/route.js'; export default route;\n//# sourceMappingURL=index.js.map\n") },
    { name: 'chunks/route.js', type: 'application/javascript+module', bytes: Buffer.from('export default {fetch(){return new Response("protocol");}};\n') },
    { name: 'index.js.map', type: 'application/source-map', bytes: Buffer.from(canonical({ version: 3, file: 'index.js', sources: ['src/index.js'], sourcesContent: ['export default route;'], names: [], mappings: '' })) },
    { name: 'renderer.wasm', type: 'application/wasm', bytes: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) }
  ];
  const assets = [{ path: 'index.html', type: 'text/html', bytes: Buffer.from('<main>Protocol transcript</main>') }, { path: 'assets/app.css', type: 'text/css', bytes: Buffer.from('main { color: blue; }') }];
  const expectedInventory = modules.map(part => ({ name: part.name, type: part.type, bytes: part.bytes.length, sha256: sha256(part.bytes), ...(part.name.endsWith('.map') ? { sourceMapDataSha256: digest(JSON.parse(part.bytes.toString())) } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
  const policy = protocolPolicy({ schema: 'shop.provider-protocol-policy/v1', awsAccountId: '000000000000', region: 'ap-southeast-2', cloudflareAccountId: '0'.repeat(32),
    workers: [{ name: 'protocol-synthetic-worker', metadataDigest: digest(metadata) }], functions: [{ name: 'protocol-synthetic-renderer', aliases: ['active'], imageRepository: '000000000000.dkr.ecr.ap-southeast-2.amazonaws.com/protocol-synthetic' }],
    store: { bucket: 'protocol-synthetic-journal', prefix: 'release-v2', kmsKeyArn: 'arn:aws:kms:ap-southeast-2:000000000000:key/00000000-0000-4000-8000-000000000000' }, github: { repository: 'bentbrain/bent-mono', environment: 'Protocol transcript', deploymentIds: ['123'] } });
  return { policy, metadata, modules, assets, expectedInventory, worker: policy.workers[0].name, functionName: policy.functions[0].name };
}
export async function runProtocolTranscript() {
  const fixture = protocolFixture(), { policy, worker, functionName } = fixture, faults = {};
  const service = await protocolTranscriptService({ policy, assets: fixture.assets, metadata: fixture.metadata, faults });
  try {
    const { trust, signer } = transcriptSigner(policy), client = protocolClient({ policy, trust, signer, transport: loopbackProtocolTransport(service.origin) }), builders = client.builders;
    const workers = await client.workerInventory(worker), functions = await client.lambdaInventory(functionName);
    assert.equal(workers.versions.length, 101); assert.equal(functions.versions.length, 3);
    const active = await client.workerActive(worker); assert.equal(active, workers.versions[2].id); assert.notEqual(active, workers.versions.at(-1).id);
    const before = await client.lambdaActive(functionName, 'active'); assert.equal(before.FunctionVersion, '7');
    const session = (await client.json(builders.assetSession(worker, fixture.assets))).result;
    const completed = (await client.json(builders.assetUpload(fixture.assets, session.buckets[0], session.jwt))).result;
    const upload = { entrypoint: 'index.js', metadata: { ...fixture.metadata, assets: { ...fixture.metadata.assets, jwt: completed.jwt } }, modules: fixture.modules, expectedInventory: fixture.expectedInventory };
    const version = (await client.json(builders.workerUpload(worker, upload))).result.id;
    verifyWorkerBindings(await client.json(builders.workerVersion(worker, version)), { version, bindings: fixture.metadata.bindings, runtime: { compatibility_date: fixture.metadata.compatibility_date, compatibility_flags: fixture.metadata.compatibility_flags } });
    await client.json(builders.workerActivate(worker, version));
    await verifyWorkerReadback(await client.send(builders.workerContent(worker)), upload);
    const uploadedLambda = await client.json(builders.lambdaUpload(functionName, 'a'.repeat(64), 'latest-revision-1')); assert.equal(uploadedLambda.Version, '9');
    await assert.rejects(client.send(builders.lambdaActivate(functionName, 'active', '9', 'stale-revision')), ProtocolConflict);
    const qualified = await client.json(builders.lambdaFunction(functionName, '9'));
    const expectedBinding = lambdaBindingProjection({ Architectures: ['x86_64'], MemorySize: 3008, Timeout: 120, Role: `arn:aws:iam::${policy.awsAccountId}:role/protocol-synthetic-runtime`, EphemeralStorage: { Size: 1024 }, Environment: { Variables: { STORY_BUILD_ID: 'b'.repeat(64) } } });
    verifyLambdaQualified(qualified, { policy, name: functionName, version: '9', imageDigest: 'a'.repeat(64), expectedBinding });
    await client.json(builders.lambdaActivate(functionName, 'active', '9', before.RevisionId)); assert.equal((await client.lambdaActive(functionName, 'active')).FunctionVersion, '9');
    assert.throws(() => builders.lambdaActivate(functionName, 'active', '$LATEST', before.RevisionId), /qualified numbered/);
    assert.throws(() => builders.workerUpload(worker, { ...upload, modules: upload.modules.slice(0, -1) }), /complete inventory/);
    assert.throws(() => builders.workerUpload(worker, { ...upload, metadata: { ...upload.metadata, bindings: [] } }), /protected policy/);
    assert.throws(() => builders.workerUpload('unadmitted-worker', upload), /allowlist/);
    const store = protectedStore(client, policy);
    const first = await appendProtectedJournal(store, null, { phase: 'admitted' });
    const readerA = await readProtectedJournal(store), readerB = await readProtectedJournal(store);
    const second = await appendProtectedJournal(store, readerA, { phase: 'intent', operation: 'lambda.activate', version: '9' });
    await assert.rejects(appendProtectedJournal(store, readerB, { phase: 'conflicting-intent' }), /CAS observation changed/);
    assert.equal(first.events.length, 1); assert.equal(second.events.length, 2);
    faults.dropStoreAfter = 'head.json';
    const verifiedState = { phase: 'runtime-verified', lastVerified: { component: 'native', version: '9' }, verification: { runtime: 'qualified-version-readback', version: '9' } };
    const verified = await appendProtectedJournal(store, second, verifiedState);
    assert.equal(verified.state.phase, 'runtime-verified');
    const reportState = { ...verifiedState, phase: 'report-reconcile', report: { eventDigest: verified.head.eventDigest, compositionDigest: digest(verifiedState.lastVerified), verificationDigest: digest(verifiedState.verification) } };
    const outbox = await appendProtectedJournal(store, verified, reportState);
    faults.dropReportAfter = true;
    await assert.rejects(client.send(builders.reportSuccess('123', verified.head.eventDigest)), UncertainWrite);
    const mutationCount = service.transcript.filter(record => record.method !== 'GET').length;
    assert.equal((await recoverReportingOnly({ client, store, deploymentId: '123' })).status, 'confirmed');
    assert.equal(service.transcript.filter(record => record.method !== 'GET').length, mutationCount);
    assert.equal(service.transcript.filter(record => record.method === 'POST' && new URL(record.url).origin === 'https://api.github.com').length, 1);
    const absentKey = `events/${'f'.repeat(64)}.json`; faults.dropStoreBefore = absentKey;
    await assert.rejects(store.put(absentKey, Buffer.from('{}'), null), UncertainWrite);
    assert.equal(service.transcript.filter(record => record.method === 'PUT' && record.url.endsWith(absentKey)).length, 1);
    assert.equal((await reconcileProtectedJournal(store, 'e'.repeat(64))).status, 'held');
    faults.truncateInventory = true; await assert.rejects(client.workerInventory(worker), /truncated/); delete faults.truncateInventory;
    const bad = transcriptSigner(policy, value => ({ ...value, signature: Buffer.alloc(64).toString('base64') }));
    const badClient = protocolClient({ policy, ...bad, transport: loopbackProtocolTransport(service.origin) });
    const count = service.transcript.length; await assert.rejects(badClient.send(badClient.builders.workerDeployments(worker)), /Invalid signer/); assert.equal(service.transcript.length, count);
    return { summary: { schema: 'shop.provider-protocol-transcript/v1', qualification: 'literal-loopback-request-construction', cloudQualified: false,
      requests: service.transcript.length, moduleParts: fixture.expectedInventory.length, assets: assetManifest(fixture.assets).inventory.length,
      paginatedWorkers: workers.versions.length, qualifiedLambdaVersions: functions.versions.filter(version => version.Version !== '$LATEST').length,
      journalGeneration: outbox.head.generation, noMutationReplay: true, reportingRecoveryReadOnly: true, credentialFreeSyntheticSigner: true }, transcript: service.transcript };
  } finally { await service.close(); }
}
async function main() {
  fixtureEnvironment(process.env);
  check(process.argv.length === 4 && process.argv[2] === '--output', 'Usage: provider-protocol-transcript.mjs --output PRIVATE_DIRECTORY');
  const directory = resolve(process.argv[3]), repository = fileURLToPath(new URL('../../../../../', import.meta.url));
  check(!`${directory}/`.startsWith(repository), 'Keep transcript evidence outside the public checkout');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  check(await realpath(directory) === directory && ((await lstat(directory)).mode & 0o077) === 0, 'Private regular evidence directory required');
  const result = await runProtocolTranscript();
  for (const [name, value] of Object.entries(result)) await writeFile(resolve(directory, `${name}.private.json`), canonical(value), { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${canonical(result.summary)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
