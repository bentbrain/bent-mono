import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { canonical, digest, sha256 } from './data.mjs';
import { assetManifest, protocolPolicy } from './provider-protocol-builders.mjs';
import { createBootstrapFixture } from './testing/bootstrap-fixture.mjs';
import { configuredCustody, custodyInvocationHandler, planConfiguredCustody } from './custody-entrypoint.mjs';

async function serviceFixture(t) {
  const f = await createBootstrapFixture(t, { root: tmpdir() }), privateRoot = join(f.directory, 'service-installation');
  await mkdir(privateRoot, { mode: 0o700 });
  const put = async (name, value) => {
    const path = join(privateRoot, name), bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonical(value));
    await writeFile(path, bytes, { mode: 0o600 }); return { path, sha256: sha256(bytes) };
  };
  const policy = protocolPolicy({ ...f.plan.providerPolicy, workInventory: { databaseId: '00000000-0000-4000-8000-000000000001',
    queries: ['product-images', 'story-video', 'print-assets'].map(family => ({ family, component: 'native',
      sql: 'SELECT artifact_digest AS artifactDigest, format FROM accepted_jobs' })) } });
  const custodyPolicy = protocolPolicy({ ...policy, store: { ...policy.store, prefix: `${policy.store.prefix}-independent-custody` } });
  const keys = generateKeyPairSync('ed25519'), keyId = 'configured-custody', publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const root = { ...f.root, providerPolicyDigest: digest(policy), credentialBroker: { ...f.root.credentialBroker, keys: [{ id: keyId, publicKeyPem }] } };
  const envelope = payload => ({ keyId, payload, signature: sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString('base64') });
  const priorFence = JSON.parse(await readFile(f.installation.fencePath, 'utf8'));
  const fence = envelope({ ...priorFence.payload, policyDigest: digest(policy) });
  const installation = envelope({ schema: 'shop.credential-installation/v1', fenceDigest: digest(fence),
    environmentId: root.credentialBroker.environmentId, installationId: randomUUID(), credentialEpoch: 'epoch-one',
    custodyPolicyDigest: digest(custodyPolicy), issuedAt: Date.now() - 1000, expiresAt: Date.now() + 600000 });
  const key = await put('provider.pem', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const credentials = { credentialEpoch: 'epoch-one', session: { accountId: policy.awsAccountId, region: policy.region,
    accessKeyId: 'A'.repeat(20), secretAccessKey: 's'.repeat(40), sessionToken: 'synthetic-session', expiresAt: Date.now() + 600000 },
    bearerTokens: { cloudflare: 'synthetic.cloudflare', github: 'synthetic.github' } };
  const credentialFile = await put('credentials.json', credentials);
  const assetRoot = join(f.directory, 'retained-assets'); await mkdir(assetRoot, { mode: 0o700 });
  const asset = Buffer.from('body { color: black }'); await writeFile(join(assetRoot, 'style.css'), asset, { mode: 0o600 });
  const manifestDigest = digest(assetManifest([{ path: 'style.css', type: 'text/css', bytes: asset }]).manifest);
  const catalog = { bundle: assetRoot, entries: [{ resource: policy.workers[0].name, manifestDigest,
    assets: [{ name: 'style.css', type: 'text/css', ref: { path: 'style.css', bytes: asset.length, sha256: sha256(asset) } }] }] };
  const tlsKey = join(privateRoot, 'listener.pem'), certificate = join(privateRoot, 'listener.crt');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj',
    `/CN=${new URL(root.credentialBroker.origin).hostname}`, '-keyout', tlsKey, '-out', certificate], { stdio: 'ignore' });
  await chmod(tlsKey, 0o600); await chmod(certificate, 0o600);
  const signer = { keyId, key, credentialEpoch: credentials.credentialEpoch, credentialsPath: credentialFile.path };
  const config = { schema: 'shop.credential-service-installation/v1', root: await put('root.json', root),
    providerPolicy: await put('policy.json', policy), custodyPolicy: await put('custody-policy.json', custodyPolicy),
    fence: await put('fence.json', fence), installation: await put('installation.json', installation), replacement: null,
    providerSigner: signer, custodySigner: signer, attestation: { keyId, key }, assetCatalog: await put('assets.json', catalog),
    tls: { host: '127.0.0.1', port: 8443, key: { path: tlsKey, sha256: sha256(await readFile(tlsKey)) },
      certificate: { path: certificate, sha256: sha256(await readFile(certificate)) } } };
  const reference = await put('service.json', config);
  return { ...f, config, reference, options: { path: reference.path, digest: reference.sha256 }, credentials, credentialFile, custodyPolicy };
}

