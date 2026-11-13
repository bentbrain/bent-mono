import { createPublicKey, verify } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { canonical, check, digest, parseJSON, readRef, readRegularFile, same, sha256 } from './data.mjs';
import { admitComposition, conforms, implementationDigest } from './composition.mjs';
import { exactFields } from './provider-protocol-builders.mjs';

const hash = value => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Exact SHA-256 required');
const commit = value => check(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), 'Full source commit required');
const integer = value => check(Number.isSafeInteger(value) && value > 0, 'Positive identity required');
const name = value => check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'Bounded installation identity required');
const unique = (items, key) => check(new Set(items.map(key)).size === items.length, 'Duplicate protected subject');
const boundedArray = (items, minimum = 1, maximum = 128) => check(Array.isArray(items) && items.length >= minimum && items.length <= maximum, 'Protected subject inventory is incomplete');

function publicKey(entry) {
  exactFields(entry, ['id', 'publicKeyPem', 'spkiSha256']); name(entry.id); hash(entry.spkiSha256);
  check(typeof entry.publicKeyPem === 'string' && entry.publicKeyPem.length <= 1024, 'Bounded composition public key required');
  const key = createPublicKey(entry.publicKeyPem);
  check(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
    sha256(key.export({ type: 'spki', format: 'der' })) === entry.spkiSha256, 'P-256 protected key identity differs');
  return key;
}

export function validateHostedRoot(root) {
  exactFields(root, ['schema', 'scope', 'repository', 'repositoryName', 'environment', 'workflowPath',
    'sourceAuthorityKeys', 'compositionKeys', 'providerPolicyDigest', 'requiredSecrets', 'revokedAuthorities', 'maximumLifetimeMs', 'credentialBroker']);
  check(root.schema === 'shop.hosted-trust-root/v1' && root.scope === 'isolated-qualification' && root.environment === 'Preview' &&
    root.workflowPath === '.github/workflows/shop-composition-qualification.yml', 'Protected qualification trust root required');
  exactFields(root.repository, ['ownerId', 'repositoryId']); integer(root.repository.ownerId); integer(root.repository.repositoryId);
  check(typeof root.repositoryName === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(root.repositoryName), 'Exact repository name required');
  hash(root.providerPolicyDigest);
  boundedArray(root.sourceAuthorityKeys, 1, 8); boundedArray(root.compositionKeys, 1, 8);
  const keys = [...root.sourceAuthorityKeys, ...root.compositionKeys]; unique(keys, key => key.id); unique(keys, key => key.spkiSha256); keys.forEach(publicKey);
  boundedArray(root.requiredSecrets, 0); root.requiredSecrets.forEach(name); unique(root.requiredSecrets, item => item);
  boundedArray(root.revokedAuthorities, 0, 4096); root.revokedAuthorities.forEach(hash); unique(root.revokedAuthorities, item => item);
  check(Number.isSafeInteger(root.maximumLifetimeMs) && root.maximumLifetimeMs > 0 && root.maximumLifetimeMs <= 3600000, 'Bounded source authority lifetime required');
  const broker = root.credentialBroker;
  exactFields(broker, ['id', 'environmentId', 'implementationDigest', 'origin', 'audience', 'subject', 'keys']);
  name(broker.id); name(broker.environmentId); hash(broker.implementationDigest);
  check(typeof broker.origin === 'string' && /^https:\/\/[a-z0-9][a-z0-9.-]{1,240}$/.test(broker.origin) &&
    new URL(broker.origin).origin === broker.origin && typeof broker.audience === 'string' && broker.audience.length > 0 && broker.audience.length <= 256,
  'Exact protected credential broker origin and audience required');
  check(typeof broker.subject === 'string' && broker.subject.length > 0 && broker.subject.length <= 1024 && !/[\x00-\x20\x7f]/.test(broker.subject), 'Exact installed Actions subject required');
  boundedArray(broker.keys, 1, 8); unique(broker.keys, item => item.id);
  for (const entry of broker.keys) {
    exactFields(entry, ['id', 'publicKeyPem']); name(entry.id);
    check(typeof entry.publicKeyPem === 'string' && entry.publicKeyPem.length <= 4096 && createPublicKey(entry.publicKeyPem).asymmetricKeyType === 'ed25519', 'Ed25519 credential broker key required');
  }
  return root;
}

