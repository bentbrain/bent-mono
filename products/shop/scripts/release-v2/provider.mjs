import { check, canonical, parseJSON, same, digest } from './data.mjs';
import { fixtureTransportByteLimit } from './artifact-transport.mjs';
import { request as httpRequest } from 'node:http';

export function fixtureEnvironment(env) {
  const prohibited = Object.keys(env).filter(key => /^(AWS_|SHOP_PROTECTED_CONFIG|CLOUDFLARE_|CF_API_|VERCEL_TOKEN$|GH_TOKEN$|GITHUB_TOKEN$|SHOPIFY_|PRINTIFY_|STRIPE_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$|NODE_OPTIONS$|NODE_USE_ENV_PROXY$)/i.test(key) && env[key]);
  check(prohibited.length === 0, 'Live credential configuration is forbidden in fixture mode');
}
export function loopbackOrigin(value) {
  check(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value), 'Only explicit IPv4 loopback HTTP simulators are supported');
  const url = new URL(value);
  check(Number(url.port) > 0 && Number(url.port) <= 65535 && url.origin === value, 'Invalid loopback origin');
  return value;
}
const keys = (value, expected) => check(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...expected].sort().join(','), 'Unexpected provider response fields');
const hash = value => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Malformed provider digest');
function version(value) {
  keys(value, ['component', 'artifactDigest', 'configDigest', 'version']);
  check(typeof value.component === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.component) && typeof value.version === 'string' && /^v-[a-f0-9]{64}$/.test(value.version), 'Malformed provider version');
  hash(value.artifactDigest); hash(value.configDigest);
  check(value.version === `v-${value.artifactDigest}` || value.version === `v-${digest({ artifactDigest: value.artifactDigest, configDigest: value.configDigest })}`, 'Fixture immutable version digest differs');
  return value;
}
function inventory(value) {
  keys(value, ['complete', 'active', 'versions', 'jobs']);
  check(value.complete === true && Array.isArray(value.active) && Array.isArray(value.versions) && Array.isArray(value.jobs) &&
    value.active.length <= 32 && value.versions.length <= 4096 && value.jobs.length <= 4096, 'Incomplete or oversized provider inventory');
  value.active.forEach(version); value.versions.forEach(version);
  check(new Set(value.active.map(item => item.component)).size === value.active.length &&
    new Set(value.versions.map(item => `${item.component}/${item.version}`)).size === value.versions.length, 'Conflicting provider version identities');
  check(value.active.every(active => value.versions.some(candidate => same(active, candidate))), 'Active version is missing from complete inventory');
  return value;
}
export function client(origin) {
  loopbackOrigin(origin);
  const port = new URL(origin).port;
  const request = async (path, body) => {
    check(/^\/(inventory|runtime|operations|stage|activate|reports)(\/[a-f0-9-]+)?$/.test(path) || /^\/content\/[a-z][a-z0-9-]{0,63}\/v-[a-f0-9]{64}$/.test(path), 'Unsupported fixture endpoint');
    const maximumBytes = path.startsWith('/content/') ? fixtureTransportByteLimit : 1024 * 1024;
    const wire = body ? Buffer.from(canonical(body)) : null;
    if (wire) check(wire.byteLength <= fixtureTransportByteLimit, 'Fixture request exceeds byte bound');
    const bytes = await new Promise((accept, reject) => {
      // Native HTTP opens one literal loopback socket. Proxy environment,
      // redirects, DNS and provider SDK credential chains cannot change it.
      const operation = httpRequest({ hostname: '127.0.0.1', port, path, method: wire ? 'POST' : 'GET', agent: false,
        headers: { 'content-type': 'application/json', ...(wire ? { 'content-length': wire.byteLength } : {}) } }, response => {
        const chunks = []; let length = 0;
        if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300) {
          reject(Error(`Fixture HTTP ${response.statusCode}`)); response.destroy(); operation.destroy(); return;
        }
        response.on('data', chunk => {
          length += chunk.length;
          if (length > maximumBytes) { reject(Error('Provider response exceeds byte bound')); response.destroy(); operation.destroy(); }
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => reject(Error('Fixture HTTP response was truncated')));
        response.on('end', () => accept(Buffer.concat(chunks)));
      });
      const timeout = setTimeout(() => { reject(Error('Fixture HTTP deadline exceeded')); operation.destroy(); }, 3000);
      operation.on('close', () => clearTimeout(timeout)); operation.on('error', reject);
      operation.end(wire);
    });
    return parseJSON(bytes, maximumBytes);
  };
  return {
    inventory: async () => inventory(await request('/inventory')),
    content: (component, version) => request(`/content/${component}/${version}`),
    runtime: async () => { const result = await request('/runtime'); keys(result, ['complete', 'active']); check(result.complete === true && Array.isArray(result.active), 'Incomplete runtime readback'); result.active.forEach(version); return result.active; },
    operations: async id => {
      const result = await request(`/operations/${id}`); keys(result, ['complete', 'records']);
      check(result.complete === true && Array.isArray(result.records) && result.records.length <= 4096, 'Incomplete operation inventory');
      for (const record of result.records) {
        keys(record, ['id', 'kind', 'bodyDigest', 'result']);
        check(record.id === id && ['stage', 'activate'].includes(record.kind), 'Operation identity differs');
        hash(record.bodyDigest); version(record.result);
      }
      check(result.records.length <= 1, 'Duplicate matching operations');
      return result.records;
    },
    write: (kind, body) => { check(['stage', 'activate', 'reports'].includes(kind), 'Unsupported mutation'); return request(`/${kind}`, body); },
    reports: async id => {
      const result = await request(`/reports/${id}`); keys(result, ['complete', 'records']);
      check(result.complete === true && Array.isArray(result.records) && result.records.length <= 1, 'Incomplete or duplicate reporting inventory');
      for (const record of result.records) { keys(record, ['eventId', 'compositionDigest', 'verificationDigest', 'status']);
        check(record.eventId === id && record.status === 'success', 'Report identity differs'); hash(record.compositionDigest); hash(record.verificationDigest); }
      return result.records;
    }
  };
}
