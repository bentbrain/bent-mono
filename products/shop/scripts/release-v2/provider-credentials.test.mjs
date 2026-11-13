import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createProviderSigner } from './provider-credentials.mjs';
import { authorizeRequest, signingTrust } from './signing.mjs';
import { requestBuilders } from './provider-protocol-builders.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';

test('explicit temporary signer matches the existing AWS signer for complete S3 and Lambda requests', async () => {
  const { AwsV4Signer } = createRequire(new URL('../../workers/api/package.json', import.meta.url))('aws4fetch');
  const { policy } = protocolFixture(), pair = generateKeyPairSync('ed25519'), time = Date.parse('2026-11-13T06:30:00Z');
  const session = { accountId: policy.awsAccountId, region: policy.region, accessKeyId: 'ASIATESTSYNTHETIC1234',
    secretAccessKey: 'synthetic-secret-key-for-offline-signing-only', sessionToken: 'synthetic-temporary-session', expiresAt: time + 3600000 };
  const options = { policy, session, bearerTokens: { cloudflare: 'synthetic-cloudflare', github: 'synthetic-github' }, keyId: 'protected-provider',
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), now: () => time };
  const signer = createProviderSigner(options), trust = signingTrust({ policy, keys: [{ id: options.keyId, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }] });
  const builders = requestBuilders(policy), fn = policy.functions[0], requests = [builders.storeGet('head.json'),
    builders.storePut('head.json', Buffer.from('{}'), null), builders.lambdaLatest(fn.name), builders.lambdaVersions(fn.name, 'some+marker/value='),
    builders.lambdaFunction(fn.name, '42'), builders.lambdaAlias(fn.name, fn.aliases[0]), builders.lambdaUpload(fn.name, 'a'.repeat(64), 'revision1')];
  for (const request of requests) {
    const signed = await authorizeRequest({ request, policy, signer, trust, now: () => time });
    const expected = await new AwsV4Signer({ ...session, service: request.service, region: policy.region, method: request.method, url: request.url,
      headers: { ...request.headers, 'x-amz-content-sha256': request.bodySha256 }, body: Buffer.from(request.bodyBase64, 'base64'), datetime: '20261113T063000Z', allHeaders: true }).sign();
    assert.equal(signed.headers.authorization, expected.headers.get('authorization'), request.operation);
    assert.equal(signed.bodyBase64, request.bodyBase64);
  }
  const bearer = await authorizeRequest({ request: builders.reportStatuses(policy.github.deploymentIds[0]), policy, signer, trust, now: () => time });
  assert.equal(bearer.headers.authorization, 'Bearer synthetic-github');
  assert.throws(() => createProviderSigner({ ...options, session: { ...session, accountId: '999999999999' } }), /pinned temporary/);
  const expired = createProviderSigner({ ...options, session: { ...session, expiresAt: time + 10000 } });
  await assert.rejects(authorizeRequest({ request: requests[0], policy, signer: expired, trust, now: () => time }), /session differs/);
});
