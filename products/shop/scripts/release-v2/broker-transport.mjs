import { request as httpsRequest } from 'node:https';
import { canonical, check, parseJSON } from './data.mjs';
import { actionsIdentity, validateHostedRoot } from './hosted-admission.mjs';

const jwt = value => check(typeof value === 'string' && value.length <= 32768 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value), 'Bounded Actions identity token required');
async function jsonRequest(url, method, token, value, maximumBytes) {
  check(url.protocol === 'https:' && !url.port && !url.hash && !url.username && !url.password, 'Exact credential service HTTPS origin required');
  check(typeof token === 'string' && token.length > 0 && token.length <= 32768 && !/[\x00-\x20\x7f]/.test(token), 'Bounded credential service authorization required');
  const body = value === null ? Buffer.alloc(0) : Buffer.from(canonical(value));
  check(body.length <= 256 * 1024 * 1024, 'Credential service request exceeds bound');
  return new Promise((accept, reject) => {
    const request = httpsRequest({ hostname: url.hostname, port: 443, method, path: `${url.pathname}${url.search}`,
      agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json', 'content-length': String(body.length) } }, response => {
      if (response.statusCode !== 200) { reject(Error('Credential service request failed; no replay or redirect')); response.destroy(); request.destroy(); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maximumBytes) { reject(Error('Credential service response exceeds bound')); response.destroy(); request.destroy(); }
        else chunks.push(chunk);
      });
      response.on('aborted', () => reject(Error('Credential service response was truncated'))); response.on('error', reject);
      response.on('end', () => {
        try {
          check(response.complete && !Array.isArray(response.headers['content-length']), 'Credential service response is incomplete');
          const declared = response.headers['content-length'];
          check(declared === undefined || /^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) === bytes, 'Credential service length differs');
          accept(parseJSON(Buffer.concat(chunks), maximumBytes));
        } catch (error) { reject(error); }
      });
    });
    const timeout = setTimeout(() => { reject(Error('Credential service deadline exceeded')); request.destroy(); }, 30000);
    request.once('close', () => clearTimeout(timeout)); request.once('error', reject); request.end(body);
  });
}

// Obtain one token for the independently installed broker audience. Signature
// validation and environment authorization remain the broker's responsibility.
export async function requestBrokerIdentity({ root, env = process.env, request = jsonRequest, now = Date.now() }) {
  validateHostedRoot(root); const identity = actionsIdentity(env), url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  check(url.protocol === 'https:' && /^[a-z0-9.-]+\.actions\.githubusercontent\.com$/.test(url.hostname) &&
    !url.port && !url.username && !url.password && !url.hash, 'Canonical Actions identity endpoint required');
  url.searchParams.set('audience', root.credentialBroker.audience);
  const response = await request(url, 'GET', env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, null, 131072); jwt(response.value);
  const payload = parseJSON(Buffer.from(response.value.split('.')[1], 'base64url'), 65536);
  check(payload.iss === 'https://token.actions.githubusercontent.com' && payload.aud === root.credentialBroker.audience &&
    payload.repository === identity.repositoryName && String(payload.repository_id) === String(identity.repository.repositoryId) &&
    String(payload.repository_owner_id) === String(identity.repository.ownerId) && payload.sha === identity.head &&
    payload.workflow_ref === identity.workflowRef && String(payload.run_id) === String(identity.runId) && String(payload.run_attempt) === String(identity.attempt) &&
    payload.sub === root.credentialBroker.subject &&
    Number.isSafeInteger(payload.exp) && Number.isSafeInteger(payload.nbf) && payload.nbf * 1000 <= now && payload.exp * 1000 > now,
  'Actions token audience or invocation differs');
  return response.value;
}

export function createBrokerTransport({ root, token, request = jsonRequest }) {
  validateHostedRoot(root); jwt(token);
  const url = new URL('/v1/invocations', root.credentialBroker.origin);
  return call => request(url, 'POST', token, call, 256 * 1024 * 1024);
}
