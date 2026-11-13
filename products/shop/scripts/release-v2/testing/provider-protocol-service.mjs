import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical, check, digest, parseJSON, sha256 } from '../data.mjs';
import { protocolByteLimit, assetManifest, multipart } from '../provider-protocol-builders.mjs';
import { signingTrust } from '../signing.mjs';
import { loopbackOrigin } from '../provider.mjs';

export function transcriptSigner(policy, transform = value => value) {
  const keys = generateKeyPairSync('ed25519'), keyId = 'ephemeral-transcript-key';
  const trust = signingTrust({ policy, keys: [{ id: keyId, publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] });
  const signer = async ({ request, requestDigest, policyDigest, now }) => {
    let credentialHeaders = {};
    if (request.service === 's3' || request.service === 'lambda') {
      const date = new Date(now).toISOString().replace(/[:-]|\.[0-9]{3}/g, '');
      const headers = [...Object.keys(request.headers), 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token'].sort().join(';');
      credentialHeaders = { 'x-amz-date': date, 'x-amz-content-sha256': request.bodySha256, 'x-amz-security-token': 'transcript-session-token',
        authorization: `AWS4-HMAC-SHA256 Credential=AAAAAAAAAAAAAAAAAAAA/${date.slice(0, 8)}/${policy.region}/${request.service}/aws4_request, SignedHeaders=${headers}, Signature=${'0'.repeat(64)}` };
    } else if (!request.headers.authorization) credentialHeaders = { authorization: 'Bearer transcript-only-token' };
    const payload = { schema: 'shop.provider-signature/v1', requestDigest, policyDigest, credentialHeadersDigest: digest(credentialHeaders), issuedAt: now, expiresAt: now + 30000 };
    return transform({ keyId, payload, credentialHeaders, signature: sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString('base64') });
  };
  return { trust, signer };
}
export function loopbackProtocolTransport(origin) {
  loopbackOrigin(origin); const port = new URL(origin).port;
  return async request => {
    const url = new URL(request.url), bytes = Buffer.from(request.bodyBase64, 'base64');
    check(url.protocol === 'https:' && url.host === request.headers.host && !url.username && !url.password && !url.hash && bytes.length <= protocolByteLimit, 'Invalid production transcript request');
    return new Promise((accept, reject) => {
      const operation = httpRequest({ hostname: '127.0.0.1', port, method: request.method, path: `${url.pathname}${url.search}`, headers: request.headers, agent: false }, response => {
        const chunks = []; let length = 0;
        response.on('data', chunk => { length += chunk.length; if (length > protocolByteLimit) { reject(Error('Transcript response exceeds bound')); operation.destroy(); response.destroy(); } else chunks.push(chunk); });
        response.on('error', reject); response.on('aborted', () => reject(Error('Transcript response was truncated')));
        response.on('end', () => accept({ status: response.statusCode, headers: response.headers, bodyBase64: Buffer.concat(chunks).toString('base64'), complete: response.complete }));
      });
      const timeout = setTimeout(() => { reject(Error('Transcript deadline exceeded')); operation.destroy(); }, 3000);
      operation.on('error', reject); operation.on('close', () => clearTimeout(timeout)); operation.end(bytes);
    });
  };
}
export async function protocolTranscriptService({ policy, assets = [], metadata = {}, faults = {} }) {
  const transcript = [], objects = new Map(), reports = [];
  const workerVersions = Array.from({ length: 101 }, (_, index) => ({ id: `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000` }));
  const activeWorker = workerVersions[2].id, uploadedWorker = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let uploadedParts = [], activeLambda = '7', aliasRevision = 'alias-revision-1', nextObject = 0, reportFaultUsed = false;
  const state = { transcript, objects, reports, workerVersions, activeWorker, get activeLambda() { return activeLambda; }, fault: faults };
  const cfHost = 'api.cloudflare.com', awsHost = `lambda.${policy.region}.amazonaws.com`, s3Host = `${policy.store.bucket}.s3.${policy.region}.amazonaws.com`;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; check(length <= protocolByteLimit, 'Transcript request exceeds bound'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), url = new URL(request.url, `https://${request.headers.host}`);
      check(['GET', 'POST', 'PUT'].includes(request.method) && [cfHost, awsHost, s3Host, 'api.github.com'].includes(request.headers.host), 'Transcript provider outside allowlist');
      check(request.headers.authorization?.startsWith('Bearer ') || request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '), 'Signed production authorization required');
      const record = { method: request.method, url: url.href, headers: request.headers, bytes: bytes.length, sha256: sha256(bytes) }; transcript.push(record);
      const send = (status, value, headers = {}) => { const body = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value)); response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers }); response.end(body); };
      const cf = result => send(200, { success: true, errors: [], messages: [], result });
      if (request.headers.host === cfHost) {
        const root = `/client/v4/accounts/${policy.cloudflareAccountId}/workers`, name = policy.workers[0].name, script = `${root}/scripts/${name}`;
        if (request.method === 'GET' && url.pathname === `${script}/versions`) {
          const page = Number(url.searchParams.get('page')), items = workerVersions.slice((page - 1) * 100, page * 100);
          const selected = faults.truncateInventory ? items.slice(0, 1) : items;
          send(200, { success: true, result: { items: selected }, ...(faults.noInventoryInfo ? {} : { result_info: { page, per_page: 100, count: selected.length, total_count: workerVersions.length } }) }); return;
        }
        if (request.method === 'GET' && url.pathname === `${script}/versions/${uploadedWorker}`) { cf({ id: uploadedWorker, resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } }); return; }
        if (request.method === 'GET' && url.pathname === `${script}/deployments`) { cf({ deployments: [{ id: 'active-deployment', versions: [{ version_id: activeWorker, percentage: 100 }] }] }); return; }
        if (request.method === 'POST' && url.pathname === `${script}/assets-upload-session`) {
          check(canonical(parseJSON(bytes).manifest) === canonical(assetManifest(assets).manifest), 'Asset session omitted or changed files');
          cf({ jwt: 'upload.session.token', buckets: [[...new Set(assetManifest(assets).inventory.map(asset => asset.hash))]] }); return;
        }
        if (request.method === 'POST' && url.pathname === `${root}/assets/upload` && url.search === '?base64=true') {
          check(request.headers.authorization === 'Bearer upload.session.token', 'Asset session capability differs');
          const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData();
          check([...form].length === new Set(assetManifest(assets).inventory.map(asset => asset.hash)).size, 'Incomplete static asset upload');
          for (const asset of assetManifest(assets).inventory) { const file = form.get(asset.hash), original = assets.find(candidate => candidate.path === asset.path); check(file && typeof file !== 'string' && file.type === asset.type && (await file.text()) === original.bytes.toString('base64'), 'Asset multipart differs'); }
          send(201, { success: true, result: { jwt: 'completion.session.token' } }); return;
        }
        if (request.method === 'POST' && url.pathname === `${script}/versions`) {
          const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData();
          check(form.getAll('metadata').length === 1, 'Upload metadata missing');
          const metadata = parseJSON(Buffer.from(form.get('metadata'))); check(metadata.assets.jwt === 'completion.session.token', 'Assets not bound to version');
          record.parts = []; uploadedParts = [];
          for (const [name, part] of form) if (name !== 'metadata') { check(typeof part !== 'string', 'Expected binary Worker module'); const content = Buffer.from(await part.arrayBuffer()); uploadedParts.push({ name, filename: name, type: part.type, bytes: content }); record.parts.push({ name, type: part.type, bytes: part.size, sha256: sha256(content) }); }
          if (faults.dropWorkerAfter) { request.socket.destroy(); return; }
          cf({ id: uploadedWorker }); return;
        }
        if (request.method === 'GET' && url.pathname === `${script}/content/v2`) {
          const content = multipart(uploadedParts.map(part => part.name.endsWith('.map') && faults.mapWhitespace ? { ...part, bytes: Buffer.from(JSON.stringify(JSON.parse(part.bytes.toString()), null, 2)) } : part)); send(200, content.body, { 'content-type': content.contentType, 'cf-entrypoint': 'index.js' }); return;
        }
        if (request.method === 'POST' && url.pathname === `${script}/deployments`) { const value = parseJSON(bytes); check(value.versions[0].version_id === uploadedWorker && value.versions[0].percentage === 100, 'Wrong Worker activation'); cf({ id: 'new-deployment', versions: value.versions }); return; }
      }
      if (request.headers.host === awsHost) {
        const name = policy.functions[0].name, root = `/2015-03-31/functions/${name}`;
        if (request.method === 'GET' && url.pathname === root && url.searchParams.has('Qualifier')) {
          const version = url.searchParams.get('Qualifier'), image = `${policy.functions[0].imageRepository}@sha256:${'a'.repeat(64)}`;
          send(200, { Configuration: { FunctionName: name, FunctionArn: `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:${version}`, Version: version, PackageType: 'Image', State: 'Active', LastUpdateStatus: 'Successful', RevisionId: `version-revision-${version}`, Architectures: ['x86_64'], MemorySize: 3008, Timeout: 120, Role: `arn:aws:iam::${policy.awsAccountId}:role/protocol-synthetic-runtime`, EphemeralStorage: { Size: 1024 }, Environment: { Variables: { STORY_BUILD_ID: 'b'.repeat(64) } } }, Code: { ImageUri: image, ResolvedImageUri: image } }); return;
        }
        if (request.method === 'GET' && url.pathname === `${root}/versions`) {
          const marker = url.searchParams.get('Marker');
          const versions = (marker ? ['7', '9'] : ['$LATEST']).map(Version => ({ Version, FunctionArn: `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:${Version}` }));
          send(200, { Versions: versions, ...(!marker ? { NextMarker: 'next-page' } : {}) }); return;
        }
        if (request.method === 'GET' && url.pathname === `${root}/aliases/${policy.functions[0].aliases[0]}`) { send(200, { Name: policy.functions[0].aliases[0], AliasArn: `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:${policy.functions[0].aliases[0]}`, FunctionVersion: activeLambda, RevisionId: aliasRevision, RoutingConfig: { AdditionalVersionWeights: {} } }); return; }
        if (request.method === 'PUT' && url.pathname === `${root}/code`) { const value = parseJSON(bytes); check(value.Publish === true && value.RevisionId === 'latest-revision-1' && value.ImageUri.startsWith(`${policy.functions[0].imageRepository}@sha256:`), 'Immutable Lambda upload differs'); send(200, { Version: '9', RevisionId: 'version-revision-9', FunctionArn: `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:9` }); return; }
        if (request.method === 'PUT' && url.pathname === `${root}/aliases/${policy.functions[0].aliases[0]}`) {
          const value = parseJSON(bytes);
          if (value.RevisionId !== aliasRevision) { send(412, { Type: 'PreconditionFailedException' }); return; }
          check(value.FunctionVersion === '9', 'Qualified version activation required'); activeLambda = '9'; aliasRevision = 'alias-revision-2'; send(200, { FunctionVersion: activeLambda, RevisionId: aliasRevision }); return;
        }
      }
      if (request.headers.host === s3Host) {
        const key = url.pathname.slice(`/${policy.store.prefix}/`.length);
        check(url.pathname === `/${policy.store.prefix}/${key}` && (key === 'head.json' || /^events\/[a-f0-9]{64}\.json$/.test(key)), 'Protected store key differs');
        check(request.headers['x-amz-expected-bucket-owner'] === policy.awsAccountId, 'Protected store owner differs');
        const existing = objects.get(key);
        const headers = value => ({ etag: value.etag, 'x-amz-version-id': value.versionId, 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': policy.store.kmsKeyArn });
        if (request.method === 'GET') { if (!existing) send(404, { Code: 'NoSuchKey' }); else send(200, existing.bytes, headers(existing)); return; }
        if (request.method === 'PUT') {
          check(request.headers['x-amz-server-side-encryption'] === 'aws:kms' && request.headers['x-amz-server-side-encryption-aws-kms-key-id'] === policy.store.kmsKeyArn && request.headers['x-amz-checksum-sha256'] === Buffer.from(sha256(bytes), 'hex').toString('base64'), 'Encrypted conditional store bytes differ');
          const condition = request.headers['if-none-match'] === '*' ? !existing : existing?.etag === request.headers['if-match'];
          if (!condition) { send(412, { Code: 'PreconditionFailed' }); return; }
          const value = { bytes, etag: `"object-${++nextObject}"`, versionId: `version-${nextObject}` };
          if (faults.dropStoreBefore === key) { delete faults.dropStoreBefore; request.socket.destroy(); return; }
          objects.set(key, value);
          if (faults.dropStoreAfter === key) { delete faults.dropStoreAfter; request.socket.destroy(); return; }
          send(200, Buffer.alloc(0), headers(value)); return;
        }
      }
      if (request.headers.host === 'api.github.com') {
        const root = `/repos/${policy.github.repository}/deployments/123/statuses`;
        if (url.pathname === root && request.method === 'GET') {
          const page = Number(url.searchParams.get('page')), items = reports.slice((page - 1) * 100, page * 100);
          if (faults.truncateResponse) { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 100 }); response.end('{}'); return; }
          const next = faults.badReportNext ? 'https://evil.example/steal' : `${url.origin}${url.pathname}?per_page=100&page=${page + 1}`;
          send(200, items, page * 100 < reports.length && !faults.omitReportNext ? { link: `<${next}>; rel="next"` } : {}); return;
        }
        if (url.pathname === root && request.method === 'POST') {
          const report = parseJSON(bytes); check(report.state === 'success' && report.environment === policy.github.environment && report.auto_inactive === false, 'Reporting mutation differs');
          reports.push({ ...report, id: reports.length + 1 });
          if (faults.dropReportAfter && !reportFaultUsed) { reportFaultUsed = true; request.socket.destroy(); return; }
          send(201, reports.at(-1)); return;
        }
      }
      send(400, { error: 'Unsupported transcript request' });
    } catch (error) { if (!response.destroyed) { response.writeHead(422, { 'content-type': 'application/json' }); response.end(canonical({ error: error.message })); } }
  });
  server.listen(0, '127.0.0.1'); await new Promise((accept, reject) => { server.once('listening', accept); server.once('error', reject); });
  return { ...state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((accept, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : accept()); }) };
}
