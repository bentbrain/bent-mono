import { check, digest, same } from './data.mjs';

export function codeIdentity(artifact) {
  check(artifact.files.every(file => file.path.startsWith(`${artifact.root}/`)) && artifact.entrypoint.startsWith(`${artifact.root}/`), 'Code inventory root differs');
  return digest({ format: artifact.format, entrypoint: artifact.entrypoint.slice(artifact.root.length + 1), runtimeDigest: artifact.runtimeDigest,
    files: artifact.files.map(file => ({ ...file, path: file.path.slice(artifact.root.length + 1) })) });
}

export function selectedVersion(component) {
  const artifactDigest = component.codeDigest ?? component.artifact.sha256, configDigest = component.config.sha256;
  return { component: component.id, artifactDigest, configDigest,
    version: `v-${component.codeDigest ? digest({ artifactDigest, configDigest }) : artifactDigest}` };
}

export function verifyCodeIdentity(artifact, component) {
  if (artifact.schema === 'shop.artifact/v2') check(artifact.codeDigest === codeIdentity(artifact) && artifact.codeDigest === component.codeDigest, 'Environment-neutral code identity differs');
  else check(!component.codeDigest, 'Scoped component requires a v2 code artifact');
}

export function verifyComponentProof(receipt, { component, artifact, trust, verifySignature, now }) {
  const { signature, ...payload } = receipt;
  const expected = ['schema', 'scope', 'kind', 'component', 'originSourceCommit', 'codeDigest', 'inputsDigest', 'proofInputsDigest', 'runtimeDigest', 'bindingDigest', 'policyDigest', 'verifierDigest', 'createdAt', 'expiresAt', 'evidence'];
  const scope = trust.schema === 'shop.hosted-composition-policy/v1' && trust.scope === 'isolated-qualification' ? 'isolated-qualification' : 'inactive-local';
  check(same(Object.keys(payload).sort(), expected.sort()) && payload.schema === 'shop.component-proof/v1' && payload.scope === scope, 'Component proof fields differ');
  check(['artifact', 'qualification'].includes(payload.kind) && payload.component === component.id && payload.originSourceCommit === component.originSourceCommit &&
    payload.codeDigest === component.codeDigest && payload.inputsDigest === component.inputsDigest && payload.proofInputsDigest === component.proofInputsDigest &&
    payload.runtimeDigest === artifact.runtimeDigest && payload.policyDigest === digest(trust.closurePolicy) && payload.verifierDigest === trust.implementationDigest &&
    payload.bindingDigest === (payload.kind === 'qualification' ? component.config.sha256 : null), 'Component proof subject differs');
  check(payload.inputsDigest === component.intentInputsDigest && payload.proofInputsDigest === component.intentProofInputsDigest, 'Changed executable or proof input requires new qualification');
  check(Number.isSafeInteger(payload.createdAt) && Number.isSafeInteger(payload.expiresAt) && payload.createdAt <= now && payload.expiresAt > now &&
    payload.expiresAt - payload.createdAt <= 24 * 60 * 60 * 1000, 'Component proof expired or has an invalid validity window');
  check(typeof signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(signature) && verifySignature(payload, signature), 'Component proof signature differs');
  check(!trust.revokedReceipts.includes(digest(receipt)), 'Component proof was revoked');
  return payload;
}
