import { createHmac, createPrivateKey, sign } from 'node:crypto';
import { canonical, check, digest, sha256 } from './data.mjs';
import { assertPolicy, exactFields } from './provider-protocol-builders.mjs';

const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const uri = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

// Explicit, short-lived credentials belong to the custody installation. This
// adapter never consults environment variables, profiles or credential chains.
export function createProviderSigner({ policy, session, bearerTokens, keyId, privateKeyPem, now = Date.now }) {
  assertPolicy(policy);
  exactFields(session, ['accountId', 'region', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'expiresAt']);
  check(session.accountId === policy.awsAccountId && session.region === policy.region && /^[A-Z0-9]{16,128}$/.test(session.accessKeyId) &&
    typeof session.secretAccessKey === 'string' && session.secretAccessKey.length >= 32 && session.secretAccessKey.length <= 256 &&
    typeof session.sessionToken === 'string' && session.sessionToken.length > 0 && session.sessionToken.length <= 16384 &&
    Number.isSafeInteger(session.expiresAt) && session.expiresAt > now(), 'Explicit pinned temporary provider session required');
  exactFields(bearerTokens, ['cloudflare', 'github']);
  for (const value of Object.values(bearerTokens)) check(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,8192}$/.test(value), 'Explicit provider bearer token required');
  check(typeof keyId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(keyId) && typeof privateKeyPem === 'string' && privateKeyPem.length <= 8192, 'Private provider attestation identity required');
  const key = createPrivateKey(privateKeyPem); check(key.asymmetricKeyType === 'ed25519', 'Independent Ed25519 provider attestation key required');
  return async input => {
    exactFields(input, ['request', 'requestDigest', 'policyDigest', 'now']);
    const request = input.request, time = now();
    check(input.policyDigest === digest(policy) && input.requestDigest === digest(request) && input.now <= time && input.now >= time - 1000 &&
      session.expiresAt > time + 30000 && request.policyDigest === digest(policy), 'Provider signing subject, clock or session differs');
    const url = new URL(request.url); check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && request.headers.host === url.host, 'Protected signing origin required');
    let credentialHeaders;
    if (['s3', 'lambda'].includes(request.service)) {
      check(url.host === (request.service === 's3' ? `${policy.store.bucket}.s3.${policy.region}.amazonaws.com` : `lambda.${policy.region}.amazonaws.com`), 'AWS signing origin differs');
      const date = new Date(time).toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0, 8);
      credentialHeaders = { 'x-amz-date': date, 'x-amz-security-token': session.sessionToken, 'x-amz-content-sha256': request.bodySha256 };
      const headers = { ...request.headers, ...credentialHeaders }, names = Object.keys(headers).sort();
      const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
      const query = [...url.searchParams].map(([name, value]) => [uri(name), uri(value)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0).map(pair => pair.join('=')).join('&');
      const path = url.pathname.split('/').map(segment => uri(decodeURIComponent(segment))).join('/');
      const canonicalRequest = [request.method, path, query, canonicalHeaders, names.join(';'), request.bodySha256].join('\n');
      const scope = `${day}/${policy.region}/${request.service}/aws4_request`;
      const signingKey = hmac(hmac(hmac(hmac(`AWS4${session.secretAccessKey}`, day), policy.region), request.service), 'aws4_request');
      const signature = hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonicalRequest)}`).toString('hex');
      credentialHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${session.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    } else {
      check(request.service === 'cloudflare' && url.host === 'api.cloudflare.com' || request.service === 'github' && url.host === 'api.github.com', 'Bearer signing origin differs');
      credentialHeaders = Object.hasOwn(request.headers, 'authorization') ? {} : { authorization: `Bearer ${bearerTokens[request.service]}` };
      check(!Object.hasOwn(request.headers, 'authorization') || request.operation === 'assets.upload', 'Unexpected embedded capability');
    }
    const payload = { schema: 'shop.provider-signature/v1', requestDigest: input.requestDigest, policyDigest: input.policyDigest,
      credentialHeadersDigest: digest(credentialHeaders), issuedAt: input.now, expiresAt: Math.min(session.expiresAt, input.now + 30000) };
    return { keyId, payload, signature: sign(null, Buffer.from(canonical(payload)), key).toString('base64'), credentialHeaders };
  };
}
