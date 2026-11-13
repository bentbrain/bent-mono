import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { processGroupSnapshot, validateProofObservation } from './proof-observations.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, check, digest, filesUnder, sha256 } from '../data.mjs';
import { hostedProtocolFixture, literalJSON } from './hosted-protocol-service.mjs';
import { createPortableFixture } from './portable-fixture.mjs';
import { packagePortableBundle } from '../portable-bundle.mjs';
import { protocolFixture } from './provider-protocol-transcript.mjs';
import { protocolPolicy } from '../provider-protocol-builders.mjs';
import { lambdaBindingProjection } from '../provider-protocol.mjs';
import { createArtifactIntakeFixture } from './artifact-intake-fixture.mjs';
import { createBootstrapFixture } from './bootstrap-fixture.mjs';
import { installedSigningKey } from '../protected-installation.mjs';

export async function retainWorkflowProtocolEvidence(service, output) {
  const inventory = [];
  for (const [name, objects] of [['controller', service.objects], ['custody', service.custodyObjects]]) {
    const root = join(output, 'retained-protected-journals', name); await mkdir(root, { recursive: true, mode: 0o700 });
    for (const [key, object] of [...objects].sort(([a], [b]) => a.localeCompare(b))) {
      check(key === 'head.json' || /^events\/[a-f0-9]{64}\.json$/.test(key), 'Exact protected journal evidence key required');
      const path = `${key}.gz`, compressed = gzipSync(object.bytes);
      await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(root, path), compressed, { flag: 'wx', mode: 0o600 });
      inventory.push({ journal: name, key, sha256: sha256(object.bytes), bytes: object.bytes.length, etag: object.etag, versionId: object.versionId,
        retained: { path: `retained-protected-journals/${name}/${path}`, encoding: 'gzip', bytes: compressed.length, sha256: sha256(compressed) } });
    }
  }
  await writeFile(join(output, 'retained-protected-journals.private.json'), canonical(inventory), { flag: 'wx', mode: 0o600 });
  return { objects: inventory.length, inventoryDigest: digest(inventory), rawBytes: inventory.reduce((sum, file) => sum + file.bytes, 0), retainedBytes: inventory.reduce((sum, file) => sum + file.retained.bytes, 0) };
}

async function retainWorkflowVerifierSource(output, expectedDigest) {
  const root = fileURLToPath(new URL('../', import.meta.url)), files = [];
  const paths = (await filesUnder(root)).filter(path => !path.startsWith('testing/') && !path.endsWith('.test.mjs'))
    .map(path => `products/shop/scripts/release-v2/${path}`);
  paths.push('scripts/require-release-checks.mjs', 'products/shop/scripts/testing/linux-evidence.mjs',
    'products/shop/scripts/testing/linux-evidence-recipient.json', 'products/shop/scripts/release-evidence.mjs',
    'products/shop/scripts/read-regular-file.mjs');
  for (const path of paths.sort()) {
    const bytes = await readFile(join(checkout, path)); files.push({ path, sha256: sha256(bytes) });
    await mkdir(dirname(join(output, 'verifier-source', path)), { recursive: true, mode: 0o700 });
    await writeFile(join(output, 'verifier-source', path), bytes, { flag: 'wx', mode: 0o600 });
  }
  check(digest(files) === expectedDigest, 'Verifier changed while retaining its exact source');
  await writeFile(join(output, 'verifier-source.private.json'), canonical({ implementationDigest: expectedDigest, files }), { flag: 'wx', mode: 0o600 });
}

