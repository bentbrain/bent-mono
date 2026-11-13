import { createPrivateKey, createPublicKey } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, check, digest as objectDigest, parseJSON, pathName, readRegularFile, same, sha256 } from './data.mjs';
import { conforms, implementationDigest } from './composition.mjs';
import { readInstalledRoot } from './hosted-admission.mjs';
import { admitCredentialFence } from './hosted-writer.mjs';
import { exactFields, protocolPolicy } from './provider-protocol-builders.mjs';

const installations = new WeakMap();
const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = value => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Exact installed SHA-256 required');
const boundedName = value => check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'Exact installed identity required');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const contains = (directory, path) => path === directory || path.startsWith(`${directory}${sep}`);

async function independentFile(path, excluded, maximum = 16 * 1024 * 1024) {
  check(typeof path === 'string' && path === resolve(path), 'Absolute protected installation path required');
  check(!excluded.some(directory => contains(directory, path)), 'Install protected authority outside source and artifact directories');
  const entry = await lstat(path), parent = await lstat(dirname(path));
  check(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && (entry.mode & 0o777) === 0o600 &&
    parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o777) === 0o700 && await realpath(path) === path &&
    (typeof process.getuid !== 'function' || entry.uid === process.getuid() && parent.uid === process.getuid()), 'Private independently owned installation file required');
  const bytes = await readRegularFile(path, maximum, true), after = await lstat(path);
  check(['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => entry[key] === after[key]), 'Protected installation file changed during inspection');
  return bytes;
}

async function installedReference(reference, excluded, maximum) {
  exactFields(reference, ['path', 'sha256']); hash(reference.sha256);
  const bytes = await independentFile(reference.path, excluded, maximum);
  check(sha256(bytes) === reference.sha256, 'Installed document bytes differ');
  return { bytes, value: parseJSON(bytes, maximum ?? 16 * 1024 * 1024) };
}

function identityMatches(root, identity) {
  check(identity && same(identity.repository, root.repository) && identity.repositoryName === root.repositoryName &&
    root.repositoryName === 'bentbrain/bent-mono' && identity.workflowCommit === identity.head &&
    identity.workflowRef === `${root.repositoryName}/${root.workflowPath}@refs/heads/main`, 'Protected installation source or Actions invocation differs');
  check(/^[a-f0-9]{40}$/.test(identity.head) && Number.isSafeInteger(identity.runId) && identity.runId > 0 &&
    Number.isSafeInteger(identity.attempt) && identity.attempt > 0, 'Exact installation invocation required');
}

/** Reporting recovery reads its installed root and fence independently of artifacts and signing keys. */
export async function readReportingInstallation({ path, digest, identity, repositoryDirectory = checkout, artifactDirectories = [] }) {
  hash(digest); check(Array.isArray(artifactDirectories) && artifactDirectories.every(value => typeof value === 'string'), 'Explicit artifact directory inventory required');
  const excluded = [...new Set([checkout, repositoryDirectory, ...artifactDirectories].map(value => resolve(value)))];
  const bytes = await independentFile(path, excluded);
  check(sha256(bytes) === digest, 'Protected installation digest differs');
  const contract = parseJSON(bytes, 16 * 1024 * 1024);
  exactFields(contract, ['schema', 'scope', 'root', 'compositionTemplate', 'runnerFile', 'targetPlan', 'credentialFence', 'signing',
    'secretInstallations', 'componentConfigurations', 'artifactIntake', 'artifactPrivateKeyFile']);
  check(contract.schema === 'shop.protected-installation/v1' && contract.scope === 'isolated-qualification', 'Protected qualification installation required');
  await installedReference(contract.root, excluded, 65536);
  const root = await readInstalledRoot(contract.root.path, contract.root.sha256); identityMatches(root, identity);
  await installedReference(contract.credentialFence, excluded, 65536);
  return Object.freeze({ rootPath: contract.root.path, rootDigest: contract.root.sha256, fencePath: contract.credentialFence.path });
}

/** Materialize an independently pinned protected package into a fresh private installation. */
export async function installProtectedPackage({ path, digest, destination, identity, repositoryDirectory = checkout, artifactDirectories = [], now = Date.now() }) {
  hash(digest); check(Array.isArray(artifactDirectories) && artifactDirectories.every(value => typeof value === 'string'), 'Explicit artifact directory inventory required');
  const excluded = [...new Set([checkout, repositoryDirectory, ...artifactDirectories].map(value => resolve(value)))], target = resolve(destination);
  check(typeof destination === 'string' && target === destination && !excluded.some(directory => contains(directory, target)) &&
    !contains(target, path) && await realpath(dirname(target)) === dirname(target), 'Install protected package into a separate canonical private directory');
  const bytes = await independentFile(path, [...excluded, target], 32 * 1024 * 1024);
  check(sha256(bytes) === digest, 'Protected installation package digest differs');
  const packed = parseJSON(bytes, 32 * 1024 * 1024);
  exactFields(packed, ['schema', 'contract', 'files', 'directories']);
  check(packed.schema === 'shop.protected-installation-package/v1' && Array.isArray(packed.files) && packed.files.length > 0 && packed.files.length <= 128 &&
    Array.isArray(packed.directories) && packed.directories.length <= 128, 'Bounded protected installation package required');
  const reserved = ['installed-contract.private.json', 'origin-package.private.json'];
  const files = new Map(); let total = 0;
  for (const file of packed.files) {
    exactFields(file, ['path', 'bytes', 'sha256', 'dataBase64']); pathName(file.path); hash(file.sha256);
    check(!reserved.includes(file.path) && !files.has(file.path) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 16 * 1024 * 1024 &&
      typeof file.dataBase64 === 'string' && file.dataBase64.length <= 24 * 1024 * 1024, 'Bounded unique protected package file required');
    const content = Buffer.from(file.dataBase64, 'base64'); total += content.length;
    check(content.toString('base64') === file.dataBase64 && content.length === file.bytes && sha256(content) === file.sha256 && total <= 16 * 1024 * 1024,
      'Protected package file bytes or total bound differs');
    files.set(file.path, content);
  }
  check(same([...files.keys()], [...files.keys()].sort()), 'Protected package file inventory must be sorted');
  const contract = structuredClone(packed.contract);
  exactFields(contract, ['schema', 'scope', 'root', 'compositionTemplate', 'runnerFile', 'targetPlan', 'credentialFence', 'signing',
    'secretInstallations', 'componentConfigurations', 'artifactIntake', 'artifactPrivateKeyFile']);
  check(contract.schema === 'shop.protected-installation/v1' && contract.scope === 'isolated-qualification', 'Protected qualification installation required');
  const referenced = new Set();
  const localFile = path => { pathName(path); check(files.has(path), 'Protected package reference has no exact file'); referenced.add(path); return join(target, path); };
  const reference = value => {
    exactFields(value, ['path', 'sha256']); hash(value.sha256);
    check(files.has(value.path) && sha256(files.get(value.path)) === value.sha256, 'Protected package reference digest differs');
    value.path = localFile(value.path);
  };
  for (const field of ['root', 'compositionTemplate', 'runnerFile', 'targetPlan', 'credentialFence']) reference(contract[field]);
  exactFields(contract.signing, ['source', 'composition']);
  for (const kind of ['source', 'composition']) { exactFields(contract.signing[kind], ['keyId', 'path']); contract.signing[kind].path = localFile(contract.signing[kind].path); }
  check(Array.isArray(contract.componentConfigurations) && contract.componentConfigurations.length <= 32, 'Bounded protected component configurations required');
  for (const component of contract.componentConfigurations) { exactFields(component, ['component', 'config']); reference(component.config); }
  contract.artifactPrivateKeyFile = localFile(contract.artifactPrivateKeyFile);
  const github = contract.artifactIntake?.githubConfigDirectory; pathName(github);
  check(files.has(`${github}/config.yml`) && files.has(`${github}/hosts.yml`), 'Protected package must carry its complete GitHub configuration');
  contract.artifactIntake.githubConfigDirectory = join(target, github);
  for (const path of files.keys()) check(referenced.has(path) || path.startsWith(`${github}/`), 'Unreferenced protected package file');
  const directories = new Set([github]);
  for (const path of files.keys()) { let parent = dirname(path); while (parent !== '.') { directories.add(parent); parent = dirname(parent); } }
  packed.directories.forEach(pathName);
  check(same(packed.directories, [...directories].sort()) && !packed.directories.some(directory => files.has(directory)), 'Protected package directory inventory differs');
  // Every member is a regular 0600 data file. The installed Node interpreter reads the runner.
  await mkdir(target, { mode: 0o700 });
  for (const directory of [...directories].sort()) await mkdir(join(target, directory), { mode: 0o700, recursive: true });
  for (const [relative, content] of files) await writeFile(join(target, relative), content, { mode: 0o600, flag: 'wx' });
  const preservedPath = join(target, reserved[1]); await writeFile(preservedPath, bytes, { mode: 0o600, flag: 'wx' });
  const installedPath = join(target, reserved[0]), installedBytes = Buffer.from(canonical(contract));
  await writeFile(installedPath, installedBytes, { mode: 0o600, flag: 'wx' });
  const actual = [];
  async function inventory(directory, prefix = '') {
    for (const entry of (await readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${entry}` : entry, absolute = join(directory, entry), info = await lstat(absolute);
      check(!info.isSymbolicLink() && (info.mode & 0o777) === (info.isDirectory() ? 0o700 : 0o600), 'Installed package permissions or member type differs');
      if (info.isDirectory()) await inventory(absolute, relative);
      else { check(info.isFile() && info.nlink === 1, 'Installed package member must be a regular data file'); actual.push(relative); }
    }
  }
  await inventory(target);
  check(same(actual.sort(), [...files.keys(), ...reserved].sort()), 'Installed package complete inventory differs');
  for (const [relative, content] of files) check(sha256(await independentFile(join(target, relative), excluded)) === sha256(content), 'Installed package member changed');
  check(sha256(await independentFile(path, [...excluded, target], 32 * 1024 * 1024)) === digest &&
    sha256(await independentFile(preservedPath, excluded, 32 * 1024 * 1024)) === digest &&
    sha256(await independentFile(installedPath, excluded)) === sha256(installedBytes), 'Protected package changed during materialization');
  const installedDigest = sha256(installedBytes);
  const installation = await readProtectedInstallation({ path: installedPath, digest: installedDigest, identity, repositoryDirectory, artifactDirectories, now });
  return { path: installedPath, digest: installedDigest, packageDigest: digest, packagePath: preservedPath, installation };
}

/** The path and raw digest are independently installed protected workflow inputs. */
export async function readProtectedInstallation({ path, digest, identity, repositoryDirectory = checkout, artifactDirectories = [], now = Date.now() }) {
  hash(digest); check(Array.isArray(artifactDirectories) && artifactDirectories.every(value => typeof value === 'string'), 'Explicit artifact directory inventory required');
  const excluded = [...new Set([checkout, repositoryDirectory, ...artifactDirectories].map(value => resolve(value)))];
  const bytes = await independentFile(path, excluded);
  check(sha256(bytes) === digest, 'Protected installation digest differs');
  const contract = parseJSON(bytes, 16 * 1024 * 1024);
  exactFields(contract, ['schema', 'scope', 'root', 'compositionTemplate', 'runnerFile', 'targetPlan', 'credentialFence', 'signing',
    'secretInstallations', 'componentConfigurations', 'artifactIntake', 'artifactPrivateKeyFile']);
  check(contract.schema === 'shop.protected-installation/v1' && contract.scope === 'isolated-qualification', 'Protected qualification installation required');
  await installedReference(contract.root, excluded, 65536);
  const root = await readInstalledRoot(contract.root.path, contract.root.sha256);
  const policy = (await installedReference(contract.compositionTemplate, excluded)).value;
  exactFields(policy, ['schema', 'scope', 'repository', 'keyId', 'publicKeyPem', 'keyFingerprint', 'implementationDigest', 'runner',
    'budgetMs', 'requiredProofKinds', 'closurePolicy', 'revokedReceipts', 'contracts', 'dependencies', 'schemaState']);
  identityMatches(root, identity);
  const { contracts, dependencies, schemaState, ...hosted } = policy;
  conforms({ ...hosted, schema: 'shop.hosted-composition-policy/v1', intentCommits: [identity.head], baseCommit: identity.head,
    inputPaths: ['bun.lock', 'package.json'], snapshots: [{ commit: identity.head, root: `snapshots/${identity.head}`, treeDigest: '0'.repeat(64), files: [
      { path: 'bun.lock', sha256: '0'.repeat(64), mode: '100644' }, { path: 'package.json', sha256: '0'.repeat(64), mode: '100644' }] }] }, 'hostedTrust');
  check(policy.schema === 'shop.hosted-composition-template/v1' && policy.scope === root.scope && same(policy.repository, root.repository) &&
    policy.implementationDigest === await implementationDigest(), 'Installed composition template or verifier differs');
  const runnerBytes = await independentFile(contract.runnerFile.path, excluded);
  exactFields(contract.runnerFile, ['path', 'sha256']); hash(contract.runnerFile.sha256);
  check(sha256(runnerBytes) === contract.runnerFile.sha256 && policy.runner.script.sha256 === contract.runnerFile.sha256 &&
    policy.runner.script.bytes === runnerBytes.length, 'Installed journey runner differs');
  check(contracts && same(Object.keys(contracts).sort(), [...policy.closurePolicy.components].sort()) && Array.isArray(dependencies) && schemaState,
    'Installed component contracts and topology required');
  const compositionKey = root.compositionKeys.find(key => key.id === policy.keyId);
  check(compositionKey && compositionKey.spkiSha256 === policy.keyFingerprint && compositionKey.publicKeyPem === policy.publicKeyPem,
    'Composition key differs from independent root');
  const plan = (await installedReference(contract.targetPlan, excluded)).value;
  exactFields(plan, ['schema', 'scope', 'providerPolicy', 'targets', 'deploymentId', 'journeyOrigin']);
  check(plan.schema === 'shop.hosted-target-plan/v1' && plan.scope === root.scope, 'Installed target plan scope differs');
  const providerPolicy = protocolPolicy(plan.providerPolicy);
  check(objectDigest(providerPolicy) === root.providerPolicyDigest && providerPolicy.github.repository === root.repositoryName &&
    providerPolicy.github.environment === root.environment && providerPolicy.github.deploymentIds.includes(plan.deploymentId) &&
    policy.runner.origins.includes(plan.journeyOrigin), 'Installed target policy or reporting identity differs');
  check(Array.isArray(plan.targets) && same(plan.targets.map(target => target.component).sort(), [...policy.closurePolicy.components].sort()) &&
    new Set(plan.targets.map(target => target.component)).size === plan.targets.length &&
    plan.targets.every(target => target.kind === (target.component === 'native' ? 'lambda' : 'worker')), 'Installed component targets differ');
  const fence = (await installedReference(contract.credentialFence, excluded, 65536)).value;
  admitCredentialFence(fence, { keys: root.credentialBroker.keys, policy: providerPolicy, environmentId: root.credentialBroker.environmentId,
    brokerId: root.credentialBroker.id, implementationDigest: root.credentialBroker.implementationDigest, now });
  exactFields(contract.signing, ['source', 'composition']);
  for (const [kind, keys] of [['source', root.sourceAuthorityKeys], ['composition', root.compositionKeys]]) {
    const installed = contract.signing[kind]; exactFields(installed, ['keyId', 'path']); boundedName(installed.keyId);
    check(keys.some(key => key.id === installed.keyId), 'Signing key is absent from independent root');
    // Validate ownership and location without loading a private signing key.
    const entry = await lstat(installed.path);
    check(entry.size <= 4096, 'Bounded installed signing key required');
    check(typeof installed.path === 'string' && installed.path === resolve(installed.path) && !excluded.some(directory => contains(directory, installed.path)) &&
      entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && (entry.mode & 0o777) === 0o600 && await realpath(installed.path) === installed.path,
    'Independent private signing key path required');
  }
  check(contract.signing.source.path !== contract.signing.composition.path && contract.signing.composition.keyId === policy.keyId, 'Distinct installed source and composition keys required');
  check(Array.isArray(contract.secretInstallations) && contract.secretInstallations.length <= 128, 'Bounded installed secret inventory required');
  for (const secret of contract.secretInstallations) { exactFields(secret, ['name', 'version', 'sha256']); boundedName(secret.name); boundedName(secret.version); hash(secret.sha256); }
  check(new Set(contract.secretInstallations.map(secret => secret.name)).size === contract.secretInstallations.length &&
    same(contract.secretInstallations.map(secret => secret.name).sort(), [...root.requiredSecrets].sort()), 'Installed secret versions differ');
  check(Array.isArray(contract.componentConfigurations) && same(contract.componentConfigurations.map(item => item.component).sort(), [...policy.closurePolicy.components].sort()) &&
    new Set(contract.componentConfigurations.map(item => item.component)).size === contract.componentConfigurations.length, 'Complete installed component configurations required');
  for (const item of contract.componentConfigurations) {
    exactFields(item, ['component', 'config']); boundedName(item.component);
    const config = (await installedReference(item.config, excluded)).value; conforms(config, 'hostedConfig'); check(config.component === item.component, 'Installed configuration component differs');
  }
  check(contract.artifactIntake && typeof contract.artifactIntake === 'object' && !Array.isArray(contract.artifactIntake), 'Installed artifact admission required');
  check(contract.artifactIntake.repository?.name === root.repositoryName && contract.artifactIntake.repository?.id === root.repository.repositoryId &&
    contract.artifactIntake.repository?.ownerId === root.repository.ownerId, 'Artifact admission repository differs from installed root');
  await independentFile(contract.artifactPrivateKeyFile, excluded, 16384);
  const installation = freeze({ contract, root, template: policy, plan, providerPolicy, rootPath: contract.root.path, rootDigest: contract.root.sha256,
    planPath: contract.targetPlan.path, fencePath: contract.credentialFence.path, fenceDigest: contract.credentialFence.sha256,
    secretInstallations: contract.secretInstallations, sourceKeyPath: contract.signing.source.path, compositionKeyPath: contract.signing.composition.path,
    artifactIntake: contract.artifactIntake, artifactPrivateKeyFile: contract.artifactPrivateKeyFile });
  installations.set(installation, { path, digest, identity: structuredClone(identity), repositoryDirectory, artifactDirectories: [...artifactDirectories], now });
  return installation;
}

export function assertProtectedInstallation(installation) { check(installations.has(installation), 'Read an independently pinned protected installation first'); }
export async function refreshProtectedInstallation(installation, now = Date.now(), artifactDirectories = []) {
  assertProtectedInstallation(installation); const state = installations.get(installation);
  return readProtectedInstallation({ ...state, artifactDirectories: [...state.artifactDirectories, ...artifactDirectories], now });
}
export async function installedSigningKey(installation, kind) {
  assertProtectedInstallation(installation); check(['source', 'composition'].includes(kind), 'Unknown installed signer');
  const installed = installation.contract.signing[kind], state = installations.get(installation);
  const bytes = await independentFile(installed.path, [...new Set([checkout, state.repositoryDirectory, ...state.artifactDirectories].map(value => resolve(value)))], 4096);
  const privateKey = createPrivateKey(bytes), publicKey = createPublicKey(privateKey);
  const pinned = (kind === 'source' ? installation.root.sourceAuthorityKeys : installation.root.compositionKeys).find(key => key.id === installed.keyId);
  check(privateKey.asymmetricKeyType === 'ec' && privateKey.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
    sha256(publicKey.export({ type: 'spki', format: 'der' })) === pinned.spkiSha256, 'Installed signing key SPKI differs');
  return { keyId: installed.keyId, privateKey };
}
