import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { canonical, digest, sha256 } from './data.mjs';
import { createActionsAuthenticator } from './actions-authentication.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { authorityFixture } from './testing/hosted-authority-fixture.mjs';

test('custody authenticates real RSA signatures and every protected Actions claim', async () => {
  const f = await authorityFixture(), { policy } = protocolFixture(), now = Date.now(), seconds = Math.floor(now / 1000);
  const root = { ...f.root, providerPolicyDigest: digest(policy) }, fence = { digest: sha256('installed-fence'),
    payload: { policyDigest: digest(policy), environmentId: root.credentialBroker.environmentId } };
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'github-current', alg: 'RS256', use: 'sig' };
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: root.credentialBroker.audience, sub: root.credentialBroker.subject,
    environment: root.environment, repository: root.repositoryName, repository_id: String(root.repository.repositoryId),
    repository_owner_id: String(root.repository.ownerId), ref: 'refs/heads/main', event_name: 'workflow_dispatch',
    workflow_ref: `${root.repositoryName}/${root.workflowPath}@refs/heads/main`, sha: 'a'.repeat(40), workflow_sha: 'a'.repeat(40),
    run_id: '100', run_attempt: '1', iat: seconds, nbf: seconds - 600, exp: seconds + 300 };
  const token = (value, header = { alg: 'RS256', typ: 'JWT', kid: jwk.kid, x5t: 'github-thumbprint' }) => {
    const body = [header, value].map(item => Buffer.from(canonical(item)).toString('base64url')).join('.');
    return `${body}.${sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url')}`;
  };
  const authenticate = createActionsAuthenticator({ root, policy, fenceAdmission: fence, readKeys: async () => ({ keys: [jwk] }), now: () => now });
  const input = { environmentId: fence.payload.environmentId, fenceDigest: fence.digest };
  assert.match((await authenticate(input, { authorization: `Bearer ${token(claims)}` })).principalDigest, /^[a-f0-9]{64}$/);
  for (const change of [{ iss: 'https://attacker.invalid' }, { aud: 'other' }, { sub: 'other' }, { environment: 'Production' },
    { repository: 'other/repo' }, { repository_id: '999' }, { repository_owner_id: '999' }, { ref: 'refs/heads/branch' },
    { event_name: 'pull_request' }, { workflow_ref: 'other/workflow' }, { workflow_sha: 'b'.repeat(40) }, { run_attempt: '01' },
    { exp: seconds }, { iat: seconds + 1 }, { nbf: seconds + 1 }]) {
    await assert.rejects(authenticate(input, { authorization: `Bearer ${token({ ...claims, ...change })}` }));
  }
  const forged = token(claims).split('.'); forged[1] = Buffer.from(canonical({ ...claims, run_id: '999' })).toString('base64url');
  await assert.rejects(authenticate(input, { authorization: `Bearer ${forged.join('.')}` }), /signature/);
  await assert.rejects(authenticate(input, { authorization: `Bearer ${token(claims, { alg: 'none', typ: 'JWT', kid: jwk.kid })}` }), /algorithm/);
  const duplicate = createActionsAuthenticator({ root, policy, fenceAdmission: fence, readKeys: async () => ({ keys: [jwk, jwk] }), now: () => now });
  await assert.rejects(duplicate(input, { authorization: `Bearer ${token(claims)}` }), /Unique/);
});