export async function createWorkflowJourneyFixture(t, { output, sourceCommit = '1'.repeat(40), maximumLifetimeMs = 600000, malformedNative = false }) {
  await privateProofDirectory(output);
  const portable = await createWorkflowPortableFixture(t, { root: output, sourceCommit });
  const provider = await createWorkflowProviderFixture(portable); t.after(() => provider.service.close());
  try {
    if (malformedNative) provider.plan.targets.find(target => target.kind === 'lambda').expectedBinding.MemorySize = 0;
    const intake = await createArtifactIntakeFixture(t, { root: output, portableFixture: portable, sourceCommit });
    const bootstrap = await createBootstrapFixture(t, { root: output, intakeFixture: intake, sourceCommit,
      providerPolicy: provider.policy, plan: provider.plan, fenceReceipt: provider.service.receipt,
      brokerKeys: provider.service.publicKeys, runner: syntheticRetainedRunner(), acceptedAt: Date.now() - 1000, maximumLifetimeMs });
    await retainWorkflowVerifierSource(output, bootstrap.template.implementationDigest);
    const bridge = await workflowApiBridge({ intakeApi: intake.api, qualityApi: bootstrap.qualityApi, output: join(output, 'api-bridge') });
    t.after(() => bridge.close());
    const configuration = { options: { installationPath: bootstrap.installationPath, installationDigest: bootstrap.installationDigest,
      request: intake.request, directory: join(output, 'workflow'), command: 'advance', acceptedAt: bootstrap.acceptedAt, env: bootstrap.env },
      boundaries: { apiOrigin: bridge.origin, custodyOrigin: provider.service.custodyOrigin } };
    return { portable, ...provider, intake, bootstrap, bridge, configuration, realAwsQualified: false };
  } catch (error) { await provider.service.close(); throw error; }
}

export async function createWorkflowUpdateFixture(t, { fixture, output }) {
  await privateProofDirectory(output);
  const sourceCommit = '2'.repeat(40);
  const portable = await createWorkflowPortableFixture(t, { root: output, sourceCommit, revision: 'B', runId: '124', previous: fixture.portable });
  const intake = await createArtifactIntakeFixture(t, { root: output, portableFixture: portable, sourceCommit, runId: 124,
    artifactId: 790, jobId: 988, recipientPrivateKeyFile: fixture.intake.privateKeyFile });
  const bootstrap = await createBootstrapFixture(t, { root: output, intakeFixture: intake, sourceCommit, sourceBase: fixture.bootstrap.identity.head,
    runId: 11, keys: fixture.bootstrap.keys, providerPolicy: fixture.policy, plan: fixture.plan, fenceReceipt: fixture.service.receipt,
    brokerKeys: fixture.service.publicKeys, runner: syntheticRetainedRunner(), acceptedAt: Date.now() - 1000,
    maximumLifetimeMs: fixture.bootstrap.root.maximumLifetimeMs });
  await retainWorkflowVerifierSource(output, bootstrap.template.implementationDigest);
  check(bootstrap.installation.rootDigest === fixture.bootstrap.installation.rootDigest, 'Source update must retain the independently installed root');
  const bridge = await workflowApiBridge({ intakeApi: intake.api, qualityApi: bootstrap.qualityApi, output: join(output, 'api-bridge') });
  t.after(() => bridge.close());
  const configuration = { options: { installationPath: bootstrap.installationPath, installationDigest: bootstrap.installationDigest,
    request: intake.request, directory: join(output, 'workflow'), command: 'begin', acceptedAt: bootstrap.acceptedAt, env: bootstrap.env },
    boundaries: { apiOrigin: bridge.origin, custodyOrigin: fixture.service.custodyOrigin } };
  return { ...fixture, portable, intake, bootstrap, bridge, configuration };
}

export async function recoverStoppedWorkflowOwner({ service, output, name }) {
  const state = await service.executor.readState(), issuedAt = Date.now();
  check(state.owner?.id, 'Retained stopped controller owner required');
  const receipt = service.signRoot({ schema: 'shop.custody-owner-recovery/v1', fenceDigest: service.fenceAdmission.digest,
    installationId: service.installation.payload.installationId, owner: state.owner.id, controllerStopped: true,
    issuedAt, expiresAt: issuedAt + 60000 });
  await writeFile(join(output, `${name}-owner-recovery.private.json`), canonical(receipt), { flag: 'wx', mode: 0o600 });
  return service.executor.recoverOwner(receipt);
}

