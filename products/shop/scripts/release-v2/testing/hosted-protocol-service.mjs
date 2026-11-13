import { DatabaseSync } from 'node:sqlite';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { canonical, check, digest, parseJSON, sha256 } from '../data.mjs';
import { protocolPolicy, assetManifest } from '../provider-protocol-builders.mjs';
import { protocolClient } from '../provider-protocol.mjs';
import { createCredentialCustody } from '../custody-service.mjs';
import { protectedStore } from '../protected-store.mjs';
import { admitCredentialFence, credentialBrokerBoundary } from '../hosted-writer.mjs';
import { transcriptSigner, loopbackProtocolTransport } from './provider-protocol-service.mjs';

async function loopbackServer(handler) {
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; let length = 0; for await (const chunk of request) { length += chunk.length; check(length <= 256 * 1024 * 1024, 'Fixture request bound'); chunks.push(chunk); }
      await handler(request, response, Buffer.concat(chunks));
    } catch (error) { if (!response.destroyed) { response.writeHead(409, { 'content-type': 'application/json' }); response.end(canonical({ error: error.message })); } }
  });
  server.listen(0, '127.0.0.1'); await new Promise((accept, reject) => { server.once('listening', accept); server.once('error', reject); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((accept, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : accept()); }) };
}
export async function literalJSON(origin, value, path = '/') {
  const url = new URL(origin), bytes = Buffer.from(canonical(value));
  check(url.hostname === '127.0.0.1' && url.protocol === 'http:', 'Literal loopback fixture required');
  return new Promise((accept, reject) => {
    const operation = httpRequest({ hostname: '127.0.0.1', port: url.port, path, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': bytes.length, authorization: 'Bearer synthetic-loopback-controller' } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('aborted', () => reject(Error('Broker response was truncated'))); response.on('error', reject);
      response.on('end', () => { const result = parseJSON(Buffer.concat(chunks), 64 * 1024 * 1024); if (response.statusCode !== 200) reject(Error(result.error)); else accept(result); });
    });
    const timer = setTimeout(() => { reject(Error('Broker deadline')); operation.destroy(); }, 5000); operation.on('close', () => clearTimeout(timer)); operation.on('error', reject); operation.end(bytes);
  });
}
export async function hostedProtocolFixture({ policy, targets, assets = [], faults = {} }) {
  const workDb = new DatabaseSync(':memory:'); workDb.exec('CREATE TABLE accepted_jobs(component TEXT NOT NULL, artifact_digest TEXT NOT NULL, format TEXT NOT NULL, status TEXT NOT NULL)');
  const workQuery = "SELECT component, artifact_digest AS artifactDigest, format FROM accepted_jobs WHERE status IN ('accepted','running','retry') ORDER BY component, artifact_digest, format";
  const custodyPolicy = protocolPolicy({ ...policy, store: { ...policy.store, prefix: `${policy.store.prefix}-custody` } });
  const custodyObjects = new Map();
  const objects = new Map(), workers = new Map(policy.workers.map(item => [item.name, { versions: [], active: null }])), reports = [], transcript = [], brokerCalls = [];
  const functions = new Map(targets.filter(target => target.kind === 'lambda').map(target => [target.resource,
    { target, versions: [], active: null, latestRevision: 'latest-revision-1', aliasRevision: null }]));
  let versionCounter = 0, objectCounter = 0;
  const cloud = await loopbackServer(async (request, response, bytes) => {
    const url = new URL(request.url, `https://${request.headers.host}`), record = { method: request.method, url: url.href, sha256: sha256(bytes), bytes: bytes.length }; transcript.push(record);
    const send = (status, value, headers = {}) => { const body = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value)); response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers }); response.end(body); };
    const cf = result => send(200, { success: true, errors: [], result });
    if (request.headers.host === 'api.cloudflare.com' && url.pathname.endsWith('/workers/assets/upload')) {
      check(request.headers.authorization === 'Bearer private.upload.capability', 'Real asset capability must stay inside custody');
      const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData(); check([...form].length === new Set(assetManifest(assets).inventory.map(asset => asset.hash)).size, 'All asset parts required');
      cf({ jwt: 'private.completion.capability' }); return;
    }
    const worker = [...workers.keys()].find(name => url.pathname.includes(`/${name}/`)), state = workers.get(worker);
    if (request.headers.host === 'api.cloudflare.com' && state) {
      if (request.method === 'POST' && url.pathname.endsWith('/assets-upload-session')) { check(digest(parseJSON(bytes).manifest) === digest(assetManifest(assets).manifest), 'Full asset manifest differs'); cf({ jwt: 'private.upload.capability', buckets: [[...new Set(assetManifest(assets).inventory.map(asset => asset.hash))]] }); return; }
      if (request.method === 'GET' && url.pathname.endsWith('/versions')) { const page = Number(url.searchParams.get('page')); cf({ items: state.versions.slice((page - 1) * 100, page * 100).map(item => ({ id: item.id })) }); return; }
      if (request.method === 'GET' && /\/workers\/workers\/[^/]+\/versions\//.test(url.pathname)) { const version = state.versions.find(item => item.id === url.pathname.split('/').at(-1)); check(version, 'Unknown immutable version'); cf(faults.versionResponseId ? { ...version, id: faults.versionResponseId } : version); return; }
      if (request.method === 'GET' && url.pathname.endsWith('/deployments')) { cf({ deployments: state.active ? [{ id: randomUUID(), versions: [{ version_id: state.active, percentage: 100 }] }] : [] }); return; }
      if (request.method === 'POST' && url.pathname.endsWith('/versions')) {
        const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData(), metadata = parseJSON(Buffer.from(form.get('metadata'))), modules = [];
        for (const [name, part] of form) if (name !== 'metadata') modules.push({ name, content_type: part.type, content_base64: Buffer.from(await part.arrayBuffer()).toString('base64') });
        if (metadata.assets?.jwt) check(metadata.assets.jwt === 'private.completion.capability', 'Real completion capability must stay inside custody');
        const id = `${(++versionCounter).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, version = { id, main_module: metadata.main_module, modules, bindings: metadata.bindings ?? [], compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags ?? [], ...(metadata.assets ? { assets: { config: metadata.assets.config } } : {}) };
        state.versions.push(version);
        if (faults.dropUploadAfter) { faults.dropUploadAfter = false; request.socket.destroy(); return; }
        cf({ id }); return;
      }
      if (request.method === 'POST' && url.pathname.endsWith('/deployments')) { const value = parseJSON(bytes); check(state.versions.some(item => item.id === value.versions[0].version_id), 'Cannot activate missing version'); state.active = value.versions[0].version_id; cf({ id: randomUUID(), versions: value.versions }); return; }
    }
    if (request.headers.host === `lambda.${policy.region}.amazonaws.com`) {
      const name = [...functions.keys()].find(item => url.pathname === `/2015-03-31/functions/${item}` || url.pathname.startsWith(`/2015-03-31/functions/${item}/`));
      const lambda = functions.get(name); check(lambda, 'Synthetic Lambda target is outside the installed map');
      const root = `/2015-03-31/functions/${name}`, target = lambda.target;
      const configuration = (version, revision) => ({ ...target.expectedBinding, FunctionName: name,
        FunctionArn: `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}${version === '$LATEST' ? '' : `:${version}`}`,
        Version: version, PackageType: 'Image', State: 'Active', LastUpdateStatus: 'Successful', RevisionId: revision });
      if (request.method === 'GET' && url.pathname === `${root}/versions`) {
        send(200, { Versions: lambda.versions.map(item => configuration(item.version, item.revision)) }); return;
      }
      if (request.method === 'GET' && url.pathname === root) {
        const qualifier = url.searchParams.get('Qualifier');
        if (!qualifier) { send(200, { Configuration: configuration('$LATEST', lambda.latestRevision) }); return; }
        const version = lambda.versions.find(item => item.version === qualifier); check(version, 'Unknown immutable synthetic Lambda version');
        send(200, { Configuration: configuration(version.version, version.revision), Code: { ImageUri: version.imageUri, ResolvedImageUri: version.imageUri } }); return;
      }
      if (request.method === 'PUT' && url.pathname === `${root}/code`) {
        const value = parseJSON(bytes), resource = policy.functions.find(item => item.name === name);
        check(value.Publish === true && value.RevisionId === lambda.latestRevision && new RegExp(`^${resource.imageRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@sha256:[a-f0-9]{64}$`).test(value.ImageUri), 'Synthetic Lambda upload identity differs');
        const version = String(lambda.versions.length + 1), revision = `version-revision-${version}`;
        lambda.versions.push({ version, revision, imageUri: value.ImageUri }); lambda.latestRevision = `latest-revision-${lambda.versions.length + 1}`;
        if (faults.dropLambdaUploadAfter) { faults.dropLambdaUploadAfter = false; request.socket.destroy(); return; }
        send(200, configuration(version, revision)); return;
      }
      if (request.method === 'GET' && url.pathname === `${root}/aliases/${target.alias}`) {
        if (lambda.active === null) { send(404, { Type: 'ResourceNotFoundException' }); return; }
        send(200, { Name: target.alias, AliasArn: `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:${target.alias}`,
          FunctionVersion: lambda.active, RevisionId: lambda.aliasRevision, RoutingConfig: { AdditionalVersionWeights: {} } }); return;
      }
      if ((request.method === 'PUT' && url.pathname === `${root}/aliases/${target.alias}`) || (request.method === 'POST' && url.pathname === `${root}/aliases`)) {
        const value = parseJSON(bytes);
        if (request.method === 'POST') check(lambda.active === null && value.Name === target.alias, 'Synthetic Lambda alias already exists or differs');
        else if (lambda.aliasRevision !== value.RevisionId) { send(412, { Type: 'PreconditionFailedException' }); return; }
        check(lambda.versions.some(item => item.version === value.FunctionVersion), 'Cannot activate missing synthetic Lambda version');
        lambda.active = value.FunctionVersion; lambda.aliasRevision = `alias-revision-${randomUUID()}`;
        send(request.method === 'POST' ? 201 : 200, { Name: target.alias, AliasArn: `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:${target.alias}`,
          FunctionVersion: lambda.active, RevisionId: lambda.aliasRevision, RoutingConfig: { AdditionalVersionWeights: {} } }); return;
      }
    }
    if (request.headers.host === `${policy.store.bucket}.s3.${policy.region}.amazonaws.com`) {
      const custodyRequest = url.pathname.startsWith(`/${custodyPolicy.store.prefix}/`), activePolicy = custodyRequest ? custodyPolicy : policy, activeObjects = custodyRequest ? custodyObjects : objects;
      const key = url.pathname.slice(activePolicy.store.prefix.length + 2), current = activeObjects.get(key);
      const headers = item => ({ etag: item.etag, 'x-amz-version-id': item.versionId, 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': policy.store.kmsKeyArn });
      if (request.method === 'GET') { if (current) send(200, current.bytes, headers(current)); else send(404, { Code: 'NoSuchKey' }); return; }
      check(request.method === 'PUT' && request.headers['x-amz-expected-bucket-owner'] === policy.awsAccountId && request.headers['x-amz-server-side-encryption-aws-kms-key-id'] === policy.store.kmsKeyArn, 'Protected store identity differs');
      if (request.headers['if-none-match'] === '*' ? Boolean(current) : current?.etag !== request.headers['if-match']) { send(412, { Code: 'PreconditionFailed' }); return; }
      const item = { bytes, etag: `"state-${++objectCounter}"`, versionId: `version-${objectCounter}` }; activeObjects.set(key, item); send(200, Buffer.alloc(0), headers(item)); return;
    }
    if (request.headers.host === 'api.github.com') {
      if (request.method === 'GET') { send(200, reports); return; }
      if (faults.dropReportBefore) { faults.dropReportBefore = false; request.socket.destroy(); return; }
      const report = parseJSON(bytes); reports.push({ ...report, id: reports.length + 1 });
      if (faults.dropReportAfter) { faults.dropReportAfter = false; request.socket.destroy(); return; }
      send(201, reports.at(-1)); return;
    }
    send(400, { error: 'Unsupported serialized provider request' });
  });
  const keys = generateKeyPairSync('ed25519'), keyId = 'synthetic-custody-root', publicKeys = [{ id: keyId, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }];
  const envelope = payload => ({ keyId, payload, signature: sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString('base64') });
  const now = Date.now(), implementationDigest = sha256('synthetic-loopback-credential-custody-installation');
  const receipt = envelope({ schema: 'shop.credential-fence/v1', scope: 'protected-provider-writer', environmentId: 'synthetic-qualification', policyDigest: digest(policy), brokerId: 'synthetic-custody', implementationDigest, credentialCustody: 'broker-exclusive', ownership: 'non-expiring-single-writer', sendBoundary: 'atomic-owner-check-and-dispatch', reassignment: 'stop-drain-revoke-before-reassign', issuedAt: now, expiresAt: now + 3600000 });
  const fenceAdmission = admitCredentialFence(receipt, { keys: publicKeys, policy, environmentId: 'synthetic-qualification', brokerId: 'synthetic-custody', implementationDigest });
  const signer = transcriptSigner(policy), custodySigner = transcriptSigner(custodyPolicy);
  const custodyStore = protectedStore(protocolClient({ policy: custodyPolicy, ...custodySigner, transport: loopbackProtocolTransport(cloud.origin) }), custodyPolicy);
  const installation = envelope({ schema: 'shop.credential-installation/v1', fenceDigest: fenceAdmission.digest, environmentId: 'synthetic-qualification', installationId: randomUUID(), credentialEpoch: 'epoch-one', custodyPolicyDigest: digest(custodyPolicy), issuedAt: Date.now(), expiresAt: Date.now() + 3600000 });
  const factoryOptions = { policy, custodyPolicy, custodyStore, fenceAdmission, installation, ...signer, transport: loopbackProtocolTransport(cloud.origin), attest: async payload => envelope(payload),
    authenticate: async (_input, context) => { check(context?.authorization === 'Bearer synthetic-loopback-controller', 'Synthetic authenticated controller required'); return { environmentId: 'synthetic-qualification', policyDigest: digest(policy), fenceDigest: fenceAdmission.digest, principalDigest: sha256('synthetic-protected-controller') }; },
    observeWork: async () => ({ complete: true, queryDigest: sha256(workQuery), jobs: workDb.prepare(workQuery).all() }), resolveAssets: async () => assets };
  const executor = await createCredentialCustody(factoryOptions);
  const custody = await loopbackServer(async (request, response, bytes) => {
    const input = parseJSON(bytes, 256 * 1024 * 1024); brokerCalls.push({ action: input.action, owner: input.owner, operation: input.request?.operation ?? null, nonce: input.nonce });
    const reply = await executor.handle(input, { authorization: request.headers.authorization });
    if (input.action === 'dispatch' && faults.dropCustodyAfterDispatch) { faults.dropCustodyAfterDispatch = false; request.socket.destroy(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(canonical(reply));
  });
  const boundary = input => literalJSON(custody.origin, input), broker = credentialBrokerBoundary({ fenceAdmission, boundary });
  return { policy, targets, custodyOrigin: custody.origin, receipt, publicKeys, fenceAdmission, broker, boundary, cloudOrigin: cloud.origin, factoryOptions, signRoot: envelope, workDb, objects, custodyObjects, executor, custodyStore, custodyPolicy, installation, workers, functions, reports, transcript, brokerCalls, faults,
    workInventory: broker.workInventory,
    stopDrainRevoke: async () => { const state = await executor.readState(); return executor.recoverOwner(envelope({ schema: 'shop.custody-owner-recovery/v1', fenceDigest: fenceAdmission.digest, installationId: installation.payload.installationId, owner: state.owner.id, controllerStopped: true, issuedAt: Date.now(), expiresAt: Date.now() + 60000 })); },
    close: async () => { await custody.close(); await cloud.close(); workDb.close(); } };
}
