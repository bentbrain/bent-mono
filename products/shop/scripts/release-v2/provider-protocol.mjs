import { check, parseJSON, same, sha256, canonical } from './data.mjs';
import { assertPolicy, assertProtocolRequest, requestBuilders, protocolByteLimit, protocolPageLimit, protocolItemLimit, cloudflareVersion, numberedVersion, revision, sourceMapDataDigest } from './provider-protocol-builders.mjs';
import { authorizeRequest, requestDigest } from './signing.mjs';
export { protocolPolicy, requestBuilders, assetManifest } from './provider-protocol-builders.mjs';

export class ProtocolConflict extends Error { constructor(operation) { super(`Provider precondition conflict: ${operation}`); this.name = 'ProtocolConflict'; this.operation = operation; } }
export class UncertainWrite extends Error { constructor(request, cause) { super(`Provider acknowledgement is uncertain: ${request.operation}; reconcile by readback before any further write`, { cause }); this.name = 'UncertainWrite'; this.operation = request.operation; this.request = request; } }
export class ProtocolFailure extends Error { constructor(operation, status) { super(`Provider HTTP ${status}: ${operation}`); this.name = 'ProtocolFailure'; this.operation = operation; this.status = status; } }
export function responseBytes(response) {
  check(response && response.complete === true && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 && response.headers && typeof response.headers === 'object' && !Array.isArray(response.headers), 'Incomplete provider response');
  check(typeof response.bodyBase64 === 'string' && response.bodyBase64.length <= Math.ceil(protocolByteLimit / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(response.bodyBase64), 'Malformed or oversized provider response');
  const bytes = Buffer.from(response.bodyBase64, 'base64');
  check(bytes.length <= protocolByteLimit && bytes.toString('base64') === response.bodyBase64, 'Ambiguous provider response bytes');
  for (const [name, value] of Object.entries(response.headers)) { const values = Array.isArray(value) && name === 'set-cookie' ? value : [value]; check(/^[a-z0-9-]+$/.test(name) && values.length > 0 && values.length <= 16 && values.every(item => typeof item === 'string' && item.length <= 16384 && !/[\x00-\x1f\x7f]/.test(item)), 'Malformed response headers'); }
  if (response.headers['content-length'] !== undefined) check(/^(0|[1-9][0-9]*)$/.test(response.headers['content-length']) && Number(response.headers['content-length']) === bytes.length, 'Truncated provider response');
  return bytes;
}
const array = value => { check(Array.isArray(value) && value.length <= protocolItemLimit, 'Incomplete or oversized provider inventory'); return value; };
const cfResult = value => { check(value?.success === true && (!value.errors || Array.isArray(value.errors) && value.errors.length === 0) && value.result && typeof value.result === 'object', 'Cloudflare response failed'); return value.result; };
export function protocolClient({ policy, signer, trust, transport, now = Date.now }) {
  assertPolicy(policy); check(typeof transport === 'function', 'Explicit bounded provider transport required');
  const builders = requestBuilders(policy), mutations = new Set();
  const send = async request => {
    assertProtocolRequest(request, policy);
    const identity = requestDigest(request);
    check(request.method === 'GET' || !mutations.has(identity), 'Provider mutation replay refused; reconcile its durable intent by readback');
    const authorized = await authorizeRequest({ request, policy, signer, trust, now });
    // The durable controller journal owns cross-process recovery. This fence
    // also prevents a caller from retrying identical bytes in this client.
    if (request.method !== 'GET') {
      check(!mutations.has(identity), 'Provider mutation replay refused; concurrent identical request');
      mutations.add(identity);
    }
    let response;
    try { response = await transport(authorized); responseBytes(response); }
    catch (error) { if (request.method !== 'GET') throw new UncertainWrite(request, error); throw error; }
    // No retries, redirects, refresh, or mutation replay. A 409/412 leaves the
    // caller fenced until it reads and admits the current provider identity.
    if (response.status === 409 || response.status === 412) throw new ProtocolConflict(request.operation);
    if (response.status >= 500 && request.method !== 'GET') throw new UncertainWrite(request, new ProtocolFailure(request.operation, response.status));
    if (response.status < 200 || response.status >= 300) throw new ProtocolFailure(request.operation, response.status);
    return response;
  };
  const json = async request => {
    const response = await send(request);
    try { return parseJSON(responseBytes(response), 16 * 1024 * 1024); }
    catch (error) { if (request.method !== 'GET') throw new UncertainWrite(request, error); throw error; }
  };
  async function lambdaInventory(name) {
    const versions = [], markers = new Set(); let marker = null;
    for (let page = 0; page < protocolPageLimit; page++) {
      const response = await json(builders.lambdaVersions(name, marker));
      for (const item of array(response.Versions)) {
        check(item && typeof item === 'object' && typeof item.FunctionArn === 'string' && item.FunctionArn === `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:${item.Version}`, 'Lambda inventory identity differs');
        if (item.Version !== '$LATEST') numberedVersion(item.Version);
        check(!versions.some(previous => previous.Version === item.Version), 'Duplicate Lambda version'); versions.push(item);
      }
      check(versions.length <= protocolItemLimit, 'Lambda inventory exceeds bound');
      if (response.NextMarker === undefined || response.NextMarker === null || response.NextMarker === '') return { complete: true, versions };
      check(typeof response.NextMarker === 'string' && !markers.has(response.NextMarker) && response.Versions.length > 0, 'Truncated or looping Lambda inventory');
      markers.add(response.NextMarker); marker = response.NextMarker;
    }
    throw Error('Lambda inventory pagination exceeds bound');
  }
  async function workerInventory(name) {
    const versions = []; let expectedTotal = null;
    for (let page = 1; page <= protocolPageLimit; page++) {
      const response = await json(builders.workerVersions(name, page)), result = cfResult(response);
      const items = array(result.items), info = response.result_info;
      check(items.length <= 100, 'Cloudflare page exceeds requested bound');
      if (info !== undefined) {
        check(info && typeof info === 'object' && !Array.isArray(info) &&
          (info.page === undefined || info.page === page) && (info.per_page === undefined || info.per_page === 100) &&
          (info.count === undefined || info.count === items.length), 'Cloudflare pagination identity differs');
        if (info.total_count !== undefined) {
          check(Number.isSafeInteger(info.total_count) && info.total_count >= 0 && info.total_count <= protocolItemLimit, 'Invalid Cloudflare inventory total');
          if (expectedTotal === null) expectedTotal = info.total_count;
          check(expectedTotal === info.total_count, 'Cloudflare inventory changed during pagination');
        }
      }
      // Cloudflare's V4PagePagination advances until an empty page, including
      // when result_info has no total. A short page alone never ends discovery.
      if (items.length === 0) {
        check(expectedTotal === null || versions.length === expectedTotal, 'Cloudflare inventory was truncated');
        return { complete: true, versions };
      }
      for (const item of items) { cloudflareVersion(item.id); check(!versions.some(previous => previous.id === item.id), 'Duplicate Cloudflare version'); versions.push(item); }
      check(versions.length <= protocolItemLimit && (expectedTotal === null || versions.length <= expectedTotal), 'Cloudflare inventory exceeds declared bound');
      if (expectedTotal !== null && versions.length < expectedTotal) check(items.length === 100, 'Cloudflare inventory was truncated');
    }
    throw Error('Cloudflare inventory pagination exceeds bound');
  }
  async function workerActive(name) {
    const result = cfResult(await json(builders.workerDeployments(name))), deployments = array(result.deployments);
    check(deployments.length > 0, 'Worker has no active deployment');
    // Deployments are newest first. The newest VERSION is unrelated to the
    // active deployment and must never become an activation observation.
    const current = deployments[0]; check(current && Array.isArray(current.versions) && current.versions.length === 1 && current.versions[0].percentage === 100, 'Single complete Worker deployment required');
    return cloudflareVersion(current.versions[0].version_id);
  }
  async function lambdaActive(name, alias) {
    const response = await json(builders.lambdaAlias(name, alias));
    check(response.Name === alias && response.AliasArn === `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:${alias}` && (!response.RoutingConfig || same(response.RoutingConfig, { AdditionalVersionWeights: {} })), 'Lambda alias identity/routing differs');
    numberedVersion(response.FunctionVersion); revision(response.RevisionId); return response;
  }
  async function reportInventory(deploymentId) {
    const records = [];
    for (let page = 1; page <= protocolPageLimit; page++) {
      const response = await send(builders.reportStatuses(deploymentId, page)), items = array(parseJSON(responseBytes(response)));
      records.push(...items); check(records.length <= protocolItemLimit, 'Reporting inventory exceeds bound');
      const link = response.headers.link;
      if (!link) { check(items.length < 100, 'Full GitHub page lacks continuation evidence'); return { complete: true, records }; }
      const next = [...link.matchAll(/<([^>]+)>; rel="([a-z]+)"/g)].filter(match => match[2] === 'next');
      check(next.length <= 1, 'Ambiguous GitHub pagination');
      if (next.length === 0) return { complete: true, records };
      check(next[0][1] === builders.reportStatuses(deploymentId, page + 1).url && items.length > 0, 'GitHub continuation origin or resource differs');
    }
    throw Error('Reporting pagination exceeds bound');
  }
  return Object.freeze({ send, json, builders, policyEnvironment: policy.github.environment, lambdaInventory, workerInventory, workerActive, lambdaActive, reportInventory });
}

export async function verifyWorkerReadback(response, { entrypoint, expectedInventory }) {
  const bytes = responseBytes(response);
  check(response.status === 200 && response.headers['cf-entrypoint'] === entrypoint && response.headers['content-type']?.startsWith('multipart/form-data; boundary='), 'Complete Worker multipart readback required');
  const form = await new Response(bytes, { headers: { 'content-type': response.headers['content-type'] } }).formData(), inventory = [];
  for (const [name, value] of form) {
    check(typeof value !== 'string' && !inventory.some(part => part.name === name), 'Duplicate or nonbinary Worker readback part');
    const content = Buffer.from(await value.arrayBuffer());
    inventory.push({ name, type: value.type, bytes: content.length, sha256: sha256(content), ...(name.endsWith('.map') ? { sourceMapDataSha256: sourceMapDataDigest(content) } : {}) });
  }
  inventory.sort((a, b) => a.name.localeCompare(b.name));
  check(Array.isArray(expectedInventory) && inventory.length === expectedInventory.length && inventory.every((actual, index) => {
    const expected = expectedInventory[index];
    // Provider map JSON may reorder keys or whitespace. Every data field,
    // including extension fields, remains covered by the canonical data seal.
    return actual.name.endsWith('.map') ? actual.name === expected.name && actual.type === 'application/source-map' && expected.type === actual.type &&
      typeof expected.sourceMapDataSha256 === 'string' && actual.sourceMapDataSha256 === expected.sourceMapDataSha256 : same(actual, expected);
  }), 'Complete Worker module/map readback differs'); return inventory;
}

const lambdaBindingFields = Object.freeze(['Architectures', 'MemorySize', 'Timeout', 'Role', 'EphemeralStorage', 'Environment', 'ImageConfigResponse', 'DeadLetterConfig', 'VpcConfig', 'FileSystemConfigs', 'Layers', 'KMSKeyArn', 'CodeSigningConfigArn', 'LoggingConfig', 'TracingConfig', 'SnapStart', 'Runtime', 'Handler']);
export function lambdaBindingProjection(configuration) {
  check(configuration && typeof configuration === 'object' && !Array.isArray(configuration), 'Complete Lambda configuration required');
  return Object.fromEntries(lambdaBindingFields.map(field => [field, configuration[field] ?? null]));
}
export function assertLambdaBinding(binding, policy) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = value => typeof value === 'string' && value.length <= 16384;
  const integer = (minimum, maximum) => value => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  const list = test => value => Array.isArray(value) && value.length <= 4096 && value.every(test);
  const fields = (value, definitions, required = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => Object.hasOwn(definitions, key) && definitions[key](value[key]));
  const nullable = test => value => value === null || test(value);
  const strings = list(string);
  const definitions = {
    Architectures: value => Array.isArray(value) && value.length === 1 && ['x86_64', 'arm64'].includes(value[0]),
    MemorySize: integer(128, 10240), Timeout: integer(1, 900),
    Role: value => string(value) && new RegExp(`^arn:aws:iam::${policy.awsAccountId}:role/[A-Za-z0-9+=,.@_/-]+$`).test(value),
    EphemeralStorage: value => fields(value, { Size: integer(512, 10240) }, ['Size']),
    Environment: nullable(value => fields(value, { Variables: variables => object(variables) && Object.keys(variables).length <= 4096 && Object.entries(variables).every(([key, entry]) => string(key) && string(entry)) })),
    ImageConfigResponse: nullable(value => fields(value, { ImageConfig: config => fields(config, { EntryPoint: strings, Command: strings, WorkingDirectory: string }) })),
    DeadLetterConfig: nullable(value => fields(value, { TargetArn: string })),
    VpcConfig: nullable(value => fields(value, { SubnetIds: strings, SecurityGroupIds: strings, VpcId: string, Ipv6AllowedForDualStack: entry => typeof entry === 'boolean' })),
    FileSystemConfigs: nullable(list(value => fields(value, { Arn: string, LocalMountPath: string }, ['Arn', 'LocalMountPath']))),
    Layers: nullable(list(value => fields(value, { Arn: string, CodeSize: integer(0, Number.MAX_SAFE_INTEGER), SigningProfileVersionArn: string, SigningJobArn: string }, ['Arn']))),
    KMSKeyArn: nullable(string), CodeSigningConfigArn: nullable(string),
    LoggingConfig: nullable(value => fields(value, { LogFormat: string, ApplicationLogLevel: string, SystemLogLevel: string, LogGroup: string })),
    TracingConfig: nullable(value => fields(value, { Mode: entry => ['Active', 'PassThrough'].includes(entry) }, ['Mode'])),
    SnapStart: nullable(value => fields(value, { ApplyOn: entry => ['PublishedVersions', 'None'].includes(entry), OptimizationStatus: entry => ['On', 'Off'].includes(entry) })),
    Runtime: nullable(string), Handler: nullable(string),
  };
  check(object(binding) && same(Object.keys(binding).sort(), [...lambdaBindingFields].sort()) &&
    fields(binding, definitions, lambdaBindingFields), 'Complete qualified Lambda target binding contract required');
  return binding;
}
export function verifyLambdaQualified(response, { policy, name, version, imageDigest, expectedBinding }) {
  assertPolicy(policy); numberedVersion(version);
  check(typeof imageDigest === 'string' && /^[a-f0-9]{64}$/.test(imageDigest), 'Exact Lambda image digest required');
  const resource = policy.functions.find(item => item.name === name); check(resource, 'Lambda outside protected allowlist');
  const configuration = response?.Configuration, arn = `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}:${version}`;
  check(configuration?.FunctionName === name && configuration.FunctionArn === arn && configuration.Version === version && configuration.PackageType === 'Image' && configuration.State === 'Active' && configuration.LastUpdateStatus === 'Successful', 'Qualified active Lambda code identity differs');
  const imageUri = `${resource.imageRepository}@sha256:${imageDigest}`;
  check(response.Code?.ImageUri === imageUri && response.Code.ResolvedImageUri === imageUri, 'Qualified Lambda resolved image differs');
  assertLambdaBinding(expectedBinding, policy);
  check(same(lambdaBindingProjection(configuration), expectedBinding), 'Qualified Lambda target bindings differ');
  revision(configuration.RevisionId);
  return { functionArn: arn, version, imageDigest, bindingDigest: sha256(Buffer.from(canonical(expectedBinding))), revisionId: configuration.RevisionId };
}
export function verifyWorkerBindings(envelope, { version, bindings, runtime }) {
  cloudflareVersion(version); const response = cfResult(envelope);
  const named = values => {
    check(Array.isArray(values) && values.length <= 128, 'Complete bounded Worker bindings required');
    const names = values.map(value => {
      check(value && typeof value === 'object' && !Array.isArray(value) && typeof value.name === 'string' && value.name.length > 0 &&
        value.name.length <= 128 && value.name.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value.name), 'Worker binding identity differs');
      return value.name;
    });
    check(new Set(names).size === names.length, 'Duplicate Worker binding identity');
    return [...values].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  };
  const expected = named(bindings);
  check(response.id === version && response.resources && same(named(response.resources.bindings), expected) && same(response.resources.script_runtime, runtime), 'Worker version or target bindings differ');
  return { version, bindingsDigest: sha256(Buffer.from(canonical({ bindings: expected, runtime }))) };
}
