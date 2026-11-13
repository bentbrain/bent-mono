import { generateKeyPairSync, sign } from 'node:crypto';
import { scopedFixture } from './scoped-fixtures.mjs';
import { canonical, digest, sha256 } from '../data.mjs';

const key = id => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: pair.privateKey, entry: { id, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    spkiSha256: sha256(pair.publicKey.export({ type: 'spki', format: 'der' })) } };
};
export async function authorityFixture() {
  const f = await scopedFixture(), signing = key('source-authority'), now = Date.now();
  const broker = generateKeyPairSync('ed25519');
  const policy = { ...f.trust, schema: 'shop.hosted-composition-policy/v1', scope: 'isolated-qualification' };
  const root = { schema: 'shop.hosted-trust-root/v1', scope: 'isolated-qualification', repository: policy.repository,
    repositoryName: 'fixture-owner/fixture-repo', environment: 'Preview', workflowPath: '.github/workflows/shop-composition-qualification.yml',
    sourceAuthorityKeys: [signing.entry], compositionKeys: [{ id: policy.keyId, publicKeyPem: policy.publicKeyPem, spkiSha256: policy.keyFingerprint }],
    providerPolicyDigest: sha256('exact-provider-targets'), requiredSecrets: ['NATIVE_GRANT'], revokedAuthorities: [], maximumLifetimeMs: 600000,
    credentialBroker: { id: 'qualification-broker', environmentId: 'qualification', implementationDigest: sha256('reviewed-broker'),
      origin: 'https://qualification.example.invalid', audience: 'qualification-writer', subject: 'repo:fixture-owner/fixture-repo:environment:Preview',
      keys: [{ id: 'broker-key', publicKeyPem: broker.publicKey.export({ type: 'spki', format: 'pem' }) }] } };
  const payload = { schema: 'shop.hosted-source-authority/v1', scope: root.scope, repository: root.repository, repositoryName: root.repositoryName,
    environment: root.environment, head: f.trust.intentCommits[1], base: f.trust.baseCommit, tree: 'd'.repeat(40),
    workflowPath: root.workflowPath, workflowCommit: f.trust.intentCommits[1], runId: 10, attempt: 1, issuedAt: now, expiresAt: now + 600000,
    acceptedAt: now - 2000, policy, providerPolicyDigest: root.providerPolicyDigest, writerFenceDigest: sha256('installed-fence'), targetPlanDigest: sha256('reviewed-target-plan'),
    portableManifests: ['consumer', 'producer'].map(component => ({ component, manifestSha256: sha256('sealed-manifest'), originSourceCommit: f.trust.intentCommits[0],
      lineageDigest: sha256('external-CI-lineage'), codeDigest: sha256(component), configDigest: sha256('installation'), runtimeDigest: sha256('runtime'),
      qualificationDigest: sha256('qualification'), awsImageQualified: false })),
    secretInstallations: [{ name: 'NATIVE_GRANT', version: 'version1', sha256: sha256('independently-installed-secret-reference') }],
    quality: { head: f.trust.intentCommits[1], runId: 11, attempt: 1, releaseGuardDigest: sha256('actual-release-guard-output') } };
  const seal = value => ({ payload: structuredClone(value), signature: { algorithm: 'ECDSA_SHA_256', keyId: signing.entry.id,
    payloadDigest: digest(value), signature: sign('sha256', Buffer.from(canonical(value)), signing.privateKey).toString('base64') } });
  const identity = { repository: root.repository, repositoryName: root.repositoryName, head: payload.head, workflowCommit: payload.workflowCommit,
    workflowRef: `${root.repositoryName}/${root.workflowPath}@refs/heads/main`, runId: payload.runId, attempt: payload.attempt };
  return { ...f, fixturePayload: f.payload, root, payload, identity, now, seal };
}