export async function prepareExpiredWorkflowReporting({ fixture, output, paths }) {
  const head = JSON.parse(fixture.service.objects.get('head.json').bytes), event = JSON.parse(fixture.service.objects.get(`events/${head.eventDigest}.json`).bytes);
  const controller = event.state.controller, eventDigest = controller.report.eventDigest;
  const immutable = fixture.service.objects.get(`events/${eventDigest}.json`), verified = JSON.parse(immutable.bytes);
  check(digest(verified) === eventDigest && verified.state.controller.phase === 'runtime-verified', 'Actual immutable runtime verification event required');
  const sourceAuthority = JSON.parse(await readFile(paths.authority)), installed = fixture.bootstrap.installation;
  const delay = sourceAuthority.payload.expiresAt - Date.now() + 5;
  check(delay < 60000, 'Use a bounded source lifetime for expiry rehearsal');
  if (delay > 0) await new Promise(accept => setTimeout(accept, delay));
  const issuedAt = Date.now();
  const payload = { schema: 'shop.hosted-reporting-authority/v1', scope: installed.root.scope, repository: installed.root.repository,
    repositoryName: installed.root.repositoryName, environment: installed.root.environment, workflowPath: installed.root.workflowPath,
    head: fixture.bootstrap.identity.head, runId: fixture.bootstrap.identity.runId, attempt: fixture.bootstrap.identity.attempt,
    issuedAt, expiresAt: issuedAt + installed.root.maximumLifetimeMs, providerPolicy: fixture.policy,
    writerFenceDigest: fixture.service.fenceAdmission.digest, eventDigest, compositionDigest: controller.compositionDigest,
    deploymentId: fixture.plan.deploymentId };
  const key = await installedSigningKey(installed, 'source');
  const authority = { payload, signature: { algorithm: 'ECDSA_SHA_256', keyId: key.keyId, payloadDigest: digest(payload),
    signature: sign('sha256', Buffer.from(canonical(payload)), key.privateKey).toString('base64') } };
  const recoveryAuthority = join(output, 'reporting-authority.private.json');
  await writeFile(recoveryAuthority, canonical(authority), { flag: 'wx', mode: 0o600 });
  const retained = join(output, 'retained-unavailable-inputs'); await mkdir(retained, { mode: 0o700 });
  const unavailable = [];
  for (const [name, original] of [['assembly', paths.bundle], ['intake', join(fixture.configuration.options.directory, 'intake')],
    ['source-key.pem', fixture.bootstrap.installationContract.signing.source.path], ['composition-key.pem', fixture.bootstrap.installationContract.signing.composition.path]]) {
    const destination = join(retained, name); await rename(original, destination); unavailable.push({ original, retained: destination });
  }
  check(Date.now() > sourceAuthority.payload.expiresAt && Date.now() < payload.expiresAt, 'Original source must expire while reporting authority remains valid');
  const evidence = { sourceExpiredAt: sourceAuthority.payload.expiresAt, reportingExpiresAt: payload.expiresAt,
    checkedAt: Date.now(), eventDigest, compositionDigest: controller.compositionDigest, unavailable,
    originalSourceAuthoritySha256: sha256(canonical(sourceAuthority)), recoveryAuthoritySha256: sha256(canonical(authority)) };
  await writeFile(join(output, 'reporting-recovery-inputs.private.json'), canonical(evidence), { flag: 'wx', mode: 0o600 });
  return { configuration: { ...fixture.configuration, options: { ...fixture.configuration.options, command: 'recover-report', recoveryAuthority } }, evidence };
}

