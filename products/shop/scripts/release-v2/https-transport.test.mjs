import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createHttpsTransport, validateDispatchTarget } from './https-transport.mjs';
import { authorizeRequest } from './signing.mjs';
import { requestBuilders } from './provider-protocol-builders.mjs';
import { responseBytes } from './provider-protocol.mjs';
import { transcriptSigner } from './testing/provider-protocol-service.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';

async function authorized(policy, request) { const identity = transcriptSigner(policy); return authorizeRequest({ policy, request, ...identity }); }
test('HTTPS dispatch pins exact origins, resources, operations, framing and credentials before network access', async () => {
  const { policy, worker } = protocolFixture(), base = await authorized(policy, requestBuilders(policy).workerDeployments(worker));
  assert.equal(validateDispatchTarget(base, policy).url.origin, 'https://api.cloudflare.com');
  for (const patch of [{ url: 'https://evil.example/' }, { url: `${base.url}?include=secret` }, { url: `${base.url}/../../other` }, { method: 'DELETE' }, { operation: 'worker.upload' }, { headers: { ...base.headers, host: 'evil.example' } }, { headers: { ...base.headers, 'content-length': '1' } }, { headers: { ...base.headers, 'proxy-authorization': 'secret' } }, { policyDigest: 'f'.repeat(64) }]) assert.throws(() => validateDispatchTarget({ ...base, ...patch }, policy));
  const transport = createHttpsTransport({ policy, networkRequest: () => { throw Error('Network must remain untouched'); } });
  await assert.rejects(transport({ ...base, url: 'https://evil.example/' }), /origin|Cloudflare/);
});

test('production framing logic preserves cookies and rejects redirects, duplicates, truncation and bounds over actual sockets', async () => {
  const { policy, worker } = protocolFixture(), request = await authorized(policy, requestBuilders(policy).workerDeployments(worker));
  let mode = 'cookies', lastOptions;
  const server = createServer((_request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { location: 'https://evil.example/' }); response.end(); }
    else if (mode === 'duplicate') { response.writeHead(200, ['Content-Type', 'application/json', 'X-Test', 'first', 'X-Test', 'second']); response.end('{}'); }
    else if (mode === 'truncated') { response.writeHead(200, { 'content-length': '100' }); response.end('{}'); }
    else if (mode === 'oversized') response.end('x'.repeat(32));
    else if (mode === 'timeout') { /* The transport deadline owns cancellation. */ }
    else { response.writeHead(200, { 'set-cookie': ['a=1; Secure', 'b=2; Secure'] }); response.write('{'); response.end('}'); }
  });
  server.listen(0, '127.0.0.1'); await new Promise(accept => server.once('listening', accept));
  const networkRequest = (options, callback) => { lastOptions = options; return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port }, callback); };
  try {
    const transport = createHttpsTransport({ policy, timeoutMs: 1000, maximumResponseBytes: 16, networkRequest }), success = await transport(request);
    assert.equal(responseBytes(success).toString(), '{}'); assert.deepEqual(success.headers['set-cookie'], ['a=1; Secure', 'b=2; Secure']);
    assert.equal(lastOptions.rejectUnauthorized, true); assert.equal(lastOptions.minVersion, 'TLSv1.2'); assert.equal(lastOptions.agent, false); assert.equal(lastOptions.hostname, 'api.cloudflare.com');
    for (const [next, expected] of [['redirect', /redirects/], ['duplicate', /Duplicate/], ['truncated', /truncated|aborted|reset/], ['oversized', /bound/]]) { mode = next; await assert.rejects(transport(request), expected); }
    mode = 'timeout'; await assert.rejects(createHttpsTransport({ policy, timeoutMs: 20, networkRequest })(request), /deadline/);
  } finally { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
});