test('configured custody constructs both real namespaces and adapters without provider access', async t => {
  const f = await serviceFixture(t), graph = await planConfiguredCustody(f.options);
  assert.equal(graph.providerWrites, 0); assert.equal(graph.configurationDigest, f.reference.sha256);
  assert.equal(graph.custodyPolicyDigest, digest(f.custodyPolicy));
  assert.ok(graph.requests.some(item => new URL(item.request.url).pathname.startsWith(`/${f.custodyPolicy.store.prefix}/`)));
  assert.ok(graph.requests.some(item => item.request.operation === 'work.query'));
  assert.ok(graph.requests.some(item => item.request.operation === 'assets.session'));
  await chmod(f.reference.path, 0o644);
  await assert.rejects(planConfiguredCustody(f.options), /Private owned/);
});

test('configured service uses real signers and refuses credential epoch replacement before provider writes', async t => {
  const f = await serviceFixture(t), objects = new Map(); let writes = 0;
  const transport = async request => {
    assert.ok(request.headers.authorization.startsWith('AWS4-HMAC-SHA256 '));
    assert.ok(request.url.startsWith(`https://${f.custodyPolicy.store.bucket}.s3.`));
    const path = new URL(request.url).pathname, found = objects.get(path), data = Buffer.from(request.bodyBase64, 'base64');
    if (request.method === 'GET' && !found) return { status: 404, complete: true, headers: {}, bodyBase64: Buffer.from('{}').toString('base64') };
    if (request.method === 'PUT') { writes++; objects.set(path, { bytes: data, etag: `"entry-${writes}"` }); }
    const value = objects.get(path);
    return { status: 200, complete: true, headers: { etag: value.etag, 'x-amz-version-id': 'version-one',
      'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': f.custodyPolicy.store.kmsKeyArn },
      bodyBase64: (request.method === 'GET' ? value.bytes : Buffer.alloc(0)).toString('base64') };
  };
  const installed = await configuredCustody(f.options, { transport }); assert.equal(writes, 2);
  assert.equal((await installed.service.readState()).installation.credentialEpoch, 'epoch-one');
  const before = writes;
  await writeFile(f.credentialFile.path, canonical({ ...f.credentials, credentialEpoch: 'epoch-two' }));
  await assert.rejects(installed.service.readState(), /another epoch/); assert.equal(writes, before);
});

test('HTTP custody framing and error responses retain private failures inside the service', async t => {
  let calls = 0;
  const server = createServer(custodyInvocationHandler({ handle: async () => { calls++; throw Error('synthetic-private-sentinel'); } }));
  server.listen(0, '127.0.0.1'); await new Promise(accept => server.once('listening', accept));
  t.after(() => new Promise(accept => { server.closeAllConnections(); server.close(accept); }));
  const response = await new Promise((accept, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/v1/invocations',
      headers: { 'content-type': 'application/json', 'content-length': '2', authorization: 'Bearer synthetic.token.value' } }, result => {
      const chunks = []; result.on('data', chunk => chunks.push(chunk)); result.on('end', () => accept({ status: result.statusCode, headers: result.headers, body: Buffer.concat(chunks).toString() }));
    }); request.once('error', reject); request.end('{}');
  });
  assert.equal(calls, 1); assert.equal(response.status, 503); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.includes('synthetic-private-sentinel'), false);
});
