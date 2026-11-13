// Independently installed synthetic keys and API records exercise the real issuer.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, check, digest, sha256 } from '../data.mjs';
import { implementationDigest } from '../composition.mjs';
import { protocolPolicy } from '../provider-protocol-builders.mjs';
import { importHostedPortable } from '../artifact-intake.mjs';
import { readProtectedInstallation } from '../protected-installation.mjs';
import { protocolFixture } from './provider-protocol-transcript.mjs';
import { createArtifactIntakeFixture } from './artifact-intake-fixture.mjs';

const qualityJobs = ['lint', 'typecheck', 'test', 'knip', 'build', 'test:integration', 'browser', 'shop',
  'public-source', 'secret-scan', 'dependencies', 'CodeQL', 'Release qualification'];
const pair = id => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { ...keys, entry: { id, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }), spkiSha256: sha256(keys.publicKey.export({ type: 'spki', format: 'der' })) } };
};

function syntheticQualityApi({ identity, acceptedAt, base = 'c'.repeat(40), tree = 'd'.repeat(40) }) {
  const prefix = '/repos/bentbrain/bent-mono', source = identity.head, reviewed = 'e'.repeat(40);
  const repository = { id: identity.repository.repositoryId, owner: { id: identity.repository.ownerId }, full_name: identity.repositoryName };
  const quality = { id: 111, run_attempt: 1, head_sha: source, head_branch: 'main', event: 'push', path: '.github/workflows/quality.yml',
    workflow_id: 222, repository, head_repository: repository, status: 'completed', conclusion: 'success' };
  const invocation = { id: identity.runId, run_attempt: identity.attempt, head_sha: source, head_branch: 'main', event: 'workflow_dispatch',
    path: '.github/workflows/shop-composition-qualification.yml', workflow_id: 333, repository, head_repository: repository, status: 'in_progress', conclusion: null };
  const documents = new Map([
    [prefix, repository], [`${prefix}/git/commits/${source}`, { sha: source, tree: { sha: tree }, parents: [{ sha: base }] }],
    [`${prefix}/git/ref/heads/main`, { object: { sha: source } }],
    [`${prefix}/actions/workflows/shop-composition-qualification.yml`, { id: 333, state: 'active', path: invocation.path }],
    [`${prefix}/actions/runs/${identity.runId}`, invocation],
    [`${prefix}/actions/workflows/quality.yml`, { id: 222, state: 'active', path: quality.path }],
    [`${prefix}/actions/workflows/222/runs?branch=main&event=push&head_sha=${source}&per_page=100&page=1`, { workflow_runs: [quality] }],
    [`${prefix}/actions/runs/111/attempts/1/jobs?per_page=100&page=1`, { jobs: qualityJobs.map((name, index) => ({ id: 500 + index, name, head_sha: source, status: 'completed', conclusion: 'success' })) }],
    [`${prefix}/commits/${source}/pulls?per_page=100&page=1`, [{ number: 40, merged_at: new Date(acceptedAt).toISOString(), merge_commit_sha: source,
      base: { ref: 'main', repo: repository }, head: { sha: reviewed, repo: repository } }]],
    [`${prefix}/commits/${reviewed}/check-runs?filter=latest&per_page=100&page=1`, { check_runs: [{ name: 'CodeQL', app: { slug: 'github-advanced-security' }, head_sha: reviewed, status: 'completed', conclusion: 'success' }] }],
    [`${prefix}/commits/${reviewed}/statuses?per_page=100&page=1`, [{ context: 'Independent review', state: 'success', target_url: `https://github.com/bentbrain/bent-mono/pull/40#issuecomment-synthetic` }]],
    [`${prefix}/actions/runs/111`, quality],
  ]), calls = [];
  const api = async path => { calls.push(path); check(documents.has(path), `Unexpected synthetic quality API path: ${path}`); return structuredClone(documents.get(path)); };
  return { api, documents, calls, quality, invocation, acceptedAt, base, tree };
}

