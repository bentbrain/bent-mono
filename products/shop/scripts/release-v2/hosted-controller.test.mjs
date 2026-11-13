import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, sha256 } from './data.mjs';
import { protocolPolicy } from './provider-protocol-builders.mjs';
import { createHostedWriter } from './hosted-writer.mjs';
import { createHostedProvider, retainedCandidateLoader, preflightHostedTargets } from './hosted-provider.mjs';
import { fixture } from './testing/fixtures.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { hostedProtocolFixture } from './testing/hosted-protocol-service.mjs';
import { hostedEngineStep } from './testing/hosted-engine-step.mjs';
import { reconcileHostedReport } from './hosted-reporting.mjs';
import { codeIdentity } from './component-identity.mjs';
import { lambdaBindingProjection } from './provider-protocol.mjs';

async function setup(work, { bindings = [] } = {}) {
  const f = await fixture(), synthetic = protocolFixture(), targets = [];
  for (const component of f.payload.components) {
    const artifact = JSON.parse(await readFile(join(f.bundle, component.artifact.path), 'utf8'));
    const oldConfig = JSON.parse(await readFile(join(f.bundle, component.config.path), 'utf8'));
    component.config = await f.put(component.config.path, { schema: 'shop.binding-installation/v1', scope: 'isolated-qualification', component: component.id, bindings: oldConfig.bindings });
    const provenance = JSON.parse(await readFile(join(f.bundle, component.provenance.path), 'utf8')); provenance.schema = 'shop.build-provenance/v1';
    component.provenance = await f.put(component.provenance.path, provenance);
    artifact.configDigest = component.config.sha256; artifact.provenanceDigest = component.provenance.sha256; component.artifact = await f.put(component.artifact.path, artifact);
    targets.push({ component: component.id, kind: 'worker', resource: `synthetic-${component.id}`, entrypoint: 'index.mjs', metadata: { main_module: 'index.mjs', compatibility_date: '2026-11-01', compatibility_flags: [], bindings }, modules: [{ name: 'index.mjs', path: artifact.entrypoint, type: 'application/javascript+module' }], assets: [] });
  }
  const policy = protocolPolicy({ ...synthetic.policy, workers: targets.map(target => ({ name: target.resource, metadataDigest: digest(target.metadata), versionContentApi: 'workers-beta/v1' })) });
  const service = await hostedProtocolFixture({ policy, targets });
  const config = { policy, targets, bundle: f.bundle, payload: f.payload, startedAt: Date.now(), custodyOrigin: service.custodyOrigin, fenceReceipt: service.receipt, fenceKeys: service.publicKeys };
  try { return await work({ f, policy, targets, service, config }); } finally { await service.close(); await rm(f.directory, { recursive: true, force: true }); }
}
async function childStep(config, directory) {
  const path = join(directory, 'hosted-engine-config.json'); await writeFile(path, canonical(config), { mode: 0o600 });
  const executable = fileURLToPath(new URL('./testing/hosted-engine-step.mjs', import.meta.url));
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [executable, path], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000); child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); accept({ code, stdout, stderr, state: code === 0 ? JSON.parse(stdout) : null }); });
  });
}

test('existing controller engine uses actual hosted provider and protected S3 journal across fresh processes', async () => {
  await setup(async ({ f, service, config }) => {
    const phases = [];
    for (let step = 0; step < 24; step++) {
      const result = await childStep(config, f.directory); assert.equal(result.code, 0, result.stderr); phases.push(result.state.phase);
      if (result.state.phase === 'complete') break;
    }
    assert.equal(phases.at(-1), 'complete'); assert(phases.includes('runtime-verified')); assert(phases.includes('reporting-pending'));
    const mutations = service.transcript.filter(item => item.method !== 'GET' && !item.url.includes('.s3.'));
    assert.equal(mutations.filter(item => item.url.endsWith('/versions')).length, 2); assert.equal(mutations.filter(item => item.url.endsWith('/deployments')).length, 2);
    assert.equal(service.reports.length, 1);
    const journalHead = JSON.parse(service.objects.get('head.json').bytes), event = JSON.parse(service.objects.get(`events/${journalHead.eventDigest}.json`).bytes);
    assert.equal(event.state.controller.phase, 'complete'); assert.equal(event.state.provider.versions.length, 2);
    for (const saved of event.state.provider.requests) { assert.equal(saved.status, 'acknowledged'); assert.match(saved.requestDigest, /^[a-f0-9]{64}$/); assert(saved.target); assert(saved.precondition); }
    assert(event.generation > event.state.controller.generation);
  });
});