// The file's expected digest comes from the existing protected installation,
// independently of the bundle or PR. Public bundle metadata cannot install it.
export async function readInstalledRoot(path, expectedDigest) {
  hash(expectedDigest);
  const absolute = resolve(path), entry = await lstat(absolute);
  check(entry.isFile() && !entry.isSymbolicLink() && (entry.mode & 0o077) === 0 && await realpath(absolute) === absolute &&
    entry.size <= 65536, 'Separate private installed trust root required');
  const bytes = await readRegularFile(absolute, 65536, true); check(sha256(bytes) === expectedDigest, 'Installed trust root digest differs');
  return validateHostedRoot(parseJSON(bytes, 65536));
}
export async function readHostedRoot(path, expectedDigest, bundle) {
  const base = await realpath(bundle), absolute = resolve(path);
  check(absolute !== base && !absolute.startsWith(`${base}${sep}`), 'Separate private installed trust root required');
  return readInstalledRoot(path, expectedDigest);
}

export function actionsIdentity(env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main', 'Canonical protected workflow dispatch required');
  const id = value => { check(typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value), 'Exact Actions identity required'); const result = Number(value); integer(result); return result; };
  commit(env.GITHUB_SHA); commit(env.GITHUB_WORKFLOW_SHA);
  check(env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA && typeof env.GITHUB_WORKFLOW_REF === 'string', 'Executing workflow source differs');
  return { repository: { ownerId: id(env.GITHUB_REPOSITORY_OWNER_ID), repositoryId: id(env.GITHUB_REPOSITORY_ID) },
    repositoryName: env.GITHUB_REPOSITORY, head: env.GITHUB_SHA, workflowCommit: env.GITHUB_WORKFLOW_SHA,
    workflowRef: env.GITHUB_WORKFLOW_REF, runId: id(env.GITHUB_RUN_ID), attempt: id(env.GITHUB_RUN_ATTEMPT) };
}

export function verifyAuthoritySeal(envelope, root) {
  validateHostedRoot(root); exactFields(envelope, ['payload', 'signature']);
  exactFields(envelope.signature, ['algorithm', 'keyId', 'payloadDigest', 'signature']);
  const { payload, signature } = envelope;
  hash(signature.payloadDigest);
  const key = root.sourceAuthorityKeys.find(item => item.id === signature.keyId);
  check(key && signature.algorithm === 'ECDSA_SHA_256' && signature.payloadDigest === digest(payload) &&
    typeof signature.signature === 'string' && signature.signature.length <= 512 && /^[A-Za-z0-9+/]+={0,2}$/.test(signature.signature) &&
    verify('sha256', Buffer.from(canonical(payload)), publicKey(key), Buffer.from(signature.signature, 'base64')), 'Protected source authority signature differs');
  check(!root.revokedAuthorities.includes(digest(envelope)), 'Protected source authority is revoked');
  return { payload, authorityDigest: digest(envelope) };
}

