import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, sha256 } from '../data.mjs';
import { implementationDigest, subject, allInputs } from '../composition.mjs';

const commitA = 'a'.repeat(40), commitB = 'b'.repeat(40), baseCommit = 'c'.repeat(40);
export const fixtureEnvironment = () => ({ PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? tmpdir() });
export async function fixture({ root, runnerSource, budgetMs = 600000 } = {}) {
  const suppliedDirectory = root ?? await mkdtemp(join(tmpdir(), 'shop-release-v2-'));
  await mkdir(suppliedDirectory, { mode: 0o700, recursive: true });
  const directory = await realpath(suppliedDirectory);
  const bundle = join(directory, 'bundle'), journal = join(directory, 'journal');
  await mkdir(bundle, { mode: 0o700, recursive: true });
  const put = async (path, value) => {
    const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(canonical(value));
    await mkdir(dirname(join(bundle, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(bundle, path), bytes, { mode: 0o600 });
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  };
  const inputs = [];
  for (const [path, bytes] of Object.entries({ 'bun.lock': 'synthetic-lock-v1', 'package.json': '{"name":"synthetic-fixture"}',
    'src/consumer.mjs': 'export const version = 2;', 'src/producer.mjs': 'export const protocol = "protocol-n";', 'policy/full-qualification.json': '{"lane":"full"}' })) {
    await put(`snapshots/${commitA}/${path}`, bytes); await put(`snapshots/${commitB}/${path}`, bytes);
    inputs.push({ path, sha256: sha256(bytes) });
  }
  inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const inputsRef = await put('metadata/full-inputs.json', { schema: 'shop.full-inputs/v1', files: inputs });
  const runner = await put('runner.mjs', runnerSource ?? await readFile(fileURLToPath(new URL('./fixture-journey.mjs', import.meta.url))));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const trust = { schema: 'shop.fixture-trust/v1', scope: 'inactive-loopback', repository: { ownerId: 10, repositoryId: 20 }, intentCommits: [commitA, commitB], baseCommit,
    keyId: 'ephemeral-fixture', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), keyFingerprint: sha256(publicKey.export({ type: 'spki', format: 'der' })),
    implementationDigest: await implementationDigest(), inputPaths: inputs.map(item => item.path),
    snapshots: [commitA, commitB].map(commit => ({ commit, root: `snapshots/${commit}`, treeDigest: digest(inputs) })),
    runner: { id: 'controller-http-identity', script: runner, executableDigest: sha256(await readFile(process.execPath)), timeoutMs: 5000, origins: [], requiredObservations: ['http-artifact-identity'] },
    budgetMs, requiredProofKinds: ['source', 'security', 'review', 'artifact', 'compatibility', 'qualification', 'owner'] };
  const trustPath = join(directory, 'fixture-trust.json');
  await writeFile(trustPath, canonical(trust), { mode: 0o600 });
  const contract = { current: 'protocol-n', previous: 'protocol-n-minus-one', accepts: ['protocol-n', 'protocol-n-minus-one'], emits: ['protocol-n'],
    capabilities: ['stable-callback'], requiresCapabilities: ['stable-callback'], storageReads: ['data-v1'], storageWrites: ['data-v1'],
    jobHandlers: ['job-v1', 'job-v2'], rollbackRequirements: ['stable-callback'] };
  const components = [];
  for (const id of ['consumer', 'producer']) {
    const originSourceCommit = id === 'consumer' ? commitA : commitB;
    const files = [await put(`artifacts/${id}/index.mjs`, `export const component = '${id}';`)];
    const inventory = files.map(file => ({ ...file, mediaType: 'application/javascript' }));
    const config = await put(`metadata/${id}-config.json`, { schema: 'shop.fixture-config/v1', fixture: true, component: id, bindings: [{ name: 'fixture-binding', valueDigest: sha256('synthetic-binding') }] });
    const provenance = await put(`metadata/${id}-provenance.json`, { schema: 'shop.fixture-provenance/v1', component: id, originSourceCommit,
      sourceTreeDigest: digest(inputs), inputsDigest: digest(inputs), artifactFilesDigest: digest(inventory), recipeDigest: sha256('fixture-recipe'),
      toolchainDigest: sha256(process.version), dependencyLockDigest: inputs.find(item => item.path === 'bun.lock').sha256 });
    const artifact = await put(`metadata/${id}-artifact.json`, { schema: 'shop.artifact/v1', component: id, format: 'module-bundle', root: `artifacts/${id}`, entrypoint: files[0].path,
      files: inventory, originSourceCommit, inputsDigest: digest(inputs), configDigest: config.sha256, provenanceDigest: provenance.sha256 });
    components.push({ id, originSourceCommit, sourceTreeDigest: digest(inputs), inputsDigest: digest(inputs), intentInputsDigest: digest(inputs),
      inputsRef, intentInputsRef: inputsRef, artifact, config, provenance, contract: structuredClone(contract) });
  }
  const payload = { schema: 'shop.release-composition/v1', repository: trust.repository, target: 'inactive-local', intentSourceCommit: commitB, baseCommit,
    createdAt: '2026-11-12T23:00:00.000Z', policyDigest: digest(trust), parentCompositionDigest: null, rollbackCompositionDigest: null, changeClass: 'compatible',
    schemaState: { epoch: 1, ledgerDigest: sha256('fixture-ledger'), rollbackEpochs: [1] }, components,
    dependencies: [{ producer: 'producer', consumer: 'consumer', formats: ['protocol-n'], capabilities: ['stable-callback'] }], proofRefs: [] };
  const signManifest = async (value, name = 'composition.json') => {
    const envelope = { payload: value, signature: { payloadType: value.schema, payloadDigest: digest(value), keyId: trust.keyId, algorithm: 'ECDSA_SHA_256', signer: 'local-fixture',
      signature: sign('sha256', Buffer.from(canonical(value)), privateKey).toString('base64') } };
    const path = join(directory, name);
    await writeFile(path, canonical(envelope), { mode: 0o600 });
    return path;
  };
  const seal = async (value = payload, name = 'composition.json') => {
    value.proofRefs = [];
    for (const kind of trust.requiredProofKinds) {
      const evidence = await put(`proofs/${name}/${kind}-evidence.json`, { schema: 'synthetic-evidence/v1', kind, scope: 'controller-fixture-only', subject: subject(value) });
      const receipt = await put(`proofs/${name}/${kind}.json`, { schema: 'shop.fixture-receipt/v1', scope: 'inactive-local', kind,
        subjectDigest: subject(value), inputsDigest: allInputs(value), policyDigest: value.policyDigest, verifierDigest: trust.implementationDigest, evidence });
      value.proofRefs.push({ kind, receipt });
    }
    value.proofRefs.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
    return signManifest(value, name);
  };
  const manifest = await seal();
  return { directory, bundle, journal, trust, trustPath, payload, manifest, seal, signManifest, put };
}
