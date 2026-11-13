import { request as httpsRequest } from 'node:https';
import { check, digest, sha256 } from './data.mjs';
import { assertPolicy, protocolByteLimit } from './provider-protocol-builders.mjs';

export function validateDispatchTarget(request, policy) {
  assertPolicy(policy);
  check(request && request.policyDigest === digest(policy) && ['GET', 'PUT', 'POST'].includes(request.method), 'Dispatch policy or method differs');
  const url = new URL(request.url);
  check(url.protocol === 'https:' && url.href === request.url && !url.username && !url.password && !url.hash && !url.port && url.host === request.headers?.host, 'Exact protected HTTPS origin required');
  const root = `/client/v4/accounts/${policy.cloudflareAccountId}/workers`, paths = [];
  if (request.service === 'cloudflare') {
    check(url.origin === 'https://api.cloudflare.com', 'Cloudflare origin differs');
    for (const worker of policy.workers) paths.push(`${root}/scripts/${worker.name}`);
    const oldPath = paths.some(path => url.pathname === `${path}/versions` || new RegExp(`^${path}/versions/[a-f0-9-]{36}$`).test(url.pathname) || ['deployments', 'settings', 'content/v2', 'assets-upload-session'].some(suffix => url.pathname === `${path}/${suffix}`));
    const versionContent = policy.workers.some(worker => new RegExp(`^${root}/workers/${worker.name}/versions/[a-f0-9-]{36}$`).test(url.pathname));
    check(oldPath || versionContent || url.pathname === `${root}/assets/upload`, 'Cloudflare resource differs');
    check([...url.searchParams.keys()].every(key => ['page', 'per_page', 'base64', 'include'].includes(key)), 'Cloudflare query differs');
  } else if (request.service === 'lambda') {
    check(url.origin === `https://lambda.${policy.region}.amazonaws.com`, 'Lambda origin differs');
    check(policy.functions.some(fn => {
      const path = `/2015-03-31/functions/${fn.name}`;
      return [path, `${path}/code`, `${path}/versions`, `${path}/aliases`].includes(url.pathname) || fn.aliases.some(alias => url.pathname === `${path}/aliases/${alias}`);
    }) && [...url.searchParams.keys()].every(key => ['Qualifier', 'MaxItems', 'Marker'].includes(key)), 'Lambda resource or query differs');
  } else if (request.service === 's3') {
    check(url.origin === `https://${policy.store.bucket}.s3.${policy.region}.amazonaws.com` &&
      (url.pathname === `/${policy.store.prefix}/head.json` || new RegExp(`^/${policy.store.prefix}/events/[a-f0-9]{64}\\.json$`).test(url.pathname)) && !url.search, 'S3 resource differs');
  } else if (request.service === 'github') {
    check(url.origin === 'https://api.github.com' && policy.github.deploymentIds.some(id => url.pathname === `/repos/${policy.github.repository}/deployments/${id}/statuses`) &&
      [...url.searchParams.keys()].every(key => ['page', 'per_page'].includes(key)), 'GitHub reporting resource differs');
  } else throw Error('Unsupported dispatch service');
  check(new Set([...url.searchParams.keys()]).size === [...url.searchParams.keys()].length, 'Duplicate dispatch query');
  const query = Object.fromEntries(url.searchParams), numericPage = /^[1-9][0-9]{0,2}$/.test(query.page ?? '') && Number(query.page) <= 64;
  const operationShapes = {
    'worker.versions': request.method === 'GET' && url.pathname.endsWith('/versions') && numericPage && query.per_page === '100' && Object.keys(query).length === 2,
    'worker.version': request.method === 'GET' && /\/scripts\/[^/]+\/versions\/[a-f0-9-]{36}$/.test(url.pathname) && !url.search,
    'worker.version-content': request.method === 'GET' && /\/workers\/workers\/[^/]+\/versions\/[a-f0-9-]{36}$/.test(url.pathname) && query.include === 'modules,sourcemaps' && Object.keys(query).length === 1 && policy.workers.some(worker => worker.versionContentApi === 'workers-beta/v1' && url.pathname.includes(`/${worker.name}/`)),
    'worker.deployments': request.method === 'GET' && url.pathname.endsWith('/deployments') && !url.search,
    'worker.settings': request.method === 'GET' && url.pathname.endsWith('/settings') && !url.search,
    'worker.content': request.method === 'GET' && url.pathname.endsWith('/content/v2') && !url.search,
    'worker.upload': request.method === 'POST' && url.pathname.endsWith('/versions') && !url.search,
    'worker.activate': request.method === 'POST' && url.pathname.endsWith('/deployments') && !url.search,
    'assets.session': request.method === 'POST' && url.pathname.endsWith('/assets-upload-session') && !url.search,
    'assets.upload': request.method === 'POST' && url.pathname.endsWith('/workers/assets/upload') && query.base64 === 'true' && Object.keys(query).length === 1,
    'lambda.versions': request.method === 'GET' && url.pathname.endsWith('/versions') && query.MaxItems === '100' && Object.keys(query).every(key => ['MaxItems', 'Marker'].includes(key)) && (query.Marker === undefined || /^[A-Za-z0-9_+=/.-]{1,1024}$/.test(query.Marker)),
    'lambda.function': request.method === 'GET' && policy.functions.some(fn => url.pathname === `/2015-03-31/functions/${fn.name}`) && /^[1-9][0-9]{0,15}$/.test(query.Qualifier ?? '') && Object.keys(query).length === 1,
    'lambda.latest': request.method === 'GET' && !url.search && policy.functions.some(fn => url.pathname === `/2015-03-31/functions/${fn.name}`),
    'lambda.alias': request.method === 'GET' && url.pathname.includes('/aliases/') && !url.search,
    'lambda.upload': request.method === 'PUT' && url.pathname.endsWith('/code') && !url.search,
    'lambda.activate': request.method === 'PUT' && url.pathname.includes('/aliases/') && !url.search,
    'lambda.create-alias': request.method === 'POST' && url.pathname.endsWith('/aliases') && !url.search,
    'store.get': request.method === 'GET' && !url.search,
    'store.put': request.method === 'PUT' && !url.search && (request.headers['if-none-match'] === '*' || /^"[A-Za-z0-9-]{1,128}"$/.test(request.headers['if-match'] ?? '')),
    'report.statuses': request.method === 'GET' && numericPage && query.per_page === '100' && Object.keys(query).length === 2,
    'report.success': request.method === 'POST' && !url.search
  };
  check(operationShapes[request.operation] === true && request.operation.startsWith(request.service === 'cloudflare' ? request.operation.startsWith('assets.') ? 'assets.' : 'worker.' : request.service === 's3' ? 'store.' : request.service === 'github' ? 'report.' : 'lambda.'), 'Dispatch operation, target or query differs');
  const bytes = Buffer.from(request.bodyBase64, 'base64');
  check(bytes.length <= protocolByteLimit && bytes.toString('base64') === request.bodyBase64 && sha256(bytes) === request.bodySha256 && request.headers['content-length'] === String(bytes.length), 'Dispatch serialized bytes differ');
  check(typeof request.authorizationDigest === 'string' && /^[a-f0-9]{64}$/.test(request.authorizationDigest) && typeof request.headers.authorization === 'string', 'Protected provider authorization required');
  check(Object.keys(request.headers).length <= 32, 'Dispatch header bound exceeded');
  for (const [name, value] of Object.entries(request.headers)) check(/^[a-z0-9-]+$/.test(name) && !['connection', 'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'upgrade', 'expect'].includes(name) && typeof value === 'string' && value.length <= 16384 && !/[\x00-\x1f\x7f]/.test(value), 'Invalid dispatch header');
  return { url, bytes };
}

// Credentials arrive only from the admitted custody broker. Native HTTPS uses
// the fixed provider hostname, ordinary certificate validation and one socket.
// Proxy settings, redirects, SDK credential chains and automatic retries have
// no role in this transport.
export function createHttpsTransport({ policy, timeoutMs = 30000, maximumResponseBytes = protocolByteLimit, networkRequest = httpsRequest }) {
  assertPolicy(policy); check(typeof networkRequest === 'function', 'Explicit HTTPS network boundary required');
  check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000 && Number.isInteger(maximumResponseBytes) && maximumResponseBytes > 0 && maximumResponseBytes <= protocolByteLimit, 'Bounded HTTPS transport limits required');
  return async request => {
    const { url, bytes } = validateDispatchTarget(request, policy);
    return new Promise((accept, reject) => {
      const operation = networkRequest({ protocol: 'https:', hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: request.method,
        headers: request.headers, agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, response => {
        if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300) {
          if (response.statusCode >= 300 && response.statusCode < 400) { reject(Error('Provider redirects are forbidden')); response.destroy(); operation.destroy(); return; }
        }
        const chunks = []; let length = 0;
        response.on('data', chunk => { length += chunk.length; if (length > maximumResponseBytes) { reject(Error('HTTPS response exceeds bound')); response.destroy(); operation.destroy(); } else chunks.push(chunk); });
        response.on('aborted', () => reject(Error('HTTPS response was truncated'))); response.on('error', reject);
        response.on('end', () => {
          if (!response.complete) { reject(Error('HTTPS response framing is incomplete')); return; }
          const body = Buffer.concat(chunks), headers = {};
          const seen = new Set();
          for (let at = 0; at < response.rawHeaders.length; at += 2) { const name = response.rawHeaders[at].toLowerCase(); if (seen.has(name) && name !== 'set-cookie') { reject(Error('Duplicate provider response header')); return; } seen.add(name); }
          for (const [name, value] of Object.entries(response.headers)) {
            if (!(typeof value === 'string' || name === 'set-cookie' && Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(item => typeof item === 'string' && item.length <= 16384))) { reject(Error('Ambiguous provider response header')); return; } headers[name] = value;
          }
          if (headers['content-length'] !== undefined && (!/^(0|[1-9][0-9]*)$/.test(headers['content-length']) || Number(headers['content-length']) !== body.length)) { reject(Error('HTTPS content length differs')); return; }
          accept({ status: response.statusCode, complete: true, headers, bodyBase64: body.toString('base64') });
        });
      });
      const deadline = setTimeout(() => { reject(Error('HTTPS provider deadline exceeded')); operation.destroy(); }, timeoutMs);
      operation.once('close', () => clearTimeout(deadline)); operation.once('error', reject); operation.end(bytes);
    });
  };
}