export async function createBootstrapFixture(t, { root, providerPolicy: suppliedProviderPolicy, plan: suppliedPlan, fenceReceipt,
  brokerKeys, brokerOrigin = 'https://qualification.example.invalid', runner = Buffer.from('process.exit(0);'), sourceCommit = '1'.repeat(40), imported: suppliedImported,
  intakeFixture: suppliedIntakeFixture, acceptedAt = Date.now() - 2000, maximumLifetimeMs = 600000, runId = 10, attempt = 1, keys, sourceBase = 'c'.repeat(40) } = {}) {
  check(typeof root === 'string', 'Explicit private synthetic fixture directory required');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'bootstrap-')); t.after(() => rm(directory, { force: true, recursive: true }));
  const privateRoot = join(directory, 'installed'); await mkdir(privateRoot, { mode: 0o700 });
  const intake = suppliedIntakeFixture ?? await createArtifactIntakeFixture(t, { root: directory, sourceCommit });
  const imported = suppliedImported ?? await importHostedPortable({ ...intake, destination: join(directory, 'imported') });
  const portable = imported.portable, source = keys?.source ?? pair('source-authority'), composition = keys?.composition ?? pair('composition-authority');
  const broker = generateKeyPairSync('ed25519');
  const put = async (name, value) => {
    const path = join(privateRoot, name), bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonical(value));
    await writeFile(path, bytes, { mode: 0o600 }); return { path, sha256: sha256(bytes) };
  };
  const original = protocolFixture().policy;
  const providerPolicy = protocolPolicy(suppliedProviderPolicy ?? { ...original, github: { ...original.github, environment: 'Preview' } });
  const repository = { ownerId: intake.installation.repository.ownerId, repositoryId: intake.installation.repository.id };
  const rootDocument = { schema: 'shop.hosted-trust-root/v1', scope: 'isolated-qualification', repository, repositoryName: 'bentbrain/bent-mono', environment: 'Preview',
    workflowPath: '.github/workflows/shop-composition-qualification.yml', sourceAuthorityKeys: [source.entry], compositionKeys: [composition.entry],
    providerPolicyDigest: digest(providerPolicy), requiredSecrets: [], revokedAuthorities: [], maximumLifetimeMs,
    credentialBroker: { id: fenceReceipt?.payload.brokerId ?? 'synthetic-custody', environmentId: fenceReceipt?.payload.environmentId ?? 'synthetic-qualification',
      implementationDigest: fenceReceipt?.payload.implementationDigest ?? sha256('synthetic-reviewed-custody'), origin: brokerOrigin,
      audience: 'qualification-writer', subject: 'repo:bentbrain/bent-mono:environment:Preview',
      keys: brokerKeys ?? [{ id: 'broker-key', publicKeyPem: broker.publicKey.export({ type: 'spki', format: 'pem' }) }] } };
  const runnerBytes = Buffer.from(runner), runnerFile = await put('runner.mjs', runnerBytes);
  const contract = { current: 'protocol-n', previous: 'protocol-n-minus-one', accepts: ['protocol-n', 'protocol-n-minus-one'], emits: ['protocol-n'],
    capabilities: ['stable-callback'], requiresCapabilities: ['stable-callback'], storageReads: ['data-v1'], storageWrites: ['data-v1'], jobHandlers: ['job-v1', 'job-v2'], rollbackRequirements: ['stable-callback'] };
  const template = { schema: 'shop.hosted-composition-template/v1', scope: rootDocument.scope, repository, keyId: composition.entry.id,
    publicKeyPem: composition.entry.publicKeyPem, keyFingerprint: composition.entry.spkiSha256, implementationDigest: await implementationDigest(),
    runner: { id: 'synthetic-retained-source', script: { path: 'release-runner/journey.mjs', bytes: runnerBytes.length, sha256: runnerFile.sha256 },
      executableDigest: sha256(await readFile(process.execPath)), timeoutMs: 10000,
      origins: [suppliedPlan?.journeyOrigin ?? 'https://qualification.example.invalid'], requiredObservations: ['synthetic-retained-code-execution'] },
    budgetMs: 600000, requiredProofKinds: ['source', 'security', 'review', 'artifact', 'compatibility', 'qualification', 'owner'],
    closurePolicy: portable.closurePolicy, revokedReceipts: [], contracts: Object.fromEntries([...portable.components.keys()].map(id => [id, contract])), dependencies: [],
    schemaState: { epoch: 1, ledgerDigest: sha256('synthetic-ledger'), rollbackEpochs: [1] } };
  const plan = suppliedPlan ?? { schema: 'shop.hosted-target-plan/v1', scope: rootDocument.scope, providerPolicy,
    targets: [...portable.components.keys()].map(component => ({ component, kind: component === 'native' ? 'lambda' : 'worker' })),
    deploymentId: providerPolicy.github.deploymentIds[0], journeyOrigin: template.runner.origins[0] };
  const issuedAt = Date.now() - 1000;
  const fencePayload = { schema: 'shop.credential-fence/v1', scope: 'protected-provider-writer', environmentId: rootDocument.credentialBroker.environmentId,
    policyDigest: digest(providerPolicy), brokerId: rootDocument.credentialBroker.id, implementationDigest: rootDocument.credentialBroker.implementationDigest,
    credentialCustody: 'broker-exclusive', ownership: 'non-expiring-single-writer', sendBoundary: 'atomic-owner-check-and-dispatch',
    reassignment: 'stop-drain-revoke-before-reassign', issuedAt, expiresAt: issuedAt + 600000 };
  const receipt = fenceReceipt ?? { keyId: 'broker-key', payload: fencePayload, signature: sign(null, Buffer.from(canonical(fencePayload)), broker.privateKey).toString('base64') };
  const sourceKey = await put('source.pem', source.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const compositionKey = await put('composition.pem', composition.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const componentConfigurations = [];
  for (const component of portable.components.keys()) componentConfigurations.push({ component, config: await put(`config-${component}.json`, {
    schema: 'shop.binding-installation/v1', scope: rootDocument.scope, component, bindings: [] }) });
  const installationContract = { schema: 'shop.protected-installation/v1', scope: rootDocument.scope,
    root: await put('root.json', rootDocument), compositionTemplate: await put('template.json', template), runnerFile,
    targetPlan: await put('plan.json', plan), credentialFence: await put('fence.json', receipt),
    signing: { source: { keyId: source.entry.id, path: sourceKey.path }, composition: { keyId: composition.entry.id, path: compositionKey.path } },
    secretInstallations: [], componentConfigurations, artifactIntake: intake.installation, artifactPrivateKeyFile: intake.privateKeyFile };
  const installationRef = await put('installation.json', installationContract);
  const identity = { repository, repositoryName: rootDocument.repositoryName, head: sourceCommit, workflowCommit: sourceCommit,
    workflowRef: `${rootDocument.repositoryName}/${rootDocument.workflowPath}@refs/heads/main`, runId, attempt };
  const installation = await readProtectedInstallation({ ...installationRef, digest: installationRef.sha256, identity,
    artifactDirectories: [portable.root, join(directory, 'assembly')] });
  const quality = syntheticQualityApi({ identity, acceptedAt, base: sourceBase });
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: identity.head, GITHUB_WORKFLOW_SHA: identity.head,
    GITHUB_REPOSITORY: identity.repositoryName, GITHUB_REPOSITORY_ID: String(repository.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(repository.ownerId),
    GITHUB_RUN_ID: String(identity.runId), GITHUB_RUN_ATTEMPT: String(identity.attempt), GITHUB_WORKFLOW_REF: identity.workflowRef };
  return { directory, installation, installationPath: installationRef.path, installationDigest: installationRef.sha256, installationContract, root: rootDocument,
    identity, env, imported, portable, intake, template, plan, quality, qualityApi: quality.api, acceptedAt,
    destination: join(directory, 'assembly'), evidenceDirectory: join(directory, 'evidence'), sourceKey: source, compositionKey: composition, keys: { source, composition } };
}

export async function createProtectedPackageFixture(f) {
  const contract = structuredClone(f.installationContract), files = [];
  const include = async (path, absolute) => {
    const bytes = await readFile(absolute); files.push({ path, bytes: bytes.length, sha256: sha256(bytes), dataBase64: bytes.toString('base64') });
    return path;
  };
  for (const [field, path] of [['root', 'root.json'], ['compositionTemplate', 'template.json'], ['runnerFile', 'runner.mjs'], ['targetPlan', 'plan.json'], ['credentialFence', 'fence.json']])
    contract[field].path = await include(path, contract[field].path);
  for (const kind of ['source', 'composition']) contract.signing[kind].path = await include(`${kind}.pem`, contract.signing[kind].path);
  for (const configuration of contract.componentConfigurations) configuration.config.path = await include(`config-${configuration.component}.json`, configuration.config.path);
  contract.artifactPrivateKeyFile = await include('artifact-recipient.pem', contract.artifactPrivateKeyFile);
  contract.artifactIntake.githubConfigDirectory = 'github';
  for (const [path, content] of [['github/config.yml', 'git_protocol: https\n'], ['github/hosts.yml', 'github.com:\n    user: synthetic\n']]) {
    const bytes = Buffer.from(content); files.push({ path, bytes: bytes.length, sha256: sha256(bytes), dataBase64: bytes.toString('base64') });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const packed = { schema: 'shop.protected-installation-package/v1', contract, files, directories: ['github'] };
  const bytes = Buffer.from(canonical(packed)), path = join(f.directory, 'protected-package.private.json');
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  return { path, digest: sha256(bytes), destination: join(f.directory, 'package-installation'), identity: f.identity, packed };
}