test('lost Worker acknowledgement survives process exit and reconciles by GET without a second POST', async () => {
  await setup(async ({ f, service, config }) => {
    await hostedEngineStep(config); await hostedEngineStep(config); service.faults.dropUploadAfter = true;
    const lost = await childStep(config, f.directory); assert.notEqual(lost.code, 0); assert.match(lost.stderr, /socket|reset|acknowledgement|hang up/i);
    const uploads = () => service.transcript.filter(item => item.method === 'POST' && item.url.endsWith('/versions')).length;
    assert.equal(uploads(), 1);
    const blocked = await childStep(config, f.directory); assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /held/);
    await service.stopDrainRevoke();
    const resumed = await childStep(config, f.directory); assert.equal(resumed.code, 0, resumed.stderr); assert.equal(resumed.state.phase, 'staging'); assert.equal(uploads(), 1);
    for (let step = 0; step < 24; step++) { const result = await childStep(config, f.directory); assert.equal(result.code, 0, result.stderr); if (result.state.phase === 'complete') break; }
    assert.equal(uploads(), 2); assert.equal(service.reports.length, 1);
  });
});

test('report-only process recovery reads immutable verification and sends no runtime mutation', async () => {
  await setup(async ({ f, service, config }) => {
    for (let step = 0; step < 24; step++) { const state = await hostedEngineStep(config); if (state.phase === 'report-intent') break; }
    service.faults.dropReportAfter = true; const lost = await childStep(config, f.directory); assert.notEqual(lost.code, 0); assert.equal(service.reports.length, 1);
    const before = service.transcript.filter(item => item.method !== 'GET' && !item.url.includes('.s3.')).length;
    await service.stopDrainRevoke(); const result = await childStep({ ...config, command: 'recover-report' }, f.directory); assert.equal(result.code, 0, result.stderr); assert.equal(result.state.phase, 'complete');
    assert.equal(service.transcript.filter(item => item.method !== 'GET' && !item.url.includes('.s3.')).length, before);
  });
});

test('credential fence serializes writers and rejects revoked old owner sends', async () => {
  await setup(async ({ policy, service }) => {
    const owner = await service.broker.open(); await assert.rejects(service.broker.open(), /held/); await service.broker.assertOwner(owner);
    await service.stopDrainRevoke(); const next = await service.broker.open(); assert.notEqual(next, owner); await assert.rejects(service.broker.assertOwner(owner), /Stale/); await service.broker.close(next);
    assert.throws(() => createHostedWriter({ policy, broker: {}, fenceAdmission: service.fenceAdmission }), /custody broker/);
  });
});

test('content evidence must originate from actual retained bytes and immutable provider readback', async () => {
  await setup(async ({ f, policy, service, targets, config }) => {
    await hostedEngineStep(config); await hostedEngineStep(config); await hostedEngineStep(config);
    const writer = createHostedWriter({ policy, broker: service.broker, fenceAdmission: service.fenceAdmission }), provider = createHostedProvider({ policy, writer, broker: service.broker, components: f.payload.components, targets, load: retainedCandidateLoader({ bundle: f.bundle, targets }), deploymentId: '123', workInventory: service.workInventory });
    const component = f.payload.components[0], version = (await provider.inventory()).versions[0], evidence = await provider.content(component.id, version.version);
    provider.verifyContent(evidence, component); assert.throws(() => provider.verifyContent(structuredClone(evidence), component), /subject differs/);
    const native = service.workers.get(targets[0].resource).versions[0]; native.modules[0].content_base64 = Buffer.from('mutated bytes').toString('base64');
    await assert.rejects(provider.content(component.id, version.version), /inventory differs/);
  });
});


test('binding readback preserves every named value while allowing provider array order', async () => {
  await setup(async ({ f, policy, service, targets, config }) => {
    await hostedEngineStep(config); await hostedEngineStep(config); await hostedEngineStep(config);
    const writer = createHostedWriter({ policy, broker: service.broker, fenceAdmission: service.fenceAdmission }), provider = createHostedProvider({ policy, writer, broker: service.broker, components: f.payload.components, targets, load: retainedCandidateLoader({ bundle: f.bundle, targets }), deploymentId: '123' });
    const version = (await provider.inventory()).versions[0], component = f.payload.components.find(item => item.id === version.component), native = service.workers.get(targets[0].resource).versions[0];
    native.bindings.reverse(); provider.verifyContent(await provider.content(component.id, version.version), component);
    service.faults.versionResponseId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await assert.rejects(provider.content(component.id, version.version), /response identity differs/); delete service.faults.versionResponseId;
    native.bindings.push(native.bindings[0]); await assert.rejects(provider.content(component.id, version.version), /Unique named/);
  }, { bindings: [{ name: 'DATA', type: 'r2_bucket', bucket_name: 'synthetic-data' }, { name: 'CACHE', type: 'kv_namespace', namespace_id: '0'.repeat(32) }] });
});

