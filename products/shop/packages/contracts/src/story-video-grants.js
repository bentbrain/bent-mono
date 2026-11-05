const encoder = new TextEncoder();
const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-v5(?:-v6(?:-v7)?)?)?$/;

export function isStoryVideoJobId(value) {
  return typeof value === "string" && jobIdPattern.test(value);
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decode(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));
}

async function key(secret) {
  if (secret.length < 32) throw new Error("Story-video grant secret is not configured.");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createStoryVideoGrant(secret, jobId, attempt, now = Date.now()) {
  if (!isStoryVideoJobId(jobId) || !Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new Error("Invalid render grant.");
  const payload = encode(encoder.encode(JSON.stringify({ jobId, attempt, expiresAt: now + 180_000 })));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function verifyStoryVideoGrant(secret, token, jobId, now = Date.now(), failureGraceMs = 0) {
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return;
  try {
    if (!await crypto.subtle.verify("HMAC", await key(secret), decode(signature), encoder.encode(payload))) return;
    const value = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (typeof value !== "object" || value === null || value.jobId !== jobId || !isStoryVideoJobId(jobId) ||
      typeof value.attempt !== "number" || !Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 3 ||
      typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now - failureGraceMs || value.expiresAt > now + 180_000) return;
    return { jobId, attempt: value.attempt, expiresAt: value.expiresAt };
  } catch { return; }
}