export async function workflowCorruptionProbes({ fixture, paths, output, invoke }) {
  const manifest = JSON.parse(await readFile(paths.manifest)), native = manifest.payload.components.find(component => component.id === 'native');
  const probes = [
    ['forged-source-authority', paths.authority, bytes => {
      const value = JSON.parse(bytes); value.signature.signature = `${value.signature.signature[0] === 'A' ? 'B' : 'A'}${value.signature.signature.slice(1)}`;
      return Buffer.from(canonical(value));
    }],
    ['forged-composition', paths.manifest, bytes => {
      const value = JSON.parse(bytes); value.payload.intentSourceCommit = 'f'.repeat(40); return Buffer.from(canonical(value));
    }],
    ['changed-component-proof', join(paths.bundle, native.componentProofs[0].path)],
    ['changed-installed-target', fixture.bootstrap.installationContract.targetPlan.path],
    ['changed-installed-key', fixture.bootstrap.installationContract.signing.source.path, () =>
      Buffer.from(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' })), true],
    ['changed-installed-fence', fixture.bootstrap.installationContract.credentialFence.path],
    ['changed-installed-root', fixture.bootstrap.installationContract.root.path],
    ['changed-installed-binding', fixture.bootstrap.installationContract.componentConfigurations[0].config.path],
  ];
  const results = [];
  for (const [name, path, transform = bytes => Buffer.concat([bytes, Buffer.from('\n')]), freshIssuance = false] of probes) {
    const original = await readFile(path), changed = transform(original), calls = fixture.service.transcript.length, brokerCalls = fixture.service.brokerCalls.length;
    await writeFile(path, changed, { mode: 0o600 });
    try {
      const result = await invoke(`reject-${name}`, freshIssuance ? { ...fixture.configuration,
        options: { ...fixture.configuration.options, directory: join(output, `rejected-${name}-issuance`) } } : undefined);
      check(result.exitCode !== 0 && fixture.service.transcript.length === calls && fixture.service.brokerCalls.length === brokerCalls,
        `Corrupted ${name} reached provider custody`);
      results.push({ name, originalSha256: sha256(original), changedSha256: sha256(changed), diagnosticSha256: result.stderr.sha256,
        rejected: true, providerCalls: 0, custodyCalls: 0 });
    } finally { await writeFile(path, original, { mode: 0o600 }); }
    check(sha256(await readFile(path)) === sha256(original), 'Adversarial probe failed to restore the exact original bytes');
  }
  await writeFile(join(output, 'adversarial-byte-probes.private.json'), canonical(results), { flag: 'wx', mode: 0o600 });
  return results;
}

async function createWorkflowPortableFixture(t, { sourceCommit = '1'.repeat(40), root, revision = 'A', runId = '123', runAttempt = '1', previous } = {}) {
  check(/^[A-Z]$/.test(revision), 'One synthetic storefront source revision required');
  const lineage = { kind: 'github-actions', repository: 'bentbrain/bent-mono', sourceCommit, runId: '123', runAttempt: '1',
    workflowRef: 'bentbrain/bent-mono/.github/workflows/shop-linux-journey.yml@refs/heads/main', jobId: 'journey' };
  Object.assign(lineage, { runId, runAttempt });
  const base = await createPortableFixture(t, { lineage, ...(root ? { rootDirectory: root } : {}) });
  for (const component of base.components.filter(component => component.id !== 'native')) {
    await writeFile(join(component.directory, 'index.js'), `export const component = '${component.id}'; export const exercise = phase => component + ':' + phase;${component.id === 'storefront' ? ` export const revision = '${revision}';` : ''}`, { mode: 0o600 });
    await writeFile(join(component.directory, 'index.js.map'), canonical({ version: 3, sources: ['synthetic-fixture.js'], names: [], mappings: '' }), { mode: 0o600 });
  }
  const native = base.components.find(component => component.id === 'native');
  await rm(native.directory, { recursive: true }); await mkdir(join(native.directory, 'blobs/sha256'), { recursive: true, mode: 0o700 });
  const config = Buffer.from(canonical({ architecture: 'amd64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [] }, history: [] }));
  const manifest = Buffer.from(canonical({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${sha256(config)}`, size: config.length }, layers: [] }));
  const index = { schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${sha256(manifest)}`,
    size: manifest.length, platform: { architecture: 'amd64', os: 'linux' } }] };
  await writeFile(join(native.directory, 'oci-layout'), canonical({ imageLayoutVersion: '1.0.0' }), { mode: 0o600 });
  await writeFile(join(native.directory, 'index.json'), canonical(index), { mode: 0o600 });
  await writeFile(join(native.directory, 'blobs/sha256', sha256(config)), config, { mode: 0o600 });
  await writeFile(join(native.directory, 'blobs/sha256', sha256(manifest)), manifest, { mode: 0o600 });
  Object.assign(native, { format: 'oci-layout', entrypoint: 'index.json', runtime: { kind: 'synthetic-empty-layer-oci-fixture', awsImageQualified: false } });
  const sourceBytes = `export const storefrontRevision = '${revision}';`;
  const sourcePath = 'products/shop/apps/storefront/src/synthetic-workflow.mjs';
  await mkdir(dirname(join(base.source, sourcePath)), { recursive: true, mode: 0o700 });
  await writeFile(join(base.source, sourcePath), sourceBytes, { mode: 0o600 });
  const files = [...base.verified.manifest.snapshots[0].files, { path: sourcePath, sha256: sha256(sourceBytes), mode: '100644' }]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const components = previous ? base.components.map(component => component.id === 'storefront' ? component : previous.components.find(item => item.id === component.id)) : base.components;
  const sources = previous ? [{ originSourceCommit: previous.verified.manifest.originSourceCommit,
    inventory: { files: previous.verified.manifest.snapshots.find(snapshot => snapshot.originSourceCommit === previous.verified.manifest.originSourceCommit).files }, directory: previous.source },
  { originSourceCommit: sourceCommit, inventory: { files }, directory: base.source }] : [];
  const verified = await packagePortableBundle({ destination: join(base.root, 'synthetic-oci-portable'), originSourceCommit: sourceCommit,
    lineage, sourceInventory: { files }, sourceDirectory: base.source, components, sources });
  check(verified.manifest.awsImageQualified === false && verified.components.get('native').artifact.format === 'oci-layout', 'Separate synthetic OCI packaging required');
  return { ...base, components, verified, nativeImageDigest: sha256(manifest), syntheticQualificationOnly: true, realAwsQualified: false };
}

async function createWorkflowProviderFixture(portable) {
  check(portable.syntheticQualificationOnly === true && portable.realAwsQualified === false, 'Separate synthetic OCI protocol fixture required');
  const original = protocolFixture().policy;
  const targets = [...portable.verified.components.values()].map(imported => {
    const { component, artifact } = imported;
    if (component.id === 'native') return { component: component.id, kind: 'lambda', resource: original.functions[0].name, alias: 'active',
      imageDigest: portable.nativeImageDigest,
      expectedBinding: lambdaBindingProjection({ Architectures: ['x86_64'], MemorySize: 128, Timeout: 30,
        Role: `arn:aws:iam::${original.awsAccountId}:role/synthetic-workflow-runtime`, EphemeralStorage: { Size: 512 },
        Environment: { Variables: { SYNTHETIC_WORKFLOW_PROBE: 'true' } } }),
      qualification: { awsImageQualified: true, artifactDigest: imported.artifactRef.sha256, codeDigest: artifact.codeDigest,
        runtimeDigest: artifact.runtimeDigest, imageDigest: portable.nativeImageDigest, receiptDigest: sha256('synthetic-independent-OCI-qualification-assertion') } };
    const metadata = { main_module: 'index.js', compatibility_date: '2026-11-01', compatibility_flags: [], bindings: [] };
    return { component: component.id, kind: 'worker', resource: `synthetic-workflow-${component.id}`, entrypoint: 'index.js', metadata,
      modules: artifact.files.map(file => ({ name: file.path.slice(artifact.root.length + 1), path: file.path,
        type: file.path.endsWith('.map') ? 'application/source-map' : file.path.endsWith('.js') ? 'application/javascript+module' : file.path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' })), assets: [] };
  });
  const policy = protocolPolicy({ ...original, workers: targets.filter(target => target.kind === 'worker').map(target => ({
    name: target.resource, metadataDigest: digest(target.metadata), versionContentApi: 'workers-beta/v1' })),
    github: { ...original.github, environment: 'Preview' } });
  const service = await hostedProtocolFixture({ policy, targets });
  const close = service.close; let closed = false;
  service.close = async () => { if (!closed) { closed = true; await close(); } };
  const plan = { schema: 'shop.hosted-target-plan/v1', scope: 'isolated-qualification', providerPolicy: policy, targets,
    deploymentId: policy.github.deploymentIds[0], journeyOrigin: 'https://synthetic-workflow.example.invalid' };
  return { policy, targets, plan, service, realAwsQualified: false, syntheticQualificationOnly: true };
}

export function retainedWorkflowPlanTargets(portable) {
  const original = protocolFixture().policy;
  const targets = [...portable.components.values()].map(({ component, artifact }) => {
    if (component.id === 'native') return { component: 'native', kind: 'lambda', resource: original.functions[0].name, alias: 'active',
      qualification: { awsImageQualified: false } };
    const entrypoint = artifact.entrypoint.slice(artifact.root.length + 1);
    const metadata = { main_module: entrypoint, compatibility_date: '2026-11-01', compatibility_flags: [], bindings: [] };
    return { component: component.id, kind: 'worker', resource: `historical-plan-${component.id}`, entrypoint, metadata,
      modules: artifact.files.map(file => ({ name: file.path.slice(artifact.root.length + 1), path: file.path,
        type: file.path.endsWith('.map') ? 'application/source-map' : /\.[cm]?js$/.test(file.path) ? 'application/javascript+module' : file.path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' })), assets: [] };
  });
  const policy = protocolPolicy({ ...original, workers: targets.filter(target => target.kind === 'worker').map(target => ({
    name: target.resource, metadataDigest: digest(target.metadata), versionContentApi: 'workers-beta/v1' })), github: { ...original.github, environment: 'Preview' } });
  return { policy, plan: { schema: 'shop.hosted-target-plan/v1', scope: 'isolated-qualification', providerPolicy: policy, targets,
    deploymentId: policy.github.deploymentIds[0], journeyOrigin: 'https://qualification.example.invalid' } };
}

const checkout = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');

export async function workflowApiBridge({ intakeApi, qualityApi, output }) {
  await privateProofDirectory(output);
  const calls = [], controls = { transform: null }; let downloads = 0;
  const server = createServer(async (request, response) => {
    try {
      check(request.method === 'POST' && request.url === '/' && request.headers.authorization === 'Bearer synthetic-loopback-controller', 'Synthetic workflow bridge request required');
      const chunks = []; let size = 0;
      for await (const bytes of request) { size += bytes.length; check(size <= 65536, 'Workflow API bridge request exceeds bound'); chunks.push(bytes); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value.schema === 'shop.credential-broker-call/v1') { calls.push({ kind: 'forbidden-custody', endpoint: value.action }); throw Error('Historical plan fixture rejects provider custody'); }
      check(['intake-json', 'quality-json', 'download'].includes(value.kind) && typeof value.endpoint === 'string' &&
        (value.endpoint === '/repos/bentbrain/bent-mono' || value.endpoint.startsWith('/repos/bentbrain/bent-mono/')), 'Canonical workflow fixture API required');
      calls.push({ kind: value.kind, endpoint: value.endpoint });
      if (value.kind === 'download') {
        check(Number.isSafeInteger(value.maxBytes) && value.maxBytes > 0 && value.maxBytes <= 4 * 1024 ** 3, 'Bounded fixture archive required');
        const destination = join(output, `bridge-download-${downloads++}.zip`);
        await intakeApi.downloadArtifact({ endpoint: value.endpoint, destination, maxBytes: value.maxBytes });
        const file = await open(destination, 'r');
        try {
          const length = (await file.stat()).size; check(length > 0 && length <= value.maxBytes, 'Fixture archive exceeds bound');
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': length });
          for await (const bytes of file.createReadStream({ autoClose: false })) {
            if (!response.write(bytes)) await new Promise((accept, reject) => {
              const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
              const drained = () => { cleanup(); accept(); }, closed = () => { cleanup(); reject(Error('Fixture archive client closed')); }, failed = error => { cleanup(); reject(error); };
              response.once('drain', drained); response.once('close', closed); response.once('error', failed);
            });
          }
          response.end();
        } finally { await file.close(); }
        return;
      }
      let result = await (value.kind === 'intake-json' ? intakeApi.getJSON(value.endpoint) : qualityApi(value.endpoint));
      if (controls.transform) result = controls.transform(value, structuredClone(result));
      const bytes = Buffer.from(canonical(result)); check(bytes.length <= 16 * 1024 * 1024, 'Fixture metadata exceeds bound');
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length }); response.end(bytes);
    } catch (error) {
      if (!response.headersSent) { response.writeHead(409, { 'content-type': 'application/json' }); response.end(canonical({ error: error.message })); }
      else response.destroy();
    }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  let closed = false;
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, controls, close: async () => {
    if (closed) return; closed = true;
    await new Promise((accept, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : accept()); });
  } };
}

export function workflowFixtureBoundaries({ apiOrigin, custodyOrigin }) {
  const url = new URL(apiOrigin); check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.search && !url.hash, 'Bounded literal loopback workflow API required');
  return {
    intakeApi: { getJSON: endpoint => literalJSON(apiOrigin, { kind: 'intake-json', endpoint }),
      downloadArtifact: async ({ endpoint, destination, maxBytes }) => {
        const file = await open(destination, 'wx', 0o600), body = Buffer.from(canonical({ kind: 'download', endpoint, maxBytes }));
        try {
          await new Promise((accept, reject) => {
            const request = httpRequest({ hostname: '127.0.0.1', port: url.port, path: '/', method: 'POST', agent: false,
              headers: { authorization: 'Bearer synthetic-loopback-controller', 'content-type': 'application/json', 'content-length': body.length } });
            const timer = setTimeout(() => request.destroy(Error('Fixture archive transport deadline')), 30000);
            request.once('error', reject); request.once('close', () => clearTimeout(timer));
            request.once('response', async response => {
              try {
                check(response.statusCode === 200, 'Fixture archive transport failed'); let length = 0;
                for await (const bytes of response) { length += bytes.length; check(length <= maxBytes, 'Fixture archive transport exceeds bound'); await file.write(bytes); }
                check(response.complete && length > 0 && length === Number(response.headers['content-length']), 'Fixture archive transport truncated'); accept();
              } catch (error) { request.destroy(); reject(error); }
            });
            request.end(body);
          });
        } finally { await file.close(); }
      } },
    qualityApi: endpoint => literalJSON(apiOrigin, { kind: 'quality-json', endpoint }),
    ...(custodyOrigin ? { broker: value => literalJSON(custodyOrigin, value) } : {}),
  };
}

export async function privateProofDirectory(path) {
  check(isAbsolute(path) && resolve(path) === path && path !== checkout && !path.startsWith(`${checkout}${sep}`), 'Use an absolute private proof directory outside the checkout');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && await realpath(path) === path &&
    (typeof process.getuid !== 'function' || info.uid === process.getuid()), 'Owned canonical private proof directory required');
  return path;
}

// Each controller invocation gets a new executable process. Preserve the exact
// argv and the original streams, including failed and uncertain writes.
export async function recordedProcess({ output, name, executable = process.execPath, args, env = {}, cwd = checkout, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024, signal: cancellation }) {
  check(/^[a-z0-9][a-z0-9-]{0,127}$/.test(name) && Array.isArray(args) && args.every(value => typeof value === 'string'), 'Exact bounded process identity required');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 420000 && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 16 * 1024 * 1024, 'Bounded proof process required');
  cancellation?.throwIfAborted(); await privateProofDirectory(output);
  const startedAt = Date.now(), executableSha256 = sha256(await readFile(executable));
  const stdoutPath = `${name}-stdout.private.bin`, stderrPath = `${name}-stderr.private.bin`, profilePath = `${name}-profile.private.jsonl`;
  const handles = [], openPrivate = path => { const fd = openSync(join(output, path), 'wx', 0o600); handles.push(fd); return fd; };
  let profileBytes = 0;
  try {
    const stdoutFd = openPrivate(stdoutPath), stderrFd = openPrivate(stderrPath), profileFd = openPrivate(profilePath);
    const observe = (kind, details) => {
      const record = validateProofObservation({ schema:'shop.workflow-proof-observation/v1',invocation:name,at:Date.now(),kind,details });
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      check(profileBytes + bytes.length <= 2 * 1024 * 1024, 'Proof profile exceeds bound');
      writeSync(profileFd, bytes); profileBytes += bytes.length;
      if (kind !== 'child' && kind !== 'processes') fsyncSync(profileFd);
    };
    const result = await new Promise((accept, reject) => {
      const child = spawn(executable, args, { cwd, detached:true, env:{ PATH:dirname(process.execPath),...env,SHOP_WORKFLOW_DIAGNOSTICS:'1' },stdio:['ignore','pipe','pipe','ipc'] });
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overflow = false, timedOut = false, aborted = false, spawnError, streamError, invalidMessages = 0;
      let sampling = Promise.resolve(), samplingBusy = false, sampleErrors = 0;
      const stop = reason => {
        if (!child.pid) return;
        try { observe('stop', { pid:child.pid, reason }); process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') streamError ??= error; }
      };
      const abort = () => { aborted = true; stop('abort'); };
      cancellation?.addEventListener('abort', abort, { once:true });
      const timer = setTimeout(() => { timedOut = true; stop('timeout'); }, timeoutMs);
      const sample = () => {
        if (!child.pid || samplingBusy) return;
        samplingBusy = true;
        sampling = processGroupSnapshot(child.pid).then(processes => observe('processes', { pid:child.pid, processes }))
          .catch(() => { sampleErrors++; }).finally(() => { samplingBusy = false; });
      };
      const interval = setInterval(sample, 1000); interval.unref();
      if (child.pid) { observe('start', { pid:child.pid,timeoutMs }); sample(); }
      if (cancellation?.aborted) abort();
      const capture = (stream, fd) => bytes => {
        if (stdout.length + stderr.length + bytes.length > maxBytes) { overflow = true; stop('overflow'); return; }
        try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset); }
        catch (error) { streamError ??= error; stop('stream-error'); return; }
        if (stream === 'stdout') stdout = Buffer.concat([stdout, bytes]); else stderr = Buffer.concat([stderr, bytes]);
      };
      child.stdout.on('data', capture('stdout', stdoutFd)); child.stderr.on('data', capture('stderr', stderrFd));
      child.on('message', value => {
        try {
          check(value?.schema === 'shop.workflow-proof-child/v1' && Object.keys(value).sort().join(',') === 'command,metrics,phase,schema,step', 'Fixed child measurement required');
          const { schema:_schema,...details } = value; observe('child', details);
        } catch { invalidMessages++; }
      });
      child.once('error', error => { spawnError = error; });
      child.once('close', async (exitCode, signal) => {
        clearTimeout(timer); clearInterval(interval); cancellation?.removeEventListener('abort', abort);
        try {
          await sampling;
          let remaining = child.pid ? await processGroupSnapshot(child.pid) : [];
          if (remaining.length) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            for (let attempt = 0; attempt < 15 && remaining.length; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 20)); remaining = await processGroupSnapshot(child.pid);
            }
          }
          observe('close', { pid:child.pid ?? 0,exitCode:spawnError ? null : exitCode,signal,aborted,timedOut,overflow,reaped:remaining.length === 0,
            remainingPids:remaining.map(item => item.pid),metrics:{ stdoutBytes:stdout.length,stderrBytes:stderr.length,elapsedMs:Date.now()-startedAt,invalidMessages,sampleErrors } });
          fsyncSync(stdoutFd); fsyncSync(stderrFd); fsyncSync(profileFd);
          check(remaining.length === 0, 'Proof process group did not exit');
          if (spawnError || streamError) throw spawnError ?? streamError;
          accept({ stdout,stderr,exitCode,signal,overflow,timedOut,aborted,pid:child.pid,reaped:true });
        } catch (error) { reject(error); }
      });
    });
    const record = { schema:'shop.workflow-proof-process/v1',executable,executableSha256,args,cwd,pid:result.pid,startedAt,finishedAt:Date.now(),
      exitCode:result.exitCode,signal:result.signal,overflow:result.overflow,timedOut:result.timedOut,aborted:result.aborted,reaped:result.reaped,profile:profilePath,
      stdout:{path:stdoutPath,bytes:result.stdout.length,sha256:sha256(result.stdout)},stderr:{path:stderrPath,bytes:result.stderr.length,sha256:sha256(result.stderr)} };
    await writeFile(join(output, `${name}-invocation.private.json`), canonical(record), { flag:'wx',mode:0o600 });
    return { ...record,stdoutText:result.stdout.toString('utf8'),stderrText:result.stderr.toString('utf8') };
  } finally { for (const fd of handles.reverse()) closeSync(fd); }
}

export function syntheticRetainedRunner() {
  return `import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (request.schema !== 'shop.hosted-journey-request/v1') throw Error('Hosted journey request required');
const observations = [];
for (const component of request.components) {
  const bytes = await readFile(component.artifact.path);
  if (hash(bytes) !== component.artifact.sha256 || bytes.length !== component.artifact.bytes) throw Error('Retained artifact differs');
  const artifact = JSON.parse(bytes), files = [];
  for (const file of artifact.files) {
    const contents = await readFile(file.path);
    if (hash(contents) !== file.sha256 || contents.length !== file.bytes) throw Error('Retained payload differs');
    files.push({ path: file.path, sha256: file.sha256 });
  }
  if (artifact.format === 'module-bundle') {
    const code = await readFile(artifact.entrypoint), module = await import('data:text/javascript;base64,' + code.toString('base64'));
    if (module.component !== component.component || module.exercise(request.phase) !== component.component + ':' + request.phase) throw Error('Synthetic module execution differs');
  } else {
    if (artifact.format !== 'oci-layout' || component.component !== 'native') throw Error('Synthetic OCI probe artifact required');
    const index = JSON.parse(await readFile(artifact.entrypoint));
    if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1) throw Error('Synthetic OCI index differs');
  }
  observations.push({ component: component.component, files });
}
const evidence = Buffer.from(JSON.stringify({ scope: 'synthetic-source-workflow-probe', customerJourney: false, awsImageQualified: false, phase: request.phase, compositionDigest: request.compositionDigest, observations }));
const path = 'retained-execution.json'; await writeFile(join(request.evidenceRoot, path), evidence, { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ schema: 'shop.hosted-journey-result/v1', journeyId: request.journeyId, phase: request.phase, compositionDigest: request.compositionDigest, nonce: request.nonce, observations: [{ id: 'synthetic-retained-code-execution', evidence: { path, bytes: evidence.length, sha256: hash(evidence) } }] }));
`;
}