test('complete signed accepted-work observation is read from storage and blocks unknown job handlers', async () => {
  await setup(async ({ service, config }) => {
    service.workDb.prepare('INSERT INTO accepted_jobs VALUES(?,?,?,?)').run('consumer', 'f'.repeat(64), 'unknown-job-format', 'accepted');
    await assert.rejects(hostedEngineStep(config), /Outstanding job requires/);
    assert.equal(service.transcript.filter(item => item.method === 'POST').length, 0);
    assert(service.brokerCalls.some(item => item.action === 'work-inventory'));
  });
});


test('A-to-B release retains original provider seals and accepted handlers after old artifact files are unavailable', async () => {
  await setup(async ({ f, service, config }) => {
    for (let step = 0; step < 24; step++) { const state = await hostedEngineStep(config); if (state.phase === 'complete') break; }
    const original = structuredClone(config.payload), old = original.components.find(item => item.id === 'consumer'), oldArtifact = JSON.parse(await readFile(join(f.bundle, old.artifact.path), 'utf8'));
    service.workDb.prepare('INSERT INTO accepted_jobs VALUES(?,?,?,?)').run('consumer', old.artifact.sha256, 'job-v1', 'accepted');
    const file = await f.put('artifacts/consumer-b/index.mjs', "export const component = 'consumer'; export const revision = 'b';"), files = [{ ...file, mediaType: 'application/javascript' }];
    const provenance = JSON.parse(await readFile(join(f.bundle, old.provenance.path), 'utf8')); provenance.artifactFilesDigest = digest(files); provenance.originSourceCommit = 'b'.repeat(40);
    const provenanceRef = await f.put('metadata/consumer-b-provenance.json', provenance);
    const artifactRef = await f.put('metadata/consumer-b-artifact.json', { ...oldArtifact, root: 'artifacts/consumer-b', entrypoint: file.path, files, originSourceCommit: 'b'.repeat(40), provenanceDigest: provenanceRef.sha256 });
    const next = { ...old, originSourceCommit: 'b'.repeat(40), artifact: artifactRef, provenance: provenanceRef }, payload = { ...original, parentCompositionDigest: digest(original), components: original.components.map(item => item.id === 'consumer' ? next : item) };
    const targets = config.targets.map(target => target.component === 'consumer' ? { ...target, modules: [{ ...target.modules[0], path: file.path }] } : target);
    await unlink(join(f.bundle, oldArtifact.entrypoint));
    const before = service.transcript.filter(item => item.method === 'POST' && !item.url.includes('.s3.')).length;
    const initial = await hostedEngineStep({ ...config, payload, targets, command: 'begin' }); assert.equal(initial.phase, 'prepared');
    for (let step = 0; step < 24; step++) { const state = await hostedEngineStep({ ...config, payload, targets }); if (state.phase === 'complete') break; }
    const head = JSON.parse(service.objects.get('head.json').bytes), state = JSON.parse(service.objects.get(`events/${head.eventDigest}.json`).bytes).state;
    assert.equal(state.controller.phase, 'complete'); assert.equal(state.controller.history.length, 2);
    assert.equal(service.workers.get('synthetic-consumer').versions.length, 2); assert.equal(service.workers.get('synthetic-producer').versions.length, 1);
    assert.equal(state.provider.versions.find(item => item.selected.version === `v-${old.artifact.sha256}`).component.originSourceCommit, old.originSourceCommit);
    assert.equal(service.transcript.filter(item => item.method === 'POST' && !item.url.includes('.s3.')).length - before, 3);
    assert.equal(service.workDb.prepare('SELECT count(*) AS count FROM accepted_jobs').get().count, 1);
  });
});


