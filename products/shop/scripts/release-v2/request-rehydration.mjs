import { check, digest, parseJSON } from './data.mjs';
import { assertPolicy, exactFields, protocolByteLimit, requestBuilders, sourceMapDataDigest } from './provider-protocol-builders.mjs';
import { sha256 } from './data.mjs';

// The custody process receives data over HTTP. Rebuilding with the production
// builders restores their capability marker and checks the full serialization
// before a provider signer can receive it.
export async function rehydrateProviderRequest(input, { policy, assets = null }) {
  assertPolicy(policy); exactFields(input, ['schema', 'policyDigest', 'service', 'operation', 'method', 'url', 'headers', 'bodyBase64', 'bodySha256']);
  check(input.schema === 'shop.provider-request/v1' && input.policyDigest === digest(policy) && typeof input.bodyBase64 === 'string' && input.bodyBase64.length <= Math.ceil(protocolByteLimit / 3) * 4, 'Custody request schema/policy/size differs');
  const builders = requestBuilders(policy), url = new URL(input.url), body = Buffer.from(input.bodyBase64, 'base64');
  check(body.toString('base64') === input.bodyBase64 && sha256(body) === input.bodySha256 && body.length <= protocolByteLimit, 'Custody request bytes differ');
  const worker = policy.workers.find(item => url.pathname.includes(`/${item.name}/`)), fn = policy.functions.find(item => url.pathname === `/2015-03-31/functions/${item.name}` || url.pathname.startsWith(`/2015-03-31/functions/${item.name}/`));
  let request;
  switch (input.operation) {
    case 'store.get': request = builders.storeGet(url.pathname.slice(policy.store.prefix.length + 2)); break;
    case 'store.put': request = builders.storePut(url.pathname.slice(policy.store.prefix.length + 2), body, input.headers['if-match'] ?? null); break;
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
    case 'report.statuses': request = builders.reportStatuses(url.pathname.split('/').at(-2), Number(url.searchParams.get('page'))); break;
    case 'report.success': request = builders.reportSuccess(url.pathname.split('/').at(-2), parseJSON(body).description?.slice('Verified release event '.length)); break;
    default: throw Error('Unsupported custody provider operation');
  }
  check(digest(request) === digest(input), 'Custody reconstruction differs from exact production serialization'); return request;
}

export async function materializeProviderCapabilities(input, { policy, assets, resolve }) {
  const logical = await rehydrateProviderRequest(input, { policy, assets });
  const builders = requestBuilders(policy), url = new URL(input.url);
  if (input.operation === 'assets.upload') {
    const form = await new Response(Buffer.from(input.bodyBase64, 'base64'), { headers: { 'content-type': input.headers['content-type'] } }).formData();
    return builders.assetUpload(assets, [...form.keys()], await resolve(input.headers.authorization.slice(7), 'asset-upload'));
  }
  if (input.operation === 'worker.upload') {
    const form = await new Response(Buffer.from(input.bodyBase64, 'base64'), { headers: { 'content-type': input.headers['content-type'] } }).formData(), metadata = parseJSON(Buffer.from(form.get('metadata')));
    if (!metadata.assets?.jwt) return logical;
    metadata.assets.jwt = await resolve(metadata.assets.jwt, 'asset-completion');
    const modules = []; for (const [name, part] of form) if (name !== 'metadata') modules.push({ name, type: part.type, bytes: Buffer.from(await part.arrayBuffer()) });
    const expectedInventory = modules.map(part => ({ name: part.name, type: part.type, bytes: part.bytes.length, sha256: sha256(part.bytes), ...(part.name.endsWith('.map') ? { sourceMapDataSha256: sourceMapDataDigest(part.bytes) } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
    const worker = policy.workers.find(item => url.pathname.includes(`/${item.name}/`)); return builders.workerUpload(worker?.name, { entrypoint: metadata.main_module, metadata, modules, expectedInventory });
  }
  return logical;
}
