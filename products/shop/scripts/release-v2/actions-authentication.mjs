import { createPublicKey, verify } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { check, digest, parseJSON } from './data.mjs';
import { validateHostedRoot } from './hosted-admission.mjs';
import { assertPolicy } from './provider-protocol-builders.mjs';

const issuer = 'https://token.actions.githubusercontent.com';
const jwksURL = `${issuer}/.well-known/jwks`;
const decode = (value, bound) => {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'Canonical JWT segment required');
  const bytes = Buffer.from(value, 'base64url');
  check(bytes.toString('base64url') === value && bytes.length <= bound, 'JWT segment exceeds its bound');
  return bytes;
};

async function readGithubKeys() {
  return new Promise((accept, reject) => {
    const request = httpsRequest(jwksURL, { method: 'GET', agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, response => {
      const chunks = []; let size = 0;
      if (response.statusCode !== 200) { reject(Error('GitHub signing keys unavailable; authentication remains held')); response.destroy(); request.destroy(); return; }
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 131072) { reject(Error('GitHub signing keys exceed bound')); response.destroy(); request.destroy(); }
        else chunks.push(chunk);
      });
      response.once('error', reject); response.once('aborted', () => reject(Error('GitHub signing key response truncated')));
      response.once('end', () => {
        try {
          const lengths = response.rawHeaders.filter((_, index) => index % 2 === 0 && response.rawHeaders[index].toLowerCase() === 'content-length');
          check(lengths.length <= 1 && response.complete, 'GitHub signing key framing differs');
          const declared = response.headers['content-length'];
          check(declared === undefined || /^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) === size, 'GitHub signing key length differs');
          accept(parseJSON(Buffer.concat(chunks), 131072));
        } catch (error) { reject(error); }
      });
    });
    const timeout = setTimeout(() => { reject(Error('GitHub signing key deadline exceeded')); request.destroy(); }, 10000);
    request.once('close', () => clearTimeout(timeout)); request.once('error', reject); request.end();
  });
}

// The custody installation authenticates the signed GitHub token itself. Claims
// parsed by the requesting controller never authorize a provider send.
export function createActionsAuthenticator({ root, policy, fenceAdmission, readKeys = readGithubKeys, now = Date.now }) {
  validateHostedRoot(root); assertPolicy(policy);
  check(root.providerPolicyDigest === digest(policy) && fenceAdmission.payload.policyDigest === digest(policy) &&
    fenceAdmission.payload.environmentId === root.credentialBroker.environmentId, 'Custody authentication installation differs');
  return async (input, context) => {
    check(context && typeof context.authorization === 'string' && /^Bearer [A-Za-z0-9_.-]{1,32768}$/.test(context.authorization), 'GitHub bearer identity required');
    const token = context.authorization.slice(7), segments = token.split('.'); check(segments.length === 3, 'Compact signed GitHub token required');
    const header = parseJSON(decode(segments[0], 4096)), claims = parseJSON(decode(segments[1], 65536));
    check(header.alg === 'RS256' && header.typ === 'JWT' && typeof header.kid === 'string' && header.kid.length > 0 && header.kid.length <= 256 &&
      Object.keys(header).every(key => ['alg', 'typ', 'kid', 'x5t'].includes(key)), 'GitHub token algorithm or key selection differs');
    const set = await readKeys();
    check(Array.isArray(set.keys) && set.keys.length > 0 && set.keys.length <= 32 && new Set(set.keys.map(key => key.kid)).size === set.keys.length, 'Unique GitHub public signing keys required');
    const jwk = set.keys.find(key => key.kid === header.kid);
    check(jwk && jwk.kty === 'RSA' && jwk.use === 'sig' && jwk.alg === 'RS256' && !Object.hasOwn(jwk, 'd') &&
      typeof jwk.n === 'string' && decode(jwk.n, 1024).length >= 256 && typeof jwk.e === 'string', 'Trusted GitHub RSA signing key required');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    check(verify('RSA-SHA256', Buffer.from(`${segments[0]}.${segments[1]}`), key, decode(segments[2], 1024)), 'GitHub token signature differs');
    const time = now();
    check(claims.iss === issuer && claims.aud === root.credentialBroker.audience &&
      claims.repository === root.repositoryName && String(claims.repository_id) === String(root.repository.repositoryId) &&
      String(claims.repository_owner_id) === String(root.repository.ownerId) && claims.environment === root.environment &&
      claims.sub === root.credentialBroker.subject && claims.ref === 'refs/heads/main' && claims.event_name === 'workflow_dispatch' &&
      claims.workflow_ref === `${root.repositoryName}/${root.workflowPath}@refs/heads/main` && /^[a-f0-9]{40}$/.test(claims.sha) && claims.workflow_sha === claims.sha &&
      /^[1-9][0-9]{0,15}$/.test(String(claims.run_id)) && /^[1-9][0-9]{0,15}$/.test(String(claims.run_attempt)) &&
      Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.nbf) && Number.isSafeInteger(claims.exp) &&
      claims.iat > 0 && claims.iat * 1000 <= time && claims.nbf > 0 && claims.nbf <= claims.iat && claims.nbf * 1000 <= time && claims.exp * 1000 > time && claims.exp - claims.iat <= 3600,
    'Signed GitHub workflow, environment or validity differs');
    check(input.environmentId === fenceAdmission.payload.environmentId && input.fenceDigest === fenceAdmission.digest, 'Authenticated custody call target differs');
    return { environmentId: input.environmentId, fenceDigest: input.fenceDigest, policyDigest: digest(policy),
      principalDigest: digest({ repository: root.repository, workflowRef: claims.workflow_ref, head: claims.sha, runId: claims.run_id, attempt: claims.run_attempt }) };
  };
}
