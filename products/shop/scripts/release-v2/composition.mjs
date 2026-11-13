import { createPublicKey, verify } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, canonical, digest, sha256, same, readJSON, parseJSON, readRef, confined, filesUnder, pathName, validate } from './data.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const schema = await readJSON(new URL('./composition.schema.json', import.meta.url));
export const conforms = (value, name) => validate(value, schema.$defs[name], schema.$defs);
export const subject = payload => { const { proofRefs, ...selection } = payload; return digest(selection); };
export const allInputs = payload => digest(payload.components.map(component => ({ id: component.id, inputsDigest: component.intentInputsDigest })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
export async function implementationDigest() {
  const paths = (await filesUnder(directory)).filter(path => !path.startsWith('testing/') && !path.endsWith('.test.mjs'));
  return digest(await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(`${directory}/${path}`)) }))));
}
const unique = (items, key, reason) => check(new Set(items.map(key)).size === items.length, reason);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = items => [...items].sort((a, b) => compare(a.path, b.path));
const orderedSet = (items, key, reason) => check(same(items.map(key), items.map(key).sort(compare)), reason);

export async function admit({ bundle, manifest, trustPath }) {
  const trustFile = await lstat(trustPath), bundleRoot = await realpath(bundle), trustedPath = await realpath(trustPath);
  check(trustFile.isFile() && !trustFile.isSymbolicLink() && (trustFile.mode & 0o077) === 0 &&
    trustedPath !== await realpath(manifest) && !trustedPath.startsWith(`${bundleRoot}${sep}`), 'Separate private fixture trust required');
  const trust = await readJSON(trustPath, 16 * 1024 * 1024);
  conforms(trust, 'trust');
  check(trust.implementationDigest === await implementationDigest(), 'Verifier implementation changed');
  check(trust.inputPaths.includes('bun.lock') && trust.inputPaths.includes('package.json'), 'Full dependency closure required');
  trust.inputPaths.forEach(pathName);
  unique(trust.snapshots, item => item.commit, 'Conflicting snapshot identities');
  const key = createPublicKey(trust.publicKeyPem);
  check(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1', 'Fixture P-256 key required');
  check(sha256(key.export({ type: 'spki', format: 'der' })) === trust.keyFingerprint, 'Public key fingerprint differs');
  const envelope = await readJSON(manifest);
  conforms(envelope, 'envelope');
  const { payload, signature } = envelope;
  check(signature.keyId === trust.keyId && signature.payloadDigest === digest(payload) &&
    verify('sha256', Buffer.from(canonical(payload)), key, Buffer.from(signature.signature, 'base64')), 'Composition signature differs');
  check(payload.policyDigest === digest(trust) && same(payload.repository, trust.repository) && payload.baseCommit === trust.baseCommit &&
    trust.intentCommits.includes(payload.intentSourceCommit), 'Source or independent fixture policy differs');
  check(new Date(payload.createdAt).toISOString() === payload.createdAt, 'Canonical creation timestamp required');
  check(payload.changeClass === 'compatible', 'Migration requires a later guarded lane');
  unique(payload.components, item => item.id, 'Conflicting component identities');
  unique(payload.dependencies, item => `${item.producer}/${item.consumer}`, 'Conflicting dependency identities');
  unique(payload.proofRefs, item => item.kind, 'Conflicting proof identities');
  orderedSet(payload.components, item => item.id, 'Component set must be sorted');
  orderedSet(payload.dependencies, item => `${item.producer}/${item.consumer}`, 'Dependency set must be sorted');
  orderedSet(payload.proofRefs, item => item.kind, 'Proof set must be sorted');
  orderedSet(payload.schemaState.rollbackEpochs, item => item, 'Schema epoch set must be sorted');
  const snapshots = new Map();
  for (const snapshot of trust.snapshots) {
    const root = await confined(bundle, snapshot.root);
    const paths = await filesUnder(root);
    check(same(paths, [...trust.inputPaths].sort()), 'Unknown or missing source path invalidates full closure');
    const inputs = sorted(await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(await confined(root, path))) }))));
    check(digest(inputs) === snapshot.treeDigest, 'Source snapshot changed');
    snapshots.set(snapshot.commit, inputs);
  }
  const artifacts = new Map();
  for (const component of payload.components) {
    for (const [name, values] of Object.entries(component.contract)) if (Array.isArray(values)) orderedSet(values, item => item, `Contract ${name} set must be sorted`);
    const inputs = parseJSON(await readRef(bundle, component.inputsRef), 16 * 1024 * 1024); conforms(inputs, 'inputs');
    const intentInputs = parseJSON(await readRef(bundle, component.intentInputsRef), 16 * 1024 * 1024); conforms(intentInputs, 'inputs');
    orderedSet(inputs.files, item => item.path, 'Origin input set must be sorted');
    orderedSet(intentInputs.files, item => item.path, 'Intent input set must be sorted');
    const origin = snapshots.get(component.originSourceCommit), intended = snapshots.get(payload.intentSourceCommit);
    check(origin && intended && same(inputs.files, origin) && same(intentInputs.files, intended), 'Exact full input closure differs');
    check(component.sourceTreeDigest === digest(origin) && component.inputsDigest === digest(origin) &&
      component.intentInputsDigest === digest(intended), 'Input digest differs');
    check(same(origin, intended), 'Changed source or dependency requires a fresh artifact and full qualification');
    const artifact = parseJSON(await readRef(bundle, component.artifact)); conforms(artifact, 'artifact');
    const config = parseJSON(await readRef(bundle, component.config)); conforms(config, 'config');
    const provenance = parseJSON(await readRef(bundle, component.provenance)); conforms(provenance, 'provenance');
    unique(artifact.files, item => item.path, 'Conflicting artifact file identities');
    unique(config.bindings, item => item.name, 'Conflicting binding identities');
    orderedSet(artifact.files, item => item.path, 'Artifact file set must be sorted');
    orderedSet(config.bindings, item => item.name, 'Binding set must be sorted');
    check(artifact.component === component.id && config.component === component.id && provenance.component === component.id &&
      artifact.originSourceCommit === component.originSourceCommit && provenance.originSourceCommit === component.originSourceCommit &&
      artifact.inputsDigest === component.inputsDigest && provenance.inputsDigest === component.inputsDigest &&
      provenance.sourceTreeDigest === component.sourceTreeDigest && artifact.configDigest === component.config.sha256 &&
      artifact.provenanceDigest === component.provenance.sha256 && provenance.artifactFilesDigest === digest(artifact.files) &&
      provenance.dependencyLockDigest === origin.find(item => item.path === 'bun.lock')?.sha256, 'Artifact provenance or config subject differs');
    check(artifact.files.some(file => file.path === artifact.entrypoint), 'Artifact entrypoint missing');
    const artifactRoot = await confined(bundle, artifact.root);
    check(artifact.files.every(file => file.path.startsWith(`${artifact.root}/`)) &&
      same(await filesUnder(artifactRoot), artifact.files.map(file => file.path.slice(artifact.root.length + 1)).sort()), 'Complete artifact inventory differs');
    for (const file of artifact.files) await readRef(bundle, file);
    check(component.contract.current !== component.contract.previous && component.contract.accepts.includes(component.contract.current) &&
      component.contract.accepts.includes(component.contract.previous), 'N and N-1 protocol acceptance required');
    artifacts.set(component.id, artifact);
  }
  check(same([...trust.requiredProofKinds].sort(), payload.proofRefs.map(item => item.kind).sort()), 'Required full proof set differs');
  for (const proof of payload.proofRefs) {
    const receipt = parseJSON(await readRef(bundle, proof.receipt)); conforms(receipt, 'receipt');
    check(receipt.kind === proof.kind && receipt.subjectDigest === subject(payload) && receipt.inputsDigest === allInputs(payload) &&
      receipt.policyDigest === payload.policyDigest && receipt.verifierDigest === trust.implementationDigest, 'Exact proof subject differs');
    await readRef(bundle, receipt.evidence);
  }
  activationOrder(payload);
  return { payload, envelope, trust, compositionDigest: digest(payload), artifacts };
}

