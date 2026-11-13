import { createPublicKey, verify } from 'node:crypto';
import { canonical, check, digest, same, sha256 } from './data.mjs';
import { assertPolicy, assertProtocolRequest, exactFields } from './provider-protocol-builders.mjs';

function requestIdentity(request) {
  return { schema: request.schema, policyDigest: request.policyDigest, service: request.service, operation: request.operation,
    method: request.method, url: request.url, headers: request.headers, bodySha256: request.bodySha256,
    bytes: Buffer.from(request.bodyBase64, 'base64').length };
}
export const requestDigest = request => digest(requestIdentity(request));
const trusts = new WeakSet();
export function signingTrust({ policy, keys, maximumLifetimeMs = 30000 }) {
  assertPolicy(policy);
  check(Number.isSafeInteger(maximumLifetimeMs) && maximumLifetimeMs > 0 && maximumLifetimeMs <= 30000, 'Bounded signer lifetime required');
  check(Array.isArray(keys) && keys.length > 0 && keys.length <= 8 && new Set(keys.map(key => key.id)).size === keys.length, 'Unique protected signing keys required');
  const validated = keys.map(key => {
    exactFields(key, ['id', 'publicKey']);
    check(typeof key.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key.id), 'Malformed signer identity');
    check(typeof key.publicKey === 'string' && key.publicKey.length <= 4096 && /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\n?$/.test(key.publicKey), 'PEM public attestation key required');
    const publicKey = createPublicKey(key.publicKey);
    check(publicKey.asymmetricKeyType === 'ed25519', 'Ed25519 signer attestation key required');
    return Object.freeze({ id: key.id, publicKey });
  });
  const trust = Object.freeze({ policyDigest: digest(policy), keys: Object.freeze(validated), maximumLifetimeMs }); trusts.add(trust); return trust;
}
function credentialHeaders(request, headers, policy) {
  check(headers && typeof headers === 'object' && !Array.isArray(headers) && Object.keys(headers).length <= 4, 'Bounded signed credentials required');
  const allowed = request.service === 's3' || request.service === 'lambda'
    ? ['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256'] : ['authorization'];
  for (const [name, value] of Object.entries(headers)) {
    check(allowed.includes(name) && !Object.hasOwn(request.headers, name) && typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\x00-\x1f\x7f]/.test(value), 'Signer changed a protected header');
  }
  if (request.service === 's3' || request.service === 'lambda') {
    exactFields(headers, ['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256']);
    check(/^[0-9]{8}T[0-9]{6}Z$/.test(headers['x-amz-date']) && headers['x-amz-content-sha256'] === request.bodySha256, 'AWS signing payload/date differs');
    const escaped = policy.region;
    const authorization = new RegExp(`^AWS4-HMAC-SHA256 Credential=([A-Z0-9]{16,128})/([0-9]{8})/${escaped}/${request.service}/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$`).exec(headers.authorization);
    check(authorization && authorization[2] === headers['x-amz-date'].slice(0, 8), 'AWS signer scope differs');
    const signed = authorization[3].split(';'), required = [...Object.keys(request.headers), 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256'].sort();
    check(same(signed, required), 'AWS signer must bind every protected header');
  } else if (Object.hasOwn(request.headers, 'authorization')) check(request.operation === 'assets.upload' && Object.keys(headers).length === 0, 'Unexpected embedded authorization');
  else check(Object.keys(headers).length === 1 && /^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(headers.authorization), 'Bounded provider bearer authorization required');
  return Object.freeze({ ...headers });
}

// A protected signer supplies provider credentials and an independent Ed25519
// attestation. The attestation covers credential headers as well as the exact
// origin, resource, policy, serialization and validity interval. No key lookup,
// credential chain, environment discovery or signer provisioning occurs here.
export async function authorizeRequest({ request, policy, signer, trust, now = Date.now }) {
  assertProtocolRequest(request, policy);
  check(trusts.has(trust) && trust.policyDigest === digest(policy) && typeof signer === 'function' && typeof now === 'function', 'Protected signer and matching trust required');
  const started = now(); check(Number.isSafeInteger(started), 'Exact signer clock required');
  const result = await signer(Object.freeze({ request: requestIdentity(request), requestDigest: requestDigest(request), policyDigest: digest(policy), now: started }));
  exactFields(result, ['keyId', 'payload', 'signature', 'credentialHeaders']);
  const headers = credentialHeaders(request, result.credentialHeaders, policy);
  const key = trust.keys.find(candidate => candidate.id === result.keyId); check(key, 'Untrusted signer identity');
  exactFields(result.payload, ['schema', 'requestDigest', 'policyDigest', 'credentialHeadersDigest', 'issuedAt', 'expiresAt']);
  const payload = result.payload, finished = now();
  check(payload.schema === 'shop.provider-signature/v1' && payload.requestDigest === requestDigest(request) && payload.policyDigest === digest(policy) &&
    payload.credentialHeadersDigest === digest(headers) && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt) &&
    Number.isSafeInteger(finished) && finished >= started && payload.issuedAt <= started && payload.issuedAt >= started - 1000 &&
    payload.expiresAt > finished && payload.expiresAt - payload.issuedAt <= trust.maximumLifetimeMs, 'Signer payload, policy or validity differs');
  check(typeof result.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(result.signature) &&
    verify(null, Buffer.from(canonical(payload)), key.publicKey, Buffer.from(result.signature, 'base64')), 'Invalid signer attestation');
  return Object.freeze({ ...request, headers: Object.freeze({ ...request.headers, ...headers }), authorizationDigest: digest(payload),
    // Dispatch uses the original string, checked again after signing.
    bodyBase64: request.bodyBase64, bodySha256: sha256(Buffer.from(request.bodyBase64, 'base64')) });
}
