const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const MAX_BFF_JSON_BYTES = 16 * 1_024;
const ABUSE_CLEARANCE_COOKIE = "__Host-forever_tee_abuse";
const ABUSE_CLEARANCE_SECONDS = 15 * 60;
export const TURNSTILE_ACTION = "design_processing";
export const PRODUCTION_TURNSTILE_HOSTNAMES = new Set([
  "forever-tee-web.vercel.app",
  "shop.bent.build",
]);
export const DEVELOPMENT_TURNSTILE_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
]);

interface MutationBodySuccess {
  readonly ok: true;
  readonly body: Uint8Array;
}

interface MutationBodyFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

type MutationBodyResult = MutationBodySuccess | MutationBodyFailure;

export function acceptsSameOriginMutation(request: Request) {
  if (!MUTATION_METHODS.has(request.method)) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

export function workerHeaders(
  request: Request,
  ownerId: string,
  sharedSecret: string,
  requestId?: string,
) {
  const headers = new Headers({
    Accept: "application/json",
    "x-forever-tee-owner-id": ownerId,
    "x-forever-tee-service-secret": sharedSecret,
  });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (requestId) headers.set("x-request-id", requestId);
  return headers;
}

export function forwardedWorkerHeaders(response: Response) {
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  for (const name of [
    "content-type",
    "retry-after",
    "server-timing",
    "x-request-id",
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function verifyTurnstileToken(
  token: string | null,
  secret: string,
  remoteIp: string | undefined,
  fetcher: typeof fetch = fetch,
  allowedHostnames = turnstileHostnamesForEnvironment(process.env.NODE_ENV),
  testMode = turnstileTestMode(
    process.env.NODE_ENV,
    process.env["VERCEL_ENV"],
    process.env["TURNSTILE_TEST_MODE"],
  ),
) {
  if (!token || token.length > 2_048) return false;
  const body = new URLSearchParams({ response: token, secret });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const response = await fetcher(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return isTurnstileSuccess(payload, allowedHostnames, testMode);
  } catch {
    return false;
  }
}

export function requestClientIp(request: Request) {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
}

export async function createAbuseClearance(
  ownerId: string,
  secret: string,
  now = Date.now(),
) {
  const expiresAt = now + ABUSE_CLEARANCE_SECONDS * 1_000;
  const payload = clearancePayload(ownerId, expiresAt);
  const signature = await signClearance(payload, secret);
  return `${expiresAt.toString()}.${signature}`;
}

export async function hasAbuseClearance(
  request: Request,
  ownerId: string,
  secret: string,
  now = Date.now(),
) {
  const value = requestCookie(request, ABUSE_CLEARANCE_COOKIE);
  if (!value) return false;
  const separator = value.indexOf(".");
  if (separator <= 0) return false;
  const expiresText = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!/^\d+$/.test(expiresText) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return false;
  }
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const payload = clearancePayload(ownerId, expiresAt);
  return verifyClearance(payload, signature, secret);
}

export function abuseClearanceCookie(value: string) {
  return `${ABUSE_CLEARANCE_COOKIE}=${value}; Max-Age=${ABUSE_CLEARANCE_SECONDS.toString()}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function requiresJsonMutation(request: Request) {
  const path = new URL(request.url).pathname;
  return request.method === "PATCH" ||
    path.endsWith("/upload-grants") ||
    path.endsWith("/artwork-processing") ||
    path === "/api/configured-products" ||
    path === "/api/configured-product-families";
}

export function declaredMutationLength(request: Request) {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}

export function hasJsonContentType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim() ===
    "application/json";
}

export async function readMutationBody(request: Request, maxBytes: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let next = await reader.read();
  while (!next.done) {
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function matchesDeclaredLength(
  declaredLength: number | undefined,
  body: Uint8Array,
) {
  return declaredLength !== undefined && body.byteLength === declaredLength;
}

export async function validateMutationBody(
  request: Request,
): Promise<MutationBodyResult> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { ok: true, body: new Uint8Array() };
  }
  const jsonRequired = requiresJsonMutation(request);
  if (jsonRequired && !hasJsonContentType(request)) {
    return failure(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
  }
  const declaredLength = declaredMutationLength(request);
  if (
    jsonRequired &&
    declaredLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) || declaredLength <= 0)
  ) {
    return failure(411, "BAD_REQUEST", "A valid Content-Length is required.");
  }
  if (declaredLength !== undefined && declaredLength > MAX_BFF_JSON_BYTES) {
    return failure(413, "PAYLOAD_TOO_LARGE", "The JSON request is too large.");
  }
  const body = await readMutationBody(request, MAX_BFF_JSON_BYTES);
  if (!body) {
    return failure(413, "PAYLOAD_TOO_LARGE", "The JSON request is too large.");
  }
  if (jsonRequired && body.byteLength === 0) {
    return failure(400, "BAD_REQUEST", "A JSON request body is required.");
  }
  // Browsers and proxies may omit Content-Length. The bounded reader above
  // enforces the limit on actual bytes, regardless of declared metadata.
  if (jsonRequired && declaredLength !== undefined && !matchesDeclaredLength(declaredLength, body)) {
    return failure(400, "BAD_REQUEST", "Content-Length does not match the request body.");
  }
  return { ok: true, body };
}

function failure(
  status: number,
  code: string,
  message: string,
): MutationBodyFailure {
  return { ok: false, status, code, message };
}

export function turnstileHostnamesForEnvironment(environment: string | undefined) {
  return environment === "production"
    ? PRODUCTION_TURNSTILE_HOSTNAMES
    : DEVELOPMENT_TURNSTILE_HOSTNAMES;
}

export function turnstileTestMode(
  nodeEnvironment: string | undefined,
  vercelEnvironment: string | undefined,
  configured: string | undefined,
) {
  if (configured !== "1" || vercelEnvironment === "production") return false;
  return vercelEnvironment === "preview" || nodeEnvironment !== "production";
}

function isTurnstileSuccess(
  value: unknown,
  allowedHostnames: ReadonlySet<string>,
  testMode: boolean,
) {
  if (typeof value !== "object" || value === null) return false;
  if (!("success" in value) || value.success !== true) return false;
  if (testMode) {
    return "hostname" in value && value.hostname === "example.com" &&
      !("action" in value);
  }
  return (
    "action" in value && value.action === TURNSTILE_ACTION &&
    "hostname" in value && typeof value.hostname === "string" &&
    allowedHostnames.has(value.hostname)
  );
}

function requestCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function clearancePayload(ownerId: string, expiresAt: number) {
  return `v1:${ownerId}:${expiresAt.toString()}`;
}

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    [usage],
  );
}

async function signClearance(payload: string, secret: string) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    new TextEncoder().encode(payload),
  );
  return base64Url(new Uint8Array(signature));
}

async function verifyClearance(
  payload: string,
  signature: string,
  secret: string,
) {
  const bytes = decodeBase64Url(signature);
  if (!bytes) return false;
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    bytes,
    new TextEncoder().encode(payload),
  );
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(`${base64}${"=".repeat((4 - base64.length % 4) % 4)}`);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}
