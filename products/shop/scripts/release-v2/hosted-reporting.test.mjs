import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, sha256 } from './data.mjs';
import { protocolPolicy } from './provider-protocol-builders.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { authorityFixture } from './testing/hosted-authority-fixture.mjs';
import { verifyReportingAuthority } from './hosted-reporting.mjs';

test('fresh reporting authority selects a verified event independently of artifact proof lifetime', async () => {
  const f = await authorityFixture(), original = protocolFixture().policy;
  const policy = protocolPolicy({ ...original, github: { ...original.github, environment: 'Preview' } });
  const root = { ...f.root, repositoryName: policy.github.repository, providerPolicyDigest: digest(policy) };
  const identity = { ...f.identity, repositoryName: root.repositoryName, workflowRef: `${root.repositoryName}/${root.workflowPath}@refs/heads/main` };
  const payload = { schema: 'shop.hosted-reporting-authority/v1', scope: root.scope, repository: root.repository,
    repositoryName: root.repositoryName, environment: root.environment, workflowPath: root.workflowPath,
    head: identity.head, runId: identity.runId, attempt: identity.attempt, issuedAt: f.now, expiresAt: f.now + 60000,
    providerPolicy: policy, writerFenceDigest: sha256('installed-fence'), eventDigest: sha256('old-verified-event'),
    compositionDigest: sha256('old-composition'), deploymentId: policy.github.deploymentIds[0] };
  assert.equal(verifyReportingAuthority(f.seal(payload), { root, identity, now: f.now }).payload.eventDigest, payload.eventDigest);
  for (const change of [value => { value.eventDigest = 'invalid'; }, value => { value.environment = 'Production'; },
    value => { value.runId++; }, value => { value.head = 'e'.repeat(40); }, value => { value.expiresAt = f.now; },
    value => { value.providerPolicy.github.deploymentIds = ['999']; }, value => { value.deploymentId = '999'; },
    value => { value.componentProof = {}; }]) {
    const changed = structuredClone(payload); change(changed);
    assert.throws(() => verifyReportingAuthority(f.seal(changed), { root, identity, now: f.now }));
  }
});