test('independent reporting recovery uses retained verification with the entire bundle unavailable', async () => {
  await setup(async ({ f, policy, service, config }) => {
    let verified;
    for (let step = 0; step < 24; step++) { verified = await hostedEngineStep(config); if (verified.phase === 'runtime-verified') break; }
    assert.equal(verified.phase, 'runtime-verified');
    const writer = createHostedWriter({ policy, broker: service.broker, fenceAdmission: service.fenceAdmission });
    const eventDigest = await writer.verificationRef(), authority = { eventDigest, compositionDigest: digest(verified.lastVerified), deploymentId: '123' };
    await rm(f.bundle, { recursive: true, force: true });
    const before = service.transcript.length, beforeWork = service.brokerCalls.filter(item => item.action === 'work-inventory').length;
    service.faults.dropReportAfter = true;
    await assert.rejects(reconcileHostedReport({ writer, broker: service.broker, policy, authority }), /socket|reset|acknowledgement|hang up/i);
    assert.equal(service.reports.length, 1); await service.stopDrainRevoke();
    const freshWriter = createHostedWriter({ policy, broker: service.broker, fenceAdmission: service.fenceAdmission });
    const recovered = await reconcileHostedReport({ writer: freshWriter, broker: service.broker, policy, authority });
    assert.equal(recovered.phase, 'report-confirmed');
    const repeated = await reconcileHostedReport({ writer: freshWriter, broker: service.broker, policy, authority }); assert.equal(repeated.phase, 'report-confirmed');
    assert.equal(service.reports.length, 1); assert.equal(service.brokerCalls.filter(item => item.action === 'work-inventory').length, beforeWork);
    assert(service.transcript.slice(before).every(item => item.url.includes('.s3.') || item.url.startsWith('https://api.github.com/')));
    assert.equal(service.transcript.slice(before).filter(item => item.method === 'POST').length, 1);
  });
});


test('hosted target preflight verifies every component before opening a writer or provider request', async () => {
  await setup(async ({ f, policy, service, targets }) => {
    const baseline = service.transcript.length, brokerCalls = service.brokerCalls.length;
    const load = retainedCandidateLoader({ bundle: f.bundle, targets });
    assert.equal((await preflightHostedTargets({ policy, components: f.payload.components, targets, load })).providerWrites, 0);
    const second = f.payload.components[1], nativeTargets = targets.map(target => target.component === second.id ? { component: second.id, kind: 'lambda', resource: 'unqualified-native', alias: 'active', qualification: { awsImageQualified: false } } : target);
    await assert.rejects(preflightHostedTargets({ policy, components: f.payload.components, targets: nativeTargets, load: retainedCandidateLoader({ bundle: f.bundle, targets: nativeTargets }) }), /format|qualification/);
    const assetFile = await f.put('artifacts/producer/index.html', '<main>sealed asset</main>'), artifact = JSON.parse(await readFile(join(f.bundle, second.artifact.path), 'utf8'));
    artifact.files.push({ ...assetFile, mediaType: 'text/html' });
    const provenance = JSON.parse(await readFile(join(f.bundle, second.provenance.path), 'utf8')); provenance.artifactFilesDigest = digest(artifact.files);
    const provenanceRef = await f.put('metadata/producer-assets-provenance.json', provenance); artifact.provenanceDigest = provenanceRef.sha256;
    const artifactRef = await f.put('metadata/producer-assets-artifact.json', artifact), component = { ...second, artifact: artifactRef, provenance: provenanceRef };
    const assetTargets = targets.map(target => target.component === second.id ? { ...target, assets: [{ name: 'index.html', path: assetFile.path, type: 'text/html' }] } : target);
    await assert.rejects(preflightHostedTargets({ policy, components: [f.payload.components[0], component], targets: assetTargets, load: retainedCandidateLoader({ bundle: f.bundle, targets: assetTargets }) }), /served asset qualification/);
    assert.equal(service.transcript.length, baseline); assert.equal(service.brokerCalls.length, brokerCalls);
  });
});


test('reporting recovery holds an absent unknown acknowledgement without replaying POST', async () => {
  await setup(async ({ f, policy, service, config }) => {
    let verified;
    for (let step = 0; step < 24; step++) { verified = await hostedEngineStep(config); if (verified.phase === 'runtime-verified') break; }
    const writer = createHostedWriter({ policy, broker: service.broker, fenceAdmission: service.fenceAdmission });
    const authority = { eventDigest: await writer.verificationRef(), compositionDigest: digest(verified.lastVerified), deploymentId: '123' };
    await rm(f.bundle, { recursive: true, force: true }); service.faults.dropReportBefore = true;
    await assert.rejects(reconcileHostedReport({ writer, broker: service.broker, policy, authority }), /socket|reset|acknowledgement|hang up/i);
    assert.equal(service.reports.length, 0); await service.stopDrainRevoke(); const before = service.transcript.length;
    const freshWriter = createHostedWriter({ policy, broker: service.broker, fenceAdmission: service.fenceAdmission });
    for (let recovery = 0; recovery < 2; recovery++) assert.equal((await reconcileHostedReport({ writer: freshWriter, broker: service.broker, policy, authority })).phase, 'report-held');
    assert.equal(service.reports.length, 0); assert(service.transcript.slice(before).every(item => item.method === 'GET' || item.url.includes('.s3.')));
    assert.equal(service.transcript.filter(item => item.method === 'POST' && item.url.startsWith('https://api.github.com/')).length, 1);
  });
});