export function verifyHostedAuthority(envelope, { root, identity, now = Date.now() }) {
  const { payload } = verifyAuthoritySeal(envelope, root);
  exactFields(payload, ['schema', 'scope', 'repository', 'repositoryName', 'environment', 'head', 'base', 'tree', 'workflowPath',
    'workflowCommit', 'runId', 'attempt', 'issuedAt', 'expiresAt', 'acceptedAt', 'policy', 'providerPolicyDigest',
    'portableManifests', 'secretInstallations', 'writerFenceDigest', 'targetPlanDigest', 'quality']);
  check(payload.schema === 'shop.hosted-source-authority/v1' && payload.scope === root.scope && payload.environment === root.environment &&
    same(payload.repository, root.repository) && payload.repositoryName === root.repositoryName && payload.workflowPath === root.workflowPath,
  'Source authority target differs');
  for (const value of [payload.head, payload.base, payload.tree, payload.workflowCommit]) commit(value);
  integer(payload.runId); integer(payload.attempt);
  check(identity && same(payload.repository, identity.repository) && payload.repositoryName === identity.repositoryName && payload.head === identity.head &&
    payload.workflowCommit === payload.head && payload.workflowCommit === identity.workflowCommit && payload.runId === identity.runId && payload.attempt === identity.attempt &&
    identity.workflowRef === `${root.repositoryName}/${root.workflowPath}@refs/heads/main`, 'Authority is for another Actions invocation');
  check(Number.isSafeInteger(now) && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt) &&
    Number.isSafeInteger(payload.acceptedAt) && payload.acceptedAt <= payload.issuedAt && payload.acceptedAt > 0 &&
    payload.issuedAt <= now && payload.expiresAt > now && payload.expiresAt - payload.issuedAt <= root.maximumLifetimeMs, 'Source authority expired or has an invalid measurement interval');
  conforms(payload.policy, 'hostedTrust');
  check(payload.policy.scope === root.scope && same(payload.policy.repository, root.repository) && payload.policy.baseCommit === payload.base &&
    payload.policy.intentCommits.includes(payload.head), 'Composition policy source differs');
  const compositionKey = root.compositionKeys.find(item => item.id === payload.policy.keyId);
  check(compositionKey && compositionKey.spkiSha256 === payload.policy.keyFingerprint && compositionKey.publicKeyPem === payload.policy.publicKeyPem,
    'Composition signing key is not independently installed');
  hash(payload.providerPolicyDigest); hash(payload.writerFenceDigest); hash(payload.targetPlanDigest);
  check(payload.providerPolicyDigest === root.providerPolicyDigest, 'Provider targets differ from installed policy');
  boundedArray(payload.portableManifests, 1, 32); unique(payload.portableManifests, item => item.component);
  for (const artifact of payload.portableManifests) {
    exactFields(artifact, ['component', 'manifestSha256', 'originSourceCommit', 'lineageDigest', 'codeDigest', 'configDigest', 'runtimeDigest', 'qualificationDigest', 'awsImageQualified']);
    name(artifact.component); commit(artifact.originSourceCommit);
    for (const field of ['manifestSha256', 'lineageDigest', 'codeDigest', 'configDigest', 'runtimeDigest', 'qualificationDigest']) hash(artifact[field]);
    check(typeof artifact.awsImageQualified === 'boolean', 'Explicit native image qualification required');
  }
  boundedArray(payload.secretInstallations, 0); unique(payload.secretInstallations, item => item.name);
  for (const installation of payload.secretInstallations) {
    exactFields(installation, ['name', 'version', 'sha256']); name(installation.name); name(installation.version); hash(installation.sha256);
  }
  check(same(payload.secretInstallations.map(item => item.name).sort(), [...root.requiredSecrets].sort()), 'Protected secret installation inventory differs');
  exactFields(payload.quality, ['head', 'runId', 'attempt', 'releaseGuardDigest']); commit(payload.quality.head); integer(payload.quality.runId); integer(payload.quality.attempt); hash(payload.quality.releaseGuardDigest);
  check(payload.quality.head === payload.head, 'Exact source release qualification required');
  return { payload, authorityDigest: digest(envelope), rootDigest: digest(root) };
}

export async function admitHostedComposition({ bundle, manifest, authority, trustRoot, rootDigest, identity, now }) {
  const root = await readHostedRoot(trustRoot, rootDigest, bundle);
  const envelope = parseJSON(await readRegularFile(authority, 16 * 1024 * 1024), 16 * 1024 * 1024);
  const verified = verifyHostedAuthority(envelope, { root, identity, now });
  const policy = verified.payload.policy;
  check(policy.implementationDigest === await implementationDigest(), 'Hosted verifier implementation changed');
  const admission = await admitComposition({ bundle, manifest, trust: policy, domain: 'isolated-qualification' });
  check(admission.payload.intentSourceCommit === verified.payload.head && admission.payload.baseCommit === verified.payload.base &&
    same(admission.payload.components.map(item => item.id).sort(), verified.payload.portableManifests.map(item => item.component).sort()), 'Admitted composition source or component inventory differs');
  for (const component of admission.payload.components) {
    const artifact = admission.artifacts.get(component.id), expected = verified.payload.portableManifests.find(item => item.component === component.id);
    check(component.codeDigest === expected.codeDigest && component.config.sha256 === expected.configDigest && artifact.runtimeDigest === expected.runtimeDigest &&
      component.originSourceCommit === expected.originSourceCommit, 'Portable artifact authority subject differs');
    const qualification = [];
    for (const reference of component.componentProofs) {
      const bytes = await readRef(bundle, reference), proof = parseJSON(bytes);
      if (proof.kind === 'qualification') qualification.push(sha256(bytes));
    }
    check(qualification.length === 1 && qualification[0] === expected.qualificationDigest, 'Exact component qualification authority differs');
  }
  return { ...admission, hostedAuthority: verified, root };
}
