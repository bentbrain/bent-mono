import { writeFile } from 'node:fs/promises';
import { fixture } from './fixtures.mjs';
import { canonical, digest, sha256, parseJSON } from '../data.mjs';
import { componentClosure } from '../scoped-inputs.mjs';
import { codeIdentity } from '../component-identity.mjs';

export async function scopedFixture(options) {
  const f = await fixture(options), [a, b] = f.trust.intentCommits;
  const lock = { lockfileVersion: 3, configVersion: 1, workspaces: { '': { name: 'root' }, consumer: { name: 'consumer' }, producer: { name: 'producer' } }, packages: {} };
  const roots = new Map();
  for (const commit of [a, b]) {
    const files = [];
    const content = { 'bun.lock': canonical(lock), 'package.json': '{"name":"synthetic-fixture"}', 'src/consumer.mjs': 'export const nativeVersion = 5;',
      'src/producer.mjs': commit === a ? 'export const storefrontVersion = 1;' : 'export const storefrontVersion = 2;', 'policy/full-qualification.json': '{"lane":"full"}' };
    for (const [path, value] of Object.entries(content)) {
      await f.put(`snapshots/${commit}/${path}`, value); files.push({ path, sha256: sha256(value), mode: '100644' });
    }
    files.sort((a, b) => a.path < b.path ? -1 : 1); roots.set(commit, files);
  }
  const policy = { schema: 'shop.scoped-input-policy/v1', components: ['consumer', 'producer'], rules: [
    { path: 'src/consumer.mjs', subtree: false, build: ['consumer'], proof: ['consumer'] },
    { path: 'src/producer.mjs', subtree: false, build: ['producer'], proof: ['producer'] },
  ], workspaces: { consumer: ['consumer'], producer: ['producer'] }, runtime: { consumer: sha256('native-linux-identity'), producer: sha256('worker-identity') } };
  f.trust.schema = 'shop.fixture-trust/v2'; f.trust.closurePolicy = policy; f.trust.revokedReceipts = [];
  f.trust.snapshots = [a, b].map(commit => ({ commit, root: `snapshots/${commit}`, files: roots.get(commit), treeDigest: digest(roots.get(commit)) }));
  await writeFile(f.trustPath, canonical(f.trust), { mode: 0o600 });
  const originComponents = new Map();
  for (const id of ['consumer', 'producer']) for (const commit of [a, b]) {
    const inputs = roots.get(commit), closure = componentClosure({ files: inputs, lock, policy, component: id });
    const files = [await f.put(`scoped-artifacts/${id}-${commit}/index.mjs`, id === 'consumer' ? 'export const native = 5;' : `export const storefront = '${commit}';`)];
    const artifact = { schema: 'shop.artifact/v2', component: id, format: 'module-bundle', root: `scoped-artifacts/${id}-${commit}`, entrypoint: files[0].path,
      files: files.map(file => ({ ...file, mediaType: 'application/javascript' })), originSourceCommit: commit, inputsDigest: closure.buildDigest, runtimeDigest: policy.runtime[id] };
    artifact.codeDigest = codeIdentity(artifact);
    const artifactRef = await f.put(`metadata/${id}-${commit}-artifact.json`, artifact);
    const config = f.payload.components.find(component => component.id === id).config;
    const provenance = await f.put(`metadata/${id}-${commit}-provenance.json`, { schema: 'shop.fixture-provenance/v1', component: id, originSourceCommit: commit,
      sourceTreeDigest: digest(inputs), inputsDigest: closure.buildDigest, artifactFilesDigest: digest(artifact.files), recipeDigest: sha256('fixture-recipe'),
      toolchainDigest: policy.runtime[id], dependencyLockDigest: inputs.find(file => file.path === 'bun.lock').sha256 });
    const inputRef = await f.put(`metadata/${commit}-inputs.json`, { schema: 'shop.root-inputs/v2', files: inputs });
    const now = Date.now(), proofs = [];
    for (const kind of ['artifact', 'qualification']) {
      const evidence = await f.put(`proofs/${id}-${commit}-${kind}-evidence.json`, { scope: 'synthetic-controller-fixture', originSourceCommit: commit, kind });
      const proof = f.signComponentProof({ schema: 'shop.component-proof/v1', scope: 'inactive-local', kind, component: id, originSourceCommit: commit,
        codeDigest: artifact.codeDigest, inputsDigest: closure.buildDigest, proofInputsDigest: closure.proofDigest, runtimeDigest: policy.runtime[id],
        bindingDigest: kind === 'qualification' ? config.sha256 : null, policyDigest: digest(policy), verifierDigest: f.trust.implementationDigest,
        createdAt: now, expiresAt: now + 3600000, evidence });
      proofs.push(await f.put(`proofs/${id}-${commit}-${kind}.json`, proof));
    }
    originComponents.set(`${id}/${commit}`, { ...f.payload.components.find(component => component.id === id), originSourceCommit: commit,
      sourceTreeDigest: digest(inputs), inputsDigest: closure.buildDigest, intentInputsDigest: closure.buildDigest, inputsRef: inputRef, intentInputsRef: inputRef,
      artifact: artifactRef, provenance, codeDigest: artifact.codeDigest, proofInputsDigest: closure.proofDigest, intentProofInputsDigest: closure.proofDigest, componentProofs: proofs });
  }
  const payload = async (commit, parent = null) => {
    const value = { ...structuredClone(f.payload), schema: 'shop.release-composition/v2', intentSourceCommit: commit, policyDigest: digest(f.trust),
      parentCompositionDigest: parent ? digest(parent) : null, components: [] };
    const intent = roots.get(commit), intentRef = await f.put(`metadata/${commit}-inputs.json`, { schema: 'shop.root-inputs/v2', files: intent });
    for (const id of ['consumer', 'producer']) {
      const component = structuredClone(originComponents.get(`${id}/${id === 'consumer' ? a : commit}`));
      const closure = componentClosure({ files: intent, lock, policy, component: id });
      component.intentInputsRef = intentRef; component.intentInputsDigest = closure.buildDigest; component.intentProofInputsDigest = closure.proofDigest;
      value.components.push(component);
    }
    return value;
  };
  return { ...f, roots, lock, policy, originComponents, scopedPayload: payload, parse: bytes => parseJSON(bytes) };
}
