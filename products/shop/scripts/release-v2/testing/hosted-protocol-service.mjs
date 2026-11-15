import { readFile,readdir } from 'node:fs/promises';
import { verifyStoryVideoGrant } from '../../../packages/contracts/src/story-video-grants.js';
import { nativeFixtureSql } from '../native-fixture-protocol.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createServer, request as httpRequest } from 'node:http';
import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { canonical, check, digest, parseJSON, sha256 } from '../data.mjs';
import { protocolPolicy, assetManifest } from '../provider-protocol-builders.mjs';
import { createProviderSigner } from '../provider-credentials.mjs';
import { signingTrust } from '../signing.mjs';
import { protocolClient } from '../provider-protocol.mjs';
import { createCredentialCustody } from '../custody-service.mjs';
import { protectedStore } from '../protected-store.mjs';
import { admitCredentialFence, credentialBrokerBoundary } from '../hosted-writer.mjs';
import { transcriptSigner, loopbackProtocolTransport } from './provider-protocol-service.mjs';
import { materializeNativeTemplate, matchNativeTemplate } from '../native-qualification-policy.mjs';

async function loopbackServer(handler) {
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; let length = 0; for await (const chunk of request) { length += chunk.length; check(length <= 256 * 1024 * 1024, 'Fixture request bound'); chunks.push(chunk); }
      await handler(request, response, Buffer.concat(chunks));
    } catch (error) { errors.push({ message: error.message, method: request.method, path: request.url }); if (!response.destroyed) { response.writeHead(409, { 'content-type': 'application/json' }); response.end(canonical({ error: error.message })); } }
  });
  server.listen(0, '127.0.0.1'); await new Promise((accept, reject) => { server.once('listening', accept); server.once('error', reject); });
  return { server, errors, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((accept, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : accept()); }) };
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
export async function hostedProtocolFixture({ policy, targets, assets = [], faults = {}, realCredentials = true, nativeBootstrapRoot = null, invocation = null, nativeFixtureGrantKey = undefined,nativeFixtures = null,fixtureOutputs = null,mappingFixtures = [] }) {
  const workDb = new DatabaseSync(':memory:'); workDb.exec('CREATE TABLE accepted_jobs(component TEXT NOT NULL, artifact_digest TEXT NOT NULL, format TEXT NOT NULL, status TEXT NOT NULL)');
  const nativeDb=nativeFixtures?new DatabaseSync(':memory:'):null,nativeMedia=new Map();if(nativeDb){const root=new URL('../../../workers/api/',import.meta.url);for(const name of(await readdir(new URL('drizzle/',root))).filter(name=>name.endsWith('.sql')).sort())nativeDb.exec(await readFile(new URL(`drizzle/${name}`,root),'utf8'));nativeDb.exec(await readFile(new URL('sql/native-qualification.sql',root),'utf8'));}
  const workQuery = "SELECT component, artifact_digest AS artifactDigest, format FROM accepted_jobs WHERE status IN ('accepted','running','retry') ORDER BY component, artifact_digest, format";
  const custodyPolicy = protocolPolicy({ ...policy, store: { ...policy.store, prefix: `${policy.store.prefix}-custody` } });
  const mappings=new Map(mappingFixtures.map(value=>[value.UUID,structuredClone(value)]));
  const custodyObjects = new Map(), nativeProofs = new Map(),nativeFixtureTime=Date.now();
  const objects = new Map(), workers = new Map(policy.workers.map(item => [item.name, { versions: [], active: null }])), reports = [], deployments = [], ecrUploads = new Map(), ecrBlobs = new Map(), ecrImages = new Map(), transcript = [], brokerCalls = [];
  const functions = new Map(targets.filter(target => target.kind === 'lambda').map(target => [target.resource,
    { target, versions: [], active: null, latestBinding:structuredClone(target.expectedBinding),latestRevision: 'latest-revision-1', aliasRevision: null, latestImageUri:`${policy.functions.find(item=>item.name===target.resource).imageRepository}@sha256:${target.restoreImageDigest ?? target.imageDigest ?? '0'.repeat(64)}` }]));
  const credentialPair = generateKeyPairSync('ed25519'), credentialKey = 'synthetic-real-provider', session = { accountId: policy.awsAccountId, region: policy.region, accessKeyId: 'ASIASYNTHETIC12345678', secretAccessKey: 'synthetic-loopback-only-signing-secret-value', sessionToken: 'synthetic-session', expiresAt: Date.now() + 3600000 };
  const realSigner = signingPolicy => ({ signer: createProviderSigner({ policy: signingPolicy, session, bearerTokens: { cloudflare: 'synthetic-cloudflare', github: 'synthetic-github' }, keyId: credentialKey, privateKeyPem: credentialPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), trust: signingTrust({ policy: signingPolicy, keys: [{ id: credentialKey, publicKey: credentialPair.publicKey.export({ type: 'spki', format: 'pem' }) }] }) });
  let versionCounter = 0, objectCounter = 0;

  const cloud = await loopbackServer(async (request, response, bytes) => {
    const url = new URL(request.url, `https://${request.headers.host}`);
    if (realCredentials && request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) {
      const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([0-9]{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(request.headers.authorization);
      check(match && match[1] === session.accessKeyId && request.headers['x-amz-security-token'] === session.sessionToken && request.headers['x-amz-content-sha256'] === sha256(bytes), 'Actual fixture AWS credential/payload differs');
      const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`), names = match[5].split(';');
      const headers = names.map(name => `${name}:${request.headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''), query = [...url.searchParams].map(([key,value]) => [encode(key),encode(value)]).sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(item => item.join('=')).join('&');
      const canonicalRequest = [request.method, url.pathname.split('/').map(part => encode(decodeURIComponent(part))).join('/'), query, headers, names.join(';'), sha256(bytes)].join('\n'), hmac = (key,value) => createHmac('sha256',key).update(value).digest();
      const key = hmac(hmac(hmac(hmac(`AWS4${session.secretAccessKey}`,match[2]),match[3]),match[4]),'aws4_request');
      check(hmac(key,`AWS4-HMAC-SHA256\n${request.headers['x-amz-date']}\n${match[2]}/${match[3]}/${match[4]}/aws4_request\n${sha256(canonicalRequest)}`).toString('hex') === match[6], 'Actual fixture AWS signature differs');
    } else if (realCredentials) check(request.headers.authorization === 'Bearer synthetic-cloudflare' || request.headers.authorization === 'Bearer synthetic-github' || request.headers.authorization === 'Bearer private.upload.capability', 'Actual fixture provider bearer differs');
    const record = { method: request.method, url: url.href, sha256: sha256(bytes), bytes: bytes.length, ...(request.headers['x-amz-target'] ? { target: request.headers['x-amz-target'] } : {}) }; transcript.push(record);
    const send = (status, value, headers = {}) => { const body = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value)); response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers }); response.end(body); };
    const cf = result => send(200, { success: true, errors: [], result });
    if(request.headers.host==='api.cloudflare.com'&&nativeDb&&url.pathname.endsWith(`/d1/database/${policy.nativeQualification.fixtureLifecycle.databaseId}/query`)){const query=parseJSON(bytes);check(Object.values(nativeFixtureSql).includes(query.sql),'Exact builtin fixture SQL required');const statement=nativeDb.prepare(query.sql),rows=statement.columns().length?statement.all(...query.params):(statement.run(...query.params),[]);cf([{success:true,results:rows,meta:{served_by:'actual-sqlite-protocol-fixture'}}]);return;}
    if(request.headers.host==='api.cloudflare.com'&&nativeDb&&url.pathname.includes('/r2/buckets/')){const key=url.pathname.split('/r2/buckets/')[1],current=nativeMedia.get(key);if(request.method==='GET'){send(current?200:404,current??{error:'missing'});return;}if(request.method==='PUT'){nativeMedia.set(key,bytes);send(200,{});return;}if(request.method==='DELETE'){nativeMedia.delete(key);send(204,Buffer.alloc(0));return;}}
    if(request.headers.host==='api.cloudflare.com' && policy.nativeQualification && url.pathname.includes('/d1/database/')) {
      const query=parseJSON(bytes), probe=policy.nativeQualification.probes.find(item=>item.observation?.sql===query.sql && url.pathname.includes(`/${item.observation.databaseId}/`));
      if(probe){matchNativeTemplate(probe.observation.params,query.params);const proof=nativeProofs.get(probe.id);const rows=!proof || faults.nativeNoProof || proof.remaining-->0?[]:proof.rows;cf([{success:true,results:rows,meta:{served_by:'native-protocol-loopback'}}]);return;}
    }
    if (request.headers.host === 'api.cloudflare.com' && url.pathname.endsWith('/workers/assets/upload')) {
      check(request.headers.authorization === 'Bearer private.upload.capability', 'Real asset capability must stay inside custody');
      const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData(); check([...form].length === new Set(assetManifest(assets).inventory.map(asset => asset.hash)).size, 'All asset parts required');
      cf({ jwt: 'private.completion.capability' }); return;
    }
    if (request.headers.host === 'api.cloudflare.com' && policy.workInventory && url.pathname.endsWith(`/d1/database/${policy.workInventory.databaseId}/query`)) {
      const query = parseJSON(bytes); check(query.params?.length === 0 && policy.workInventory.queries.some(item => item.sql === query.sql), 'Exact installed work SELECT required');
      cf([{ success: true, results: workDb.prepare(query.sql).all(), meta: { served_by: 'sqlite-loopback', rows_read: 0 } }]); return;
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
        for(const binding of metadata.bindings??[])if(binding.type==='inherit'){check(url.searchParams.get('bindings_inherit')==='strict','Strict inheritance required');const retained=state.versions.at(-1)?.bindings.filter(item=>item.name===binding.name);check(retained?.length===1,'Exact installed inherited binding required');Object.keys(binding).forEach(key=>delete binding[key]);Object.assign(binding,retained[0]);}
        const id = `${(++versionCounter).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, version = { id, main_module: metadata.main_module, modules, bindings: metadata.bindings ?? [], compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags ?? [], ...(metadata.assets ? { assets: { config: metadata.assets.config } } : {}) };
        state.versions.push(version);
        if (faults.dropUploadAfter) { faults.dropUploadAfter = false; request.socket.destroy(); return; }
        cf({ id }); return;
      }
      if (request.method === 'POST' && url.pathname.endsWith('/deployments')) { const value = parseJSON(bytes); check(state.versions.some(item => item.id === value.versions[0].version_id), 'Cannot activate missing version'); state.active = value.versions[0].version_id;if(faults.dropWorkerRestoreAfter&&state.active===policy.nativeQualification?.fixtureLifecycle?.bootstrapWorker?.restoreVersion){faults.dropWorkerRestoreAfter=false;request.socket.destroy();return;} cf({ id: randomUUID(), versions: value.versions }); return; }
    }
    if (request.headers.host === `lambda.${policy.region}.amazonaws.com`) {
      const name = [...functions.keys()].find(item => url.pathname === `/2015-03-31/functions/${item}` || url.pathname.startsWith(`/2015-03-31/functions/${item}/`) || url.pathname.startsWith(`/2019-09-30/functions/${item}/`) || url.pathname.startsWith(`/2019-09-25/functions/${item}/`) || policy.nativeQualification?.resources.some(resource=>resource.name===item && url.pathname===`/2015-03-31/event-source-mappings/${resource.eventSourceMapping?.id}`)||policy.nativeServing?.failureResource===item&&url.pathname===`/2015-03-31/event-source-mappings/${policy.nativeServing.failureMapping.id}`);
      const lambda = functions.get(name); check(lambda, 'Synthetic Lambda target is outside the installed map');
      const root = `/2015-03-31/functions/${name}`, target = lambda.target;
      const configuration = (version, revision) => ({ ...(version==='$LATEST'?lambda.latestBinding:lambda.versions.find(item=>item.version===version)?.binding??target.expectedBinding), FunctionName: name,
        FunctionArn: `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}${version === '$LATEST' ? '' : `:${version}`}`,
        Version: version, PackageType: 'Image', State: 'Active', LastUpdateStatus: 'Successful', RevisionId: revision });
      if(url.pathname.startsWith('/2015-03-31/event-source-mappings/')){const id=url.pathname.split('/').at(-1),mapping=mappings.get(id);check(mapping,'Installed isolated mapping required');if(request.method==='GET'){if(faults.pendingMappingReads>0){faults.pendingMappingReads--;send(200,{...mapping,State:'Updating'});}else send(200,mapping);return;}const body=parseJSON(bytes);check(request.method==='PUT'&&Object.keys(body).length===1&&typeof body.FunctionName==='string','Exact mapping function update required');mapping.FunctionArn=body.FunctionName;mapping.LastModified+=1;if(faults.delayMappingAfter){faults.pendingMappingReads=faults.delayMappingAfter;faults.delayMappingAfter=0;}if(faults.dropMappingAfter){faults.dropMappingAfter=false;request.socket.destroy();return;}send(202,mapping);return;}
      const native = policy.nativeQualification?.resources.find(item=>item.name===name);
      if (request.method==='GET' && url.pathname.endsWith('/concurrency')) { send(200,{ReservedConcurrentExecutions:native.concurrency}); return; }
      if (request.method==='GET' && url.pathname.endsWith('/event-invoke-config')) { send(200,native.eventInvokeConfig); return; }
      if (request.method==='POST' && url.pathname===`${root}/invocations`) {
        const payload=parseJSON(bytes,32*1024*1024,{finiteFractions:true}), version=url.searchParams.get('Qualifier'); check(lambda.versions.some(item=>item.version===version),'Native invocation must name uploaded version');
        if(nativeDb){const fixture=nativeFixtures.fixtures.find(f=>f.jobId===payload.jobId),pin=fixture&&policy.nativeQualification.probes.find(p=>p.id===fixture.probeId);check(pin?.resource===name,'Exact actual fixture job/resource required');const grant=payload.grant.startsWith('nv5_')?payload.grant.slice(4):payload.grant;check(await verifyStoryVideoGrant(nativeFixtureGrantKey.secret,grant,fixture.jobId,Date.now(),fixture.kind==='failure'?900000:0),'Real custody HMAC grant required');const media=policy.nativeQualification.fixtureLifecycle,source=nativeMedia.get(`${media.artworkBucket}/objects/${fixture.sourceKey}`);check(source&&sha256(source)===fixture.sourceSha256,'Exact staged fixture source required');const image=fixture.kind==='v4'||fixture.kind==='v5',now=Date.now(),execution=fixture.kind==='failure'?null:randomUUID();if(fixture.kind==='v5'){const accepted=nativeDb.prepare('SELECT grant_sha256,request_sha256 FROM native_v5_dispatches WHERE job_id=?').get(fixture.jobId);check(accepted?.grant_sha256===sha256(payload.grant)&&accepted.request_sha256===sha256(bytes),'Exact real-token v5 accepted request required');}if(fixture.kind==='failure')nativeDb.prepare("UPDATE story_video_jobs SET status='failed',last_error='LAMBDA_DELIVERY_FAILED',updated_at=? WHERE id=?").run(now,fixture.jobId);else{const output=fixtureOutputs[image?'image':'video'];check(output.length===fixture.expectedOutput.bytes&&sha256(output)===fixture.expectedOutput.sha256,'Pinned fixture output bytes required');nativeMedia.set(`${image?media.artworkBucket:media.videoBucket}/objects/${fixture.outputKey}`,output);if(image)nativeDb.prepare("UPDATE product_image_jobs SET status='ready',execution_id=?,sha256=?,byte_size=?,updated_at=? WHERE id=?").run(execution,sha256(output),output.length,now,fixture.jobId);else nativeDb.prepare("UPDATE story_video_jobs SET status='ready',execution_id=?,output_byte_size=?,updated_at=?,rendered_at=? WHERE id=?").run(execution,output.length,now,now,fixture.jobId);}if(!image){for(const [stage,status,time] of fixture.kind==='failure'?[['failure-committed',204,now]]:[['claim',201,nativeFixtureTime],['upload-committed',200,nativeFixtureTime+100]])nativeDb.prepare('INSERT INTO native_video_qualification_observations(id,design_id,job_id,stage,status,execution_id,observed_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),fixture.designId,fixture.jobId,stage,status,execution,time);}if(faults.dropNativeInvokeAfter){faults.dropNativeInvokeAfter=false;request.socket.destroy();return;}send(pin.invocationType==='Event'?202:200,{}, {'x-amz-executed-version':version});return;}
        const pin=policy.nativeQualification.probes.find(item=>item.id===payload.probeId); check(pin?.resource===name,'Pinned native probe target required');
        const rows=materializeNativeTemplate(pin.observation.expectedRows,payload);
        nativeProofs.set(pin.id,{rows,remaining:faults.nativeObservationDelay??0});
        if(faults.dropNativeInvokeAfter){faults.dropNativeInvokeAfter=false;request.socket.destroy();return;}
        send(pin.invocationType==='Event'?202:200,{}, {'x-amz-executed-version':version,...(faults.nativeInvocationError?{'x-amz-function-error':'Unhandled'}:{})}); return;
      }
      if (request.method==='DELETE' && url.pathname===root) { const version=url.searchParams.get('Qualifier'); check(version && lambda.active!==version,'Only unaliased numbered version may be deleted'); lambda.versions=lambda.versions.filter(item=>item.version!==version);send(204,Buffer.alloc(0));return; }
      if (request.method === 'GET' && url.pathname === `${root}/versions`) {
        send(200, { Versions: lambda.versions.map(item => configuration(item.version, item.revision)) }); return;
      }
      if (request.method === 'GET' && url.pathname === root) {
        const qualifier = url.searchParams.get('Qualifier');
        if (!qualifier) { send(200, { Configuration: configuration('$LATEST', lambda.latestRevision),Code:{ImageUri:lambda.latestImageUri,ResolvedImageUri:lambda.latestImageUri} }); return; }
        const version = lambda.versions.find(item => item.version === qualifier); if(!version){send(404,{Type:'ResourceNotFoundException'});return;}
        const ready=configuration(version.version,version.revision);if(faults.lambdaPendingReads>0){faults.lambdaPendingReads--;ready.State='Pending';ready.LastUpdateStatus='InProgress';}send(200, { Configuration: ready, Code: { ImageUri: version.imageUri, ResolvedImageUri: version.imageUri } }); return;
      }
      if(request.method==='PUT'&&url.pathname===`${root}/configuration`){if(faults.dropConfigureBefore){faults.dropConfigureBefore=false;request.socket.destroy();return;}const value=parseJSON(bytes);check(value.RevisionId===lambda.latestRevision&&Object.keys(value).length===2,'Exact configuration revision required');lambda.latestBinding={...lambda.latestBinding,Environment:value.Environment};lambda.latestRevision=`configured-${randomUUID()}`;if(faults.dropConfigureAfter){faults.dropConfigureAfter=false;request.socket.destroy();return;}send(200,configuration('$LATEST',lambda.latestRevision));return;}
      if (request.method === 'PUT' && url.pathname === `${root}/code`) {
        const value = parseJSON(bytes), resource = policy.functions.find(item => item.name === name);
        check((value.Publish === true || native && value.Publish===false) && value.RevisionId === lambda.latestRevision && new RegExp(`^${resource.imageRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@sha256:[a-f0-9]{64}$`).test(value.ImageUri), 'Synthetic Lambda upload identity differs');
        lambda.latestImageUri=value.ImageUri;
        if(value.Publish===false){lambda.latestRevision=`latest-revision-${randomUUID()}`;send(200,configuration('$LATEST',lambda.latestRevision));return;}
        const version = String(lambda.versions.length + 1), revision = `version-revision-${version}`;
        lambda.versions.push({ version, revision, imageUri: value.ImageUri,binding:structuredClone(lambda.latestBinding) }); lambda.latestRevision = `latest-revision-${lambda.versions.length + 1}`;
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
    if (request.headers.host === `api.ecr.${policy.region}.amazonaws.com`) {
      const value = parseJSON(bytes), operation = request.headers['x-amz-target']?.split('.').at(-1), repository = value.repositoryName;
      check(value.registryId === policy.awsAccountId && policy.functions.some(item => item.imageRepository.endsWith(`.amazonaws.com/${repository}`)), 'Exact ECR registry/repository required');
      const identity = { registryId: policy.awsAccountId, repositoryName: repository };
      if (operation === 'BatchCheckLayerAvailability') { send(200, { layers: value.layerDigests.map(layerDigest => { const blob = ecrBlobs.get(`${repository}/${layerDigest}`); return { layerDigest, layerAvailability: blob ? 'AVAILABLE' : 'UNAVAILABLE', ...(blob ? { layerSize: blob.length } : {}) }; }), failures: [] }); return; }
      if (operation === 'InitiateLayerUpload') { const uploadId = randomUUID(); ecrUploads.set(uploadId, { repository, parts: [] }); send(200, { ...identity, uploadId, partSize: 20971520 }); return; }
      if (operation === 'UploadLayerPart') { const upload = ecrUploads.get(value.uploadId), part = Buffer.from(value.layerPartBlob, 'base64'); check(upload?.repository === repository && Buffer.concat(upload.parts).length === value.partFirstByte && value.partLastByte === value.partFirstByte + part.length - 1, 'Exact ECR part range required'); upload.parts.push(part); send(200, { ...identity, uploadId: value.uploadId, lastByteReceived: value.partLastByte }); return; }
      if (operation === 'CompleteLayerUpload') { const upload = ecrUploads.get(value.uploadId), blob = Buffer.concat(upload.parts); check(upload.repository === repository && value.layerDigests.length === 1 && value.layerDigests[0] === `sha256:${sha256(blob)}`, 'Exact ECR completed blob digest required'); ecrBlobs.set(`${repository}/${value.layerDigests[0]}`, blob); send(200, { ...identity, uploadId: value.uploadId, layerDigest: value.layerDigests[0] }); return; }
      if (operation === 'PutImage') { const manifest = parseJSON(Buffer.from(value.imageManifest)); check(value.imageDigest === `sha256:${sha256(value.imageManifest)}` && [manifest.config, ...manifest.layers].every(item => ecrBlobs.has(`${repository}/${item.digest}`)), 'Complete ECR image graph required'); const image = { ...identity, imageId: { imageDigest: value.imageDigest }, imageManifest: value.imageManifest, imageManifestMediaType: value.imageManifestMediaType }; ecrImages.set(`${repository}/${value.imageDigest}`, image); if (faults.dropEcrPutAfter) { faults.dropEcrPutAfter = false; request.socket.destroy(); return; } send(200, { image }); return; }
      if (operation === 'BatchGetImage') { const image = ecrImages.get(`${repository}/${value.imageIds[0].imageDigest}`); send(200, { images: image ? [image] : [], failures: image ? [] : [{ imageId: value.imageIds[0], failureCode: 'ImageNotFound' }] }); return; }
    }
    if (request.headers.host === `${policy.store.bucket}.s3.${policy.region}.amazonaws.com`) {
      const custodyRequest = url.pathname.startsWith(`/${custodyPolicy.store.prefix}/`), activePolicy = custodyRequest ? custodyPolicy : policy, activeObjects = custodyRequest ? custodyObjects : objects;
      const key = url.pathname.slice(activePolicy.store.prefix.length + 2), current = activeObjects.get(key);
      const headers = item => ({ etag: item.etag, 'x-amz-version-id': item.versionId, 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': policy.store.kmsKeyArn });
      if (request.method === 'GET') { if (current) send(200, current.bytes, headers(current)); else send(404, { Code: 'NoSuchKey' }); return; }
      check(request.method === 'PUT' && request.headers['x-amz-expected-bucket-owner'] === policy.awsAccountId && request.headers['x-amz-server-side-encryption-aws-kms-key-id'] === policy.store.kmsKeyArn, 'Protected store identity differs');
      if (request.headers['if-none-match'] === '*' ? Boolean(current) : current?.etag !== request.headers['if-match']) { send(412, { Code: 'PreconditionFailed' }); return; }
      const fault=faults.journalFault,kind=key==='head.json'?'head':'event',matchesFault=!custodyRequest&&fault&&fault.key===kind;
      if(matchesFault&&fault.when==='before'){faults.journalFault=null;request.socket.destroy();return;}
      const item = { bytes, etag: `"state-${++objectCounter}"`, versionId: `version-${objectCounter}` }; activeObjects.set(key, item);if(matchesFault&&fault.when==='after'){faults.journalFault=null;request.socket.destroy();return;}send(200, Buffer.alloc(0), headers(item)); return;
    }
    if (request.headers.host === 'api.github.com') {
      const root = `/repos/${policy.github.repository}/deployments`;
      if (url.pathname === root) {
        if (request.method === 'GET') { send(200, deployments.filter(item => item.sha === url.searchParams.get('sha') && item.environment === url.searchParams.get('environment'))); return; }
        const value = parseJSON(bytes); const deployment = { ...value, sha: value.ref, id: deployments.length + 1000 }; deployments.push(deployment);
        if (faults.dropDeploymentAfter) { faults.dropDeploymentAfter = false; request.socket.destroy(); return; }
        send(201, deployment); return;
      }
      const deploymentId = url.pathname.split('/').at(-2);
      if (request.method === 'GET') { send(200, reports.filter(item => !item.deploymentId || item.deploymentId === deploymentId)); return; }
      if (faults.dropReportBefore) { faults.dropReportBefore = false; request.socket.destroy(); return; }
      const report = parseJSON(bytes); reports.push({ ...report, deploymentId, id: reports.length + 1 });
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
  const signer = realCredentials ? realSigner(policy) : transcriptSigner(policy), custodySigner = realCredentials ? realSigner(custodyPolicy) : transcriptSigner(custodyPolicy);
  const custodyStore = protectedStore(protocolClient({ policy: custodyPolicy, ...custodySigner, transport: loopbackProtocolTransport(cloud.origin) }), custodyPolicy);
  const installation = envelope({ schema: 'shop.credential-installation/v1', fenceDigest: fenceAdmission.digest, environmentId: 'synthetic-qualification', installationId: randomUUID(), credentialEpoch: 'epoch-one', custodyPolicyDigest: digest(custodyPolicy), issuedAt: Date.now(), expiresAt: Date.now() + 3600000 });
  const factoryOptions = { policy, custodyPolicy, custodyStore, fenceAdmission, installation, ...signer, nativeBootstrapRoot,nativeFixtureGrantKey, transport: loopbackProtocolTransport(cloud.origin), attest: async payload => envelope(payload),
    authenticate: async (_input, context) => { check(context?.authorization === 'Bearer synthetic-loopback-controller', 'Synthetic authenticated controller required'); return { environmentId: 'synthetic-qualification', policyDigest: digest(policy), fenceDigest: fenceAdmission.digest, principalDigest: sha256('synthetic-protected-controller'),invocation }; },
    ...(policy.workInventory ? {} : { observeWork: async () => ({ complete: true, queryDigest: sha256(workQuery), jobs: workDb.prepare(workQuery).all() }) }), resolveAssets: async () => assets };
  const executor = await createCredentialCustody(factoryOptions);
  const custody = await loopbackServer(async (request, response, bytes) => {
    const input = parseJSON(bytes, 256 * 1024 * 1024); brokerCalls.push({ action: input.action, owner: input.owner, operation: input.request?.operation ?? null, nonce: input.nonce });
    const reply = await executor.handle(input, { authorization: request.headers.authorization });
    if (input.action === 'dispatch' && faults.dropCustodyAfterDispatch) { faults.dropCustodyAfterDispatch = false; request.socket.destroy(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(canonical(reply));
  });
  const boundary = input => literalJSON(custody.origin, input), broker = credentialBrokerBoundary({ fenceAdmission, boundary });
  return { policy, targets, brokerErrors: custody.errors, cloudErrors: cloud.errors, custodyOrigin: custody.origin, receipt, publicKeys, fenceAdmission, broker, boundary, cloudOrigin: cloud.origin, factoryOptions, signRoot: envelope, workDb,nativeDb,nativeMedia,mappings, objects, custodyObjects, executor, custodyStore, custodyPolicy, installation, workers, functions, reports, deployments, ecrBlobs, ecrImages, transcript, brokerCalls, faults,
    workInventory: broker.workInventory,
    stopDrainRevoke: async () => { const state = await executor.readState(); return executor.recoverOwner(envelope({ schema: 'shop.custody-owner-recovery/v1', fenceDigest: fenceAdmission.digest, installationId: installation.payload.installationId, owner: state.owner.id, controllerStopped: true, issuedAt: Date.now(), expiresAt: Date.now() + 60000 })); },
    close: async () => { await custody.close(); await cloud.close(); workDb.close();nativeDb?.close(); } };
}
