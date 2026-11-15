import { check, digest, parseJSON } from './data.mjs';
import { assertPolicy, exactFields, protocolByteLimit, requestBuilders, sourceMapDataDigest } from './provider-protocol-builders.mjs';
import { sha256 } from './data.mjs';
import { matchNativeTemplate } from './native-qualification-policy.mjs';
import { materializeServingMetadata } from './serving-provider.mjs';
import { nativeFixtureSql } from './native-fixture-protocol.mjs';

// The custody process receives data over HTTP. Rebuilding with the production
// builders restores their capability marker and checks the full serialization
// before a provider signer can receive it.
export async function rehydrateProviderRequest(input, { policy, assets = null }) {
  assertPolicy(policy); exactFields(input, ['schema', 'policyDigest', 'service', 'operation', 'method', 'url', 'headers', 'bodyBase64', 'bodySha256']);
  check(input.schema === 'shop.provider-request/v1' && input.policyDigest === digest(policy) && typeof input.bodyBase64 === 'string' && input.bodyBase64.length <= Math.ceil(protocolByteLimit / 3) * 4, 'Custody request schema/policy/size differs');
  const builders = requestBuilders(policy), url = new URL(input.url), body = Buffer.from(input.bodyBase64, 'base64');
  check(body.toString('base64') === input.bodyBase64 && sha256(body) === input.bodySha256 && body.length <= protocolByteLimit, 'Custody request bytes differ');
  const ecrBody = input.service === 'ecr' ? parseJSON(body) : null, ecrFunction = ecrBody ? policy.functions.find(item => item.imageRepository.split('.amazonaws.com/')[1] === ecrBody.repositoryName) : null;
  const worker = policy.workers.find(item => url.pathname.includes(`/${item.name}/`)), fn = policy.functions.find(item => url.pathname === `/2015-03-31/functions/${item.name}` || url.pathname.startsWith(`/2015-03-31/functions/${item.name}/`));
  const relativeStoreKey = input.service === 's3' ? url.pathname.slice(policy.store.prefix.length + 2) : '', namespaceMatch = /^(native-qualification\/[a-f0-9]{64})\/(.+)$/.exec(relativeStoreKey), namespace = namespaceMatch?.[1] ?? null, storeKey = namespaceMatch?.[2] ?? relativeStoreKey;
  let request;
  switch (input.operation) {
    case 'native.fixture-query': case 'native.fixture-read': {const value=parseJSON(body),action=Object.keys(nativeFixtureSql).find(action=>nativeFixtureSql[action]===value.sql);request=builders.nativeFixtureQuery(action,value.params);break;}
    case 'native.fixture-object-get': case 'native.fixture-object-put': case 'native.fixture-object-delete': {const parts=url.pathname.split('/'),bucket=parts[7],key=parts.slice(9).join('/');request=input.operation==='native.fixture-object-get'?builders.nativeFixtureObjectGet(bucket,key):input.operation==='native.fixture-object-delete'?builders.nativeFixtureObjectDelete(bucket,key):builders.nativeFixtureObjectPut(bucket,key,body);break;}
    case 'lambda.serving-configure': {const value=parseJSON(body);request=builders.servingConfigure(fn?.name,value.Environment,value.RevisionId);break;}
    case 'lambda.serving-event-mapping': request=builders.servingEventMapping();break;
    case 'lambda.serving-update-event-mapping': request=builders.servingUpdateMapping(parseJSON(body).FunctionName?.split(':').at(-1));break;
    case 'lambda.native-concurrency': request = builders.nativeConcurrency(policy.nativeQualification?.resources.find(item => url.pathname === `/2019-09-30/functions/${item.name}/concurrency`)?.name); break;
    case 'lambda.native-event-config': request = builders.nativeEventConfig(policy.nativeQualification?.resources.find(item => url.pathname === `/2019-09-25/functions/${item.name}/event-invoke-config`)?.name); break;
    case 'lambda.native-event-mapping': request = builders.nativeEventMapping(policy.nativeQualification?.resources.find(item => url.pathname === `/2015-03-31/event-source-mappings/${item.eventSourceMapping?.id}`)?.name); break;
    case 'lambda.native-update-event-mapping': {const pin=policy.nativeQualification?.resources.find(item=>url.pathname===`/2015-03-31/event-source-mappings/${item.eventSourceMapping?.id}`),target=parseJSON(body).FunctionName;request=builders.nativeUpdateMapping(pin?.name,target===pin?.eventSourceMapping.restoreFunctionArn?null:target?.split(':').at(-1));break;}
    case 'lambda.native-invoke': { const payload = parseJSON(body,1024*1024,{finiteFractions:true}), matches = policy.nativeQualification?.probes.filter(item => { if (item.resource !== fn?.name || item.invocationType !== input.headers['x-amz-invocation-type']) return false; try { if(item.fixtureKind){builders.nativeInvoke(item.id,url.searchParams.get('Qualifier'),payload);}else if (Object.hasOwn(item,'payloadTemplate')) matchNativeTemplate(item.payloadTemplate,payload); else check(item.payloadDigest === digest(payload), 'Probe payload differs'); return true; } catch { return false; } }); check(matches?.length>=1, 'Exact native probe identity required'); request = builders.nativeInvoke(matches[0].id, url.searchParams.get('Qualifier'), payload); check(matches.every(item=>digest(builders.nativeInvoke(item.id,url.searchParams.get('Qualifier'),payload))===digest(request)),'Ambiguous native probe serialization');break; }
    case 'lambda.native-delete-version': request = builders.nativeDeleteVersion(fn?.name, url.searchParams.get('Qualifier')); break;
    case 'lambda.native-restore': { const value = parseJSON(body); request = builders.nativeRestore(fn?.name, value.ImageUri?.split('@sha256:')[1], value.RevisionId); break; }
    case 'native.observation': { const value = parseJSON(body), matches = policy.nativeQualification?.probes.filter(item => { if (item.observation?.databaseId !== url.pathname.split('/').at(-2) || item.observation.sql !== value.sql) return false; try { matchNativeTemplate(item.observation.params,value.params); return true; } catch { return false; } }); check(matches?.length === 1, 'Unique exact native observation required'); request = builders.nativeObservation(matches[0].id,value.params); break; }
    case 'ecr.check-layers': request = builders.ecrCheckLayers(ecrFunction?.name, ecrBody.layerDigests.map(value => value.slice(7))); break;
    case 'ecr.initiate-layer': request = builders.ecrInitiateLayer(ecrFunction?.name); break;
    case 'ecr.upload-part': request = builders.ecrUploadPart(ecrFunction?.name, ecrBody.uploadId, Buffer.from(ecrBody.layerPartBlob, 'base64'), ecrBody.partFirstByte); break;
    case 'ecr.complete-layer': request = builders.ecrCompleteLayer(ecrFunction?.name, ecrBody.uploadId, ecrBody.layerDigests[0]?.slice(7)); break;
    case 'ecr.put-image': request = builders.ecrPutImage(ecrFunction?.name, Buffer.from(ecrBody.imageManifest), ecrBody.imageDigest?.slice(7)); break;
    case 'ecr.get-image': request = builders.ecrGetImage(ecrFunction?.name, ecrBody.imageIds[0]?.imageDigest?.slice(7)); break;
    case 'work.query': { const value = parseJSON(body); const index = policy.workInventory?.queries.findIndex(query => query.sql === value.sql); request = builders.workQuery(index); break; }
    case 'store.get': request = builders.storeGet(storeKey,namespace); break;
    case 'store.put': request = builders.storePut(storeKey, body, input.headers['if-match'] ?? null,namespace); break;
    case 'worker.versions': request = builders.workerVersions(worker?.name, Number(url.searchParams.get('page'))); break;
    case 'worker.version': request = builders.workerVersion(worker?.name, url.pathname.split('/').at(-1)); break;
    case 'worker.version-content': request = builders.workerVersionContent(worker?.name, url.pathname.split('/').at(-1)); break;
    case 'worker.deployments': request = builders.workerDeployments(worker?.name); break;
    case 'worker.settings': request = builders.workerSettings(worker?.name); break;
    case 'worker.content': request = builders.workerContent(worker?.name); break;
    case 'worker.upload': {
      const form = await new Response(body, { headers: { 'content-type': input.headers['content-type'] } }).formData();
      check(form.getAll('metadata').length === 1 && typeof form.get('metadata') === 'string', 'Exact Worker upload metadata required');
      const metadata = parseJSON(Buffer.from(form.get('metadata'))), modules = [];
      for (const [name, part] of form) if (name !== 'metadata') { check(typeof part !== 'string', 'Binary Worker module required'); modules.push({ name, type: part.type, bytes: Buffer.from(await part.arrayBuffer()) }); }
      const expectedInventory = modules.map(part => ({ name: part.name, type: part.type, bytes: part.bytes.length, sha256: sha256(part.bytes), ...(part.name.endsWith('.map') ? { sourceMapDataSha256: sourceMapDataDigest(part.bytes) } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
      request = builders.workerUpload(worker?.name, { entrypoint: metadata.main_module, metadata, modules, expectedInventory }); break;
    }
    case 'worker.activate': request = builders.workerActivate(worker?.name, parseJSON(body).versions?.[0]?.version_id); break;
    case 'assets.session': check(Array.isArray(assets), 'Retained exact assets required inside custody'); request = builders.assetSession(worker?.name, assets); break;
    case 'assets.upload': {
      check(Array.isArray(assets), 'Retained exact assets required inside custody');
      const form = await new Response(body, { headers: { 'content-type': input.headers['content-type'] } }).formData();
      check(input.headers.authorization?.startsWith('Bearer '), 'Exact provider asset session capability required');
      request = builders.assetUpload(assets, [...form.keys()], input.headers.authorization.slice(7)); break;
    }
    case 'lambda.versions': request = builders.lambdaVersions(fn?.name, url.searchParams.get('Marker')); break;
    case 'lambda.function': request = builders.lambdaFunction(fn?.name, url.searchParams.get('Qualifier')); break;
    case 'lambda.latest': request = builders.lambdaLatest(fn?.name); break;
    case 'lambda.alias': request = builders.lambdaAlias(fn?.name, url.pathname.split('/').at(-1)); break;
    case 'lambda.upload': { const value = parseJSON(body); request = builders.lambdaUpload(fn?.name, value.ImageUri?.split('@sha256:')[1], value.RevisionId); break; }
    case 'lambda.activate': { const value = parseJSON(body); request = builders.lambdaActivate(fn?.name, url.pathname.split('/').at(-1), value.FunctionVersion, value.RevisionId); break; }
    case 'lambda.create-alias': { const value = parseJSON(body); request = builders.lambdaCreateAlias(fn?.name, value.Name, value.FunctionVersion); break; }
    case 'report.deployments': request = builders.deploymentInventory(url.searchParams.get('sha'), Number(url.searchParams.get('page'))); break;
    case 'report.create-deployment': { const value = parseJSON(body); request = builders.deploymentCreate({ head: value.ref, compositionDigest: value.payload?.compositionDigest, eventDigest: value.payload?.eventDigest }); break; }
    case 'report.statuses': request = builders.reportStatuses(url.pathname.split('/').at(-2), Number(url.searchParams.get('page'))); break;
    case 'report.success': request = builders.reportSuccess(url.pathname.split('/').at(-2), parseJSON(body).description?.slice('Verified release event '.length)); break;
    default: throw Error('Unsupported custody provider operation');
  }
  check(digest(request) === digest(input), 'Custody reconstruction differs from exact production serialization'); return request;
}

export async function materializeProviderCapabilities(input, { policy, assets, resolve,bootstrap=null,nativeServing=null }) {
  const logical = await rehydrateProviderRequest(input, { policy, assets });
  const builders = requestBuilders(policy), url = new URL(input.url);
  if (input.operation === 'assets.upload') {
    const form = await new Response(Buffer.from(input.bodyBase64, 'base64'), { headers: { 'content-type': input.headers['content-type'] } }).formData();
    return builders.assetUpload(assets, [...form.keys()], await resolve(input.headers.authorization.slice(7), 'asset-upload'));
  }
  if (input.operation === 'worker.upload') {
    const form = await new Response(Buffer.from(input.bodyBase64, 'base64'), { headers: { 'content-type': input.headers['content-type'] } }).formData(), metadata = parseJSON(Buffer.from(form.get('metadata')));
    if (!metadata.assets?.jwt&&!bootstrap&&!nativeServing) return logical;
    if(metadata.assets?.jwt)metadata.assets.jwt = await resolve(metadata.assets.jwt, 'asset-completion');
    if(bootstrap){const worker=policy.workers.find(item=>url.pathname.includes(`/${item.name}/`));check(worker?.bootstrapMetadata==='native-qualification/v1'&&worker.name===policy.nativeQualification?.fixtureLifecycle?.bootstrapWorker?.name,'Exact isolated bootstrap metadata policy required');for(const [name,placeholder,value]of [['SHOP_NATIVE_BOOTSTRAP_AUTHORITY_DIGEST','$bootstrapAuthorityDigest',bootstrap.authorityDigest],['SHOP_NATIVE_BOOTSTRAP_OPERATION_ID','$operationId',bootstrap.operationId]]){const binding=metadata.bindings?.find(item=>item.name===name);check(binding?.type==='plain_text'&&binding.text===placeholder,'Only literal admitted bootstrap metadata may be materialized');binding.text=value;}}
    if(nativeServing){const worker=policy.workers.find(item=>url.pathname.includes(`/${item.name}/`));Object.assign(metadata,materializeServingMetadata(metadata,nativeServing,policy,worker?.name));}
    const modules = []; for (const [name, part] of form) if (name !== 'metadata') modules.push({ name, type: part.type, bytes: Buffer.from(await part.arrayBuffer()) });
    const expectedInventory = modules.map(part => ({ name: part.name, type: part.type, bytes: part.bytes.length, sha256: sha256(part.bytes), ...(part.name.endsWith('.map') ? { sourceMapDataSha256: sourceMapDataDigest(part.bytes) } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
  const worker = policy.workers.find(item => url.pathname.includes(`/${item.name}/`)); return builders.workerUpload(worker?.name, { entrypoint: metadata.main_module, metadata, modules, expectedInventory });
  }
  return logical;
}