export function activationOrder(payload) {
  const components = new Map(payload.components.map(component => [component.id, component]));
  const order = [], visiting = new Set(), done = new Set();
  const visit = id => {
    check(components.has(id) && !visiting.has(id), 'Missing or cyclic dependency');
    if (done.has(id)) return;
    visiting.add(id);
    for (const edge of payload.dependencies.filter(edge => edge.producer === id)) {
      check(edge.producer !== edge.consumer && components.has(edge.consumer), 'Invalid dependency');
      visit(edge.consumer);
    }
    visiting.delete(id); done.add(id); order.push(id);
  };
  for (const id of [...components.keys()].sort()) visit(id);
  return order;
}

export function compatible(candidate, previous, inventory) {
  check(inventory.complete === true && Array.isArray(inventory.jobs), 'Complete outstanding job inventory required');
  const variants = new Map(candidate.components.map(component => [component.id, [component]]));
  if (previous) {
    check(same(candidate.components.map(c => c.id).sort(), previous.components.map(c => c.id).sort()), 'Component topology change requires migration');
    check(candidate.schemaState.epoch === previous.schemaState.epoch && candidate.schemaState.ledgerDigest === previous.schemaState.ledgerDigest &&
      candidate.schemaState.rollbackEpochs.includes(previous.schemaState.epoch), 'Schema transition or rollback is incompatible');
    previous.components.forEach(component => variants.get(component.id).push(component));
    for (const component of candidate.components) {
      const old = previous.components.find(item => item.id === component.id);
      check(component.contract.current === old.contract.current && component.contract.previous === old.contract.previous, 'Protocol epoch change requires a migration lane');
    }
    check(same(candidate.dependencies, previous.dependencies), 'Dependency topology change requires migration');
  }
  for (const edge of candidate.dependencies) {
    for (const producer of variants.get(edge.producer) ?? []) for (const consumer of variants.get(edge.consumer) ?? []) {
      check(producer.contract.emits.every(format => edge.formats.includes(format) && consumer.contract.accepts.includes(format)), 'Directed protocol overlap is incompatible');
      check(edge.capabilities.every(capability => consumer.contract.capabilities.includes(capability)) &&
        producer.contract.requiresCapabilities.every(capability => consumer.contract.capabilities.includes(capability)), 'Required capability unavailable');
      check(producer.contract.storageWrites.every(format => consumer.contract.storageReads.includes(format)), 'Stored data overlap is incompatible');
    }
  }
  for (const component of candidate.components) {
    for (const writer of variants.get(component.id)) for (const reader of variants.get(component.id)) {
      check(writer.contract.storageWrites.every(format => reader.contract.storageReads.includes(format)), 'Stored data overlap is incompatible');
    }
    check(component.contract.rollbackRequirements.every(requirement => variants.get(component.id).every(version => version.contract.capabilities.includes(requirement))), 'Rollback requirement unavailable');
  }
  for (const job of inventory.jobs) {
    check(job && Object.keys(job).sort().join(',') === 'artifactDigest,component,format' && /^[a-f0-9]{64}$/.test(job.artifactDigest), 'Malformed outstanding job identity');
    const versions = variants.get(job.component);
    check(versions && versions.every(component => component.contract.jobHandlers.includes(job.format)) &&
      versions.some(component => component.artifact.sha256 === job.artifactDigest), 'Outstanding job requires an incompatible or unretained version');
    check(Array.isArray(inventory.versions) && inventory.versions.some(version => version.component === job.component && version.artifactDigest === job.artifactDigest), 'Outstanding job artifact has no retained provider version');
  }
  return activationOrder(candidate);
}