test('malformed Lambda binding after a valid Worker is rejected before custody or journal access', async () => {
  await setup(async ({ f, policy, service, targets }) => {
    const component = structuredClone(f.payload.components[1]);
    const old = JSON.parse(await readFile(join(f.bundle, component.artifact.path), 'utf8'));
    component.id = 'native';
    const config = JSON.parse(await readFile(join(f.bundle, component.config.path), 'utf8')); config.component = component.id;
    component.config = await f.put(component.config.path, config);
    const files = [];
    const blob = async (mediaType, value) => { const bytes = Buffer.from(canonical(value)), hash = sha256(bytes); files.push({ ...await f.put(`${old.root}/blobs/sha256/${hash}`, bytes), mediaType: 'application/octet-stream' }); return { mediaType, digest: `sha256:${hash}`, size: bytes.length }; };
    const configuration = await blob('application/vnd.oci.image.config.v1+json', { architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });
    const image = await blob('application/vnd.oci.image.manifest.v1+json', { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: configuration, layers: [] });
    files.push({ ...await f.put(`${old.root}/oci-layout`, { imageLayoutVersion: '1.0.0' }), mediaType: 'application/json' },
      { ...await f.put(`${old.root}/index.json`, { schemaVersion: 2, manifests: [{ ...image, platform: { architecture: 'amd64', os: 'linux' } }] }), mediaType: 'application/json' });
    const artifact = { schema: 'shop.artifact/v2', component: component.id, format: 'oci-layout', root: old.root,
      entrypoint: `${old.root}/index.json`, files, originSourceCommit: old.originSourceCommit, inputsDigest: old.inputsDigest, runtimeDigest: digest('synthetic-native-runtime') };
    artifact.codeDigest = codeIdentity(artifact); component.codeDigest = artifact.codeDigest;
    component.artifact = await f.put('metadata/preflight-native-artifact.json', artifact);
    const provenance = JSON.parse(await readFile(join(f.bundle, component.provenance.path), 'utf8')); provenance.component = component.id; provenance.artifactFilesDigest = digest(artifact.files);
    component.provenance = await f.put(component.provenance.path, provenance);
    const imageDigest = image.digest.slice(7), expectedBinding = lambdaBindingProjection({ Architectures: ['x86_64'], MemorySize: 3008, Timeout: 120,
      Role: `arn:aws:iam::${policy.awsAccountId}:role/protocol-synthetic-runtime`, EphemeralStorage: { Size: 1024 }, Environment: { Variables: {} } });
    const native = { component: component.id, kind: 'lambda', resource: policy.functions[0].name, alias: 'active', imageDigest, expectedBinding,
      qualification: { awsImageQualified: true, artifactDigest: component.artifact.sha256, codeDigest: component.codeDigest, runtimeDigest: artifact.runtimeDigest, imageDigest, receiptDigest: digest('synthetic-qualification') } };
    const components = [f.payload.components[0], component];
    const baseline = { transcript: service.transcript.length, broker: service.brokerCalls.length, objects: [...service.objects.keys()] };
    const run = target => { const selected = [targets[0], target]; return preflightHostedTargets({ policy, components, targets: selected, load: retainedCandidateLoader({ bundle: f.bundle, targets: selected }) }); };
    assert.equal((await run(native)).providerWrites, 0);
    await assert.rejects(run({ ...native, imageDigest: 'a'.repeat(64) }), /OCI image digest/);
    await assert.rejects(run({ ...native, expectedBinding: { ...expectedBinding, Architectures: ['arm64'] } }), /architecture/);
    for (const binding of [undefined, null, [], {}, { ...expectedBinding, Timeout: '120' }, { ...expectedBinding, Environment: { Variables: { TEST: false } } },
      { ...expectedBinding, MemorySize: 0 }, { ...expectedBinding, Role: 'arn:aws:iam::111111111111:role/unadmitted' }, { ...expectedBinding, ImageConfigResponse: { Error: { Message: 'unqualified' } } },
      { ...expectedBinding, unrecognized: true }, { ...expectedBinding, VpcConfig: { SubnetIds: false } }]) {
      const changed = { ...native }; if (binding === undefined) delete changed.expectedBinding; else changed.expectedBinding = binding;
      await assert.rejects(run(changed), /Lambda target binding contract|Lambda architecture/);
      assert.equal(service.transcript.length, baseline.transcript); assert.equal(service.brokerCalls.length, baseline.broker);
      assert.deepEqual([...service.objects.keys()], baseline.objects);
    }
  });
});
