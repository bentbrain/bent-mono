import { extname } from 'node:path';
import { check, canonical, digest, pathName, sha256, same, parseJSON } from './data.mjs';

export const protocolByteLimit = 256 * 1024 * 1024;
export const protocolPageLimit = 64;
export const protocolItemLimit = 4096;
const issuedPolicies = new WeakSet(), issuedRequests = new WeakSet();
export const exactFields = (value, fields, reason = 'Unexpected protocol fields') => check(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...fields].sort()), reason);
const bounded = (value, pattern, reason) => { check(typeof value === 'string' && pattern.test(value), reason); return value; };
export const numberedVersion = value => bounded(value, /^[1-9][0-9]{0,15}$/, 'A qualified numbered Lambda version is required');
export const cloudflareVersion = value => bounded(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, 'Malformed Cloudflare version');
export const revision = value => bounded(value, /^[A-Za-z0-9_-]{1,128}$/, 'Exact provider RevisionId required');
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const list = (items, test) => { check(Array.isArray(items) && items.length > 0 && items.length <= 32 && new Set(items.map(canonical)).size === items.length, 'Bounded unique protected resource list required'); items.forEach(test); };

// The caller must obtain these identities from protected admission. This parser
// validates a supplied contract; it does not discover credentials or grant trust.
export function protocolPolicy(input) {
  const value = structuredClone(input);
  exactFields(value, ['schema', 'awsAccountId', 'region', 'cloudflareAccountId', 'workers', 'functions', 'store', 'github']);
  check(value.schema === 'shop.provider-protocol-policy/v1' && value.region === 'ap-southeast-2', 'Unsupported provider policy');
  bounded(value.awsAccountId, /^[0-9]{12}$/, 'Exact AWS account required');
  bounded(value.cloudflareAccountId, /^[a-f0-9]{32}$/, 'Exact Cloudflare account required');
  list(value.workers, item => {
    exactFields(item, ['name', 'metadataDigest', ...(Object.hasOwn(item, 'versionContentApi') ? ['versionContentApi'] : [])]);
    check(item.versionContentApi === undefined || item.versionContentApi === 'workers-beta/v1', 'Unsupported immutable Worker content API');
    bounded(item.name, /^[a-z][a-z0-9-]{0,62}$/, 'Exact Worker name required');
    bounded(item.metadataDigest, /^[a-f0-9]{64}$/, 'Protected Worker metadata digest required');
  });
  check(new Set(value.workers.map(item => item.name)).size === value.workers.length, 'Duplicate Worker name');
  list(value.functions, item => {
    exactFields(item, ['name', 'aliases', 'imageRepository']);
    bounded(item.name, /^[A-Za-z0-9_-]{1,64}$/, 'Exact Lambda name required');
    list(item.aliases, alias => bounded(alias, /^(?![0-9]+$)[A-Za-z0-9_-]{1,128}$/, 'Exact Lambda alias required'));
    check(item.imageRepository.startsWith(`${value.awsAccountId}.dkr.ecr.${value.region}.amazonaws.com/`) && /^[0-9]{12}\.dkr\.ecr\.ap-southeast-2\.amazonaws\.com\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(item.imageRepository), 'Exact same-account ECR repository required');
  });
  check(new Set(value.functions.map(item => item.name)).size === value.functions.length, 'Duplicate Lambda name');
  exactFields(value.store, ['bucket', 'prefix', 'kmsKeyArn']);
  bounded(value.store.bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'Exact S3 bucket required');
  bounded(value.store.prefix, /^[A-Za-z0-9][A-Za-z0-9_/-]{0,255}$/, 'Exact URL-safe S3 prefix required'); pathName(value.store.prefix);
  check(value.store.kmsKeyArn.startsWith(`arn:aws:kms:${value.region}:${value.awsAccountId}:key/`) && /^arn:aws:kms:ap-southeast-2:[0-9]{12}:key\/[a-f0-9-]{36}$/.test(value.store.kmsKeyArn), 'Exact same-account KMS key required');
  exactFields(value.github, ['repository', 'environment', 'deploymentIds']);
  list(value.github.deploymentIds, id => bounded(id, /^[1-9][0-9]{0,19}$/, 'Exact protected reporting deployment ID required'));
  check(value.github.repository === 'bentbrain/bent-mono', 'Protected repository differs');
  bounded(value.github.environment, /^[A-Za-z][A-Za-z0-9 -]{0,63}$/, 'Exact reporting environment required');
  deepFreeze(value); issuedPolicies.add(value); return value;
}
export function assertPolicy(policy) { check(issuedPolicies.has(policy), 'Validated protected protocol policy required'); }
export function assertProtocolRequest(request, policy) {
  assertPolicy(policy);
  check(issuedRequests.has(request) && request.policyDigest === digest(policy), 'Request must come from this protected policy builder');
  check(sha256(Buffer.from(request.bodyBase64, 'base64')) === request.bodySha256, 'Serialized request changed');
  return request;
}
function wire(policy, service, operation, method, url, body = Buffer.alloc(0), headers = {}) {
  assertPolicy(policy);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(canonical(body));
  check(bytes.length <= protocolByteLimit, 'Provider request exceeds byte bound');
  const request = deepFreeze({ schema: 'shop.provider-request/v1', policyDigest: digest(policy), service, operation, method, url,
    headers: { host: new URL(url).host, 'content-length': String(bytes.length), ...headers }, bodyBase64: bytes.toString('base64'), bodySha256: sha256(bytes) });
  issuedRequests.add(request); return request;
}
export function multipart(parts) {
  check(Array.isArray(parts) && parts.length > 0 && parts.length <= protocolItemLimit && new Set(parts.map(part => part.name)).size === parts.length, 'Complete unique multipart parts required');
  const boundary = `shop-${digest(parts.map(part => ({ name: part.name, filename: part.filename ?? null, type: part.type, sha256: sha256(part.bytes) })))}`;
  const chunks = [];
  for (const part of parts) {
    bounded(part.name, /^[A-Za-z0-9_./-]{1,512}$/, 'Unsafe multipart name'); pathName(part.name);
    bounded(part.type, /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/, 'Unsupported multipart content type');
    check(Buffer.isBuffer(part.bytes) && !part.bytes.includes(Buffer.from(`\r\n--${boundary}`)), 'Unsafe multipart bytes');
    if (part.filename !== undefined) check(part.filename === part.name, 'Multipart filename must match complete part name');
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\nContent-Type: ${part.type}\r\n\r\n`), part.bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks); check(body.length <= protocolByteLimit, 'Multipart exceeds byte bound');
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
const supportedTypes = new Set(['application/javascript+module', 'application/javascript', 'application/wasm', 'text/plain', 'application/octet-stream', 'application/json', 'application/source-map']);
export function sourceMapDataDigest(bytes) {
  const map = parseJSON(bytes, 16 * 1024 * 1024);
  check(map.version === 3 && Array.isArray(map.sources) && map.sources.every(source => typeof source === 'string') && Array.isArray(map.names) && map.names.every(name => typeof name === 'string') && typeof map.mappings === 'string' &&
    !Object.hasOwn(map, 'sections') && (map.file === undefined || typeof map.file === 'string') &&
    (map.sourcesContent === undefined || Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length && map.sourcesContent.every(source => source === null || typeof source === 'string')), 'Complete supported source map data required');
  return digest(map);
}
function workerParts({ entrypoint, metadata, modules, expectedInventory }) {
  pathName(entrypoint);
  check(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.main_module === entrypoint && !Object.hasOwn(metadata, 'body_part'), 'Exact module metadata required');
  check(Array.isArray(modules) && modules.length > 0 && modules.length <= protocolItemLimit && modules.some(part => part.name === entrypoint), 'Complete Worker module inventory required');
  check(new Set(modules.map(part => part.name)).size === modules.length && !modules.some(part => part.name === 'metadata'), 'Duplicate or reserved Worker part');
  parseJSON(Buffer.from(canonical(metadata)), 16 * 1024 * 1024);
  const inventory = modules.map(part => {
    exactFields(part, ['name', 'type', 'bytes']); pathName(part.name);
    check(supportedTypes.has(part.type) && Buffer.isBuffer(part.bytes), 'Unsupported Worker module type');
    let sourceMapDataSha256;
    if (part.name.endsWith('.map')) {
      check(part.type === 'application/source-map', 'Source maps require application/source-map content type');
      const codeName = part.name.slice(0, -4), code = modules.find(candidate => candidate.name === codeName);
      check(code, 'Source map requires its matching module');
      check(!/(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s*|\bimport\s*)["'`]([^"'`]*\.map(?:[?#][^"'`]*)?)["'`]/.test(code.bytes.toString()), 'Executable source-map import is forbidden');
      sourceMapDataSha256 = sourceMapDataDigest(part.bytes);
    }
    return { name: part.name, type: part.type, bytes: part.bytes.length, sha256: sha256(part.bytes), ...(sourceMapDataSha256 ? { sourceMapDataSha256 } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  check(same(inventory, expectedInventory), 'Worker parts differ from the sealed complete inventory');
  return { inventory, multipart: multipart([{ name: 'metadata', type: 'application/json', bytes: Buffer.from(canonical(metadata)) }, ...modules.map(part => ({ ...part, filename: part.name }))]) };
}
export function assetManifest(assets) {
  check(Array.isArray(assets) && assets.length <= protocolItemLimit && new Set(assets.map(asset => asset.path)).size === assets.length, 'Complete unique asset inventory required');
  const manifest = {}, inventory = [];
  for (const asset of assets) {
    exactFields(asset, ['path', 'type', 'bytes']); pathName(asset.path);
    check(Buffer.isBuffer(asset.bytes) && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(asset.type), 'Invalid asset bytes/type');
    const extension = extname(asset.path).slice(1);
    const hash = sha256(asset.bytes.toString('base64') + extension).slice(0, 32);
    const previous = inventory.find(item => item.hash === hash);
    check(!previous || previous.type === asset.type && previous.sha256 === sha256(asset.bytes), 'Conflicting asset hash or content type');
    manifest[`/${asset.path}`] = { hash, size: asset.bytes.length };
    inventory.push({ path: asset.path, type: asset.type, bytes: asset.bytes.length, sha256: sha256(asset.bytes), hash });
  }
  return { manifest, inventory: inventory.sort((a, b) => a.path.localeCompare(b.path)) };
}
export function requestBuilders(policy) {
  assertPolicy(policy);
  const cfOrigin = `https://api.cloudflare.com/client/v4/accounts/${policy.cloudflareAccountId}`;
  const lambdaOrigin = `https://lambda.${policy.region}.amazonaws.com`;
  const s3Origin = `https://${policy.store.bucket}.s3.${policy.region}.amazonaws.com`;
  const worker = name => { check(policy.workers.some(item => item.name === name), 'Worker outside protected allowlist'); return `${cfOrigin}/workers/scripts/${name}`; };
  const fn = name => { check(policy.functions.some(item => item.name === name), 'Lambda outside protected allowlist'); return `${lambdaOrigin}/2015-03-31/functions/${name}`; };
  const alias = (name, value) => { check(policy.functions.find(item => item.name === name)?.aliases.includes(value), 'Alias outside protected allowlist'); return `${fn(name)}/aliases/${value}`; };
  const json = { 'content-type': 'application/json' };
  const page = value => { check(Number.isInteger(value) && value > 0 && value <= protocolPageLimit, 'Provider pagination exceeds bound'); return value; };
  const marker = value => { bounded(value, /^[A-Za-z0-9_+=/.-]{1,1024}$/, 'Malformed pagination marker'); return encodeURIComponent(value); };
  const storeKey = key => { pathName(key); check(key === 'head.json' || /^events\/[a-f0-9]{64}\.json$/.test(key), 'Store key outside protected journal'); return `${s3Origin}/${policy.store.prefix}/${key}`; };
  const deployment = id => { check(policy.github.deploymentIds.includes(id), 'Reporting deployment outside protected allowlist'); return id; };
  return Object.freeze({
    workerVersions: (name, currentPage = 1) => wire(policy, 'cloudflare', 'worker.versions', 'GET', `${worker(name)}/versions?page=${page(currentPage)}&per_page=100`),
    workerVersionContent: (name, id) => { check(policy.workers.find(item => item.name === name)?.versionContentApi === 'workers-beta/v1', 'Admitted workers-beta/v1 content API required'); return wire(policy, 'cloudflare', 'worker.version-content', 'GET', `${cfOrigin}/workers/workers/${name}/versions/${cloudflareVersion(id)}?include=modules,sourcemaps`); },
    workerVersion: (name, id) => wire(policy, 'cloudflare', 'worker.version', 'GET', `${worker(name)}/versions/${cloudflareVersion(id)}`),
    workerDeployments: name => wire(policy, 'cloudflare', 'worker.deployments', 'GET', `${worker(name)}/deployments`),
    workerSettings: name => wire(policy, 'cloudflare', 'worker.settings', 'GET', `${worker(name)}/settings`),
    workerContent: name => wire(policy, 'cloudflare', 'worker.content', 'GET', `${worker(name)}/content/v2`),
    workerUpload: (name, upload) => {
      const protectedWorker = policy.workers.find(item => item.name === name); check(protectedWorker, 'Worker outside protected allowlist');
      const metadata = structuredClone(upload.metadata);
      // Session completion JWTs are short-lived capabilities returned by the
      // provider. All other metadata remains bound to protected admission.
      if (metadata.assets && Object.hasOwn(metadata.assets, 'jwt')) {
        bounded(metadata.assets.jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Exact completion JWT required');
        delete metadata.assets.jwt;
      }
      check(digest(metadata) === protectedWorker.metadataDigest, 'Worker bindings/metadata differ from protected policy');
      const parts = workerParts(upload); return wire(policy, 'cloudflare', 'worker.upload', 'POST', `${worker(name)}/versions`, parts.multipart.body, { 'content-type': parts.multipart.contentType }); },
    workerActivate: (name, id) => wire(policy, 'cloudflare', 'worker.activate', 'POST', `${worker(name)}/deployments`, { strategy: 'percentage', versions: [{ version_id: cloudflareVersion(id), percentage: 100 }] }, json),
    assetSession: (name, assets) => wire(policy, 'cloudflare', 'assets.session', 'POST', `${worker(name)}/assets-upload-session`, { manifest: assetManifest(assets).manifest }, json),
    assetUpload: (assets, hashes, jwt) => {
      bounded(jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Exact asset session JWT required');
      const inventory = assetManifest(assets).inventory;
      check(Array.isArray(hashes) && hashes.length > 0 && hashes.length <= protocolItemLimit && new Set(hashes).size === hashes.length, 'Unique asset upload bucket required');
      const parts = hashes.map(hash => { const item = inventory.find(asset => asset.hash === hash); check(item, 'Asset upload hash outside complete manifest'); const asset = assets.find(candidate => candidate.path === item.path); return { name: hash, filename: hash, type: item.type, bytes: Buffer.from(asset.bytes.toString('base64')) }; });
      const encoded = multipart(parts);
      return wire(policy, 'cloudflare', 'assets.upload', 'POST', `${cfOrigin}/workers/assets/upload?base64=true`, encoded.body, { 'content-type': encoded.contentType, authorization: `Bearer ${jwt}` });
    },
    lambdaVersions: (name, next = null) => wire(policy, 'lambda', 'lambda.versions', 'GET', `${fn(name)}/versions?MaxItems=100${next === null ? '' : `&Marker=${marker(next)}`}`),
    lambdaFunction: (name, version) => wire(policy, 'lambda', 'lambda.function', 'GET', `${fn(name)}?Qualifier=${numberedVersion(version)}`),
    lambdaLatest: name => wire(policy, 'lambda', 'lambda.latest', 'GET', fn(name)),
    lambdaAlias: (name, value) => wire(policy, 'lambda', 'lambda.alias', 'GET', alias(name, value)),
    lambdaUpload: (name, imageDigest, revisionId) => {
      bounded(imageDigest, /^[a-f0-9]{64}$/, 'Immutable image digest required');
      const repository = policy.functions.find(item => item.name === name)?.imageRepository; check(repository, 'Lambda outside protected allowlist');
      return wire(policy, 'lambda', 'lambda.upload', 'PUT', `${fn(name)}/code`, { ImageUri: `${repository}@sha256:${imageDigest}`, Publish: true, RevisionId: revision(revisionId) }, json);
    },
    lambdaActivate: (name, value, version, revisionId) => wire(policy, 'lambda', 'lambda.activate', 'PUT', alias(name, value), { FunctionVersion: numberedVersion(version), RevisionId: revision(revisionId), RoutingConfig: { AdditionalVersionWeights: {} } }, json),
    storeGet: key => wire(policy, 's3', 'store.get', 'GET', storeKey(key), Buffer.alloc(0), { 'x-amz-expected-bucket-owner': policy.awsAccountId }),
    storePut: (key, bytes, etag) => {
      check(Buffer.isBuffer(bytes), 'Exact store bytes required');
      check(etag === null || typeof etag === 'string' && /^"[A-Za-z0-9-]{1,128}"$/.test(etag), 'Exact store ETag precondition required');
      check(!key.startsWith('events/') || etag === null, 'Events require create-only writes');
      return wire(policy, 's3', 'store.put', 'PUT', storeKey(key), bytes, { ...json, 'x-amz-expected-bucket-owner': policy.awsAccountId,
        'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': policy.store.kmsKeyArn,
        'x-amz-checksum-sha256': Buffer.from(sha256(bytes), 'hex').toString('base64'), ...(etag === null ? { 'if-none-match': '*' } : { 'if-match': etag }) });
    },
    reportStatuses: (deploymentId, currentPage = 1) => wire(policy, 'github', 'report.statuses', 'GET', `https://api.github.com/repos/${policy.github.repository}/deployments/${deployment(deploymentId)}/statuses?per_page=100&page=${page(currentPage)}`, Buffer.alloc(0), { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }),
    reportSuccess: (deploymentId, eventDigest) => {
      bounded(eventDigest, /^[a-f0-9]{64}$/, 'Verified durable event digest required');
      return wire(policy, 'github', 'report.success', 'POST', `https://api.github.com/repos/${policy.github.repository}/deployments/${deployment(deploymentId)}/statuses`, { state: 'success', environment: policy.github.environment, description: `Verified release event ${eventDigest}`, auto_inactive: false }, { ...json, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
    }
  });
}
