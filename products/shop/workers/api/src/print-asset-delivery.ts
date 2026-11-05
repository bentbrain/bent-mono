import { Either, Schema } from "effect";

import {
  IntegrationConfigError,
  requirePrintifyProductionConfig,
  type IntegrationEnv,
} from "./integration-config";

const DOWNLOAD_PATH =
  /^\/v2\/print-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/download$/u;
const GRANT_PREFIX = "v1";
const GRANT_LIFETIME_MS = 10 * 60 * 1_000;
const SIGNING_CONTEXT = "bent-shirt-printify-asset-v1\0";
const Sha256 = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const GrantPayloadSchema = Schema.Struct({
  assetId: Schema.UUID,
  expiresAt: Schema.Int.pipe(Schema.positive()),
  issuedAt: Schema.Int.pipe(Schema.positive()),
  sha256: Sha256,
}).pipe(Schema.filter(
  (payload) =>
    payload.expiresAt > payload.issuedAt &&
    payload.expiresAt - payload.issuedAt <= GRANT_LIFETIME_MS,
  { message: () => "Print-asset delivery grant lifetime is invalid." },
));

const PrintAssetRowSchema = Schema.Struct({
  byte_size: Schema.Int.pipe(Schema.positive()),
  content_type: Schema.Literal("image/png"),
  sha256: Sha256,
  storage_key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_024)),
});

type GrantPayload = Schema.Schema.Type<typeof GrantPayloadSchema>;

interface PrintAssetDeliveryEnv extends IntegrationEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
}

export async function createPrintAssetDeliveryUrl(
  origin: string,
  input: {
    readonly assetId: string;
    readonly expiresAt: number;
    readonly issuedAt: number;
    readonly sha256: string;
  },
  secret: string,
) {
  const payload = Schema.decodeUnknownSync(GrantPayloadSchema)(input);
  const encodedPayload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await sign(encodedPayload, secret);
  const url = new URL(
    `/v2/print-assets/${payload.assetId}/download`,
    `${origin}/`,
  );
  url.searchParams.set("grant", `${GRANT_PREFIX}.${encodedPayload}.${signature}`);
  return url.toString();
}

export async function handlePrintAssetDeliveryRequest(
  request: Request,
  env: PrintAssetDeliveryEnv,
  now = () => Date.now(),
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = DOWNLOAD_PATH.exec(url.pathname);
  if (!match) return undefined;
  if (request.method !== "GET") {
    return assetError(405, "METHOD_NOT_ALLOWED", { Allow: "GET" });
  }
  const assetId = match[1];
  const grant = url.searchParams.get("grant");
  if (!assetId || !grant) return assetError(401, "INVALID_GRANT");

  let secret: string;
  try {
    secret = requirePrintifyProductionConfig(env).assetDeliverySecret;
  } catch (error) {
    if (error instanceof IntegrationConfigError) {
      return assetError(503, "CONFIGURATION_ERROR");
    }
    throw error;
  }
  const payload = await verifyGrant(grant, secret, now());
  if (payload?.assetId !== assetId) {
    return assetError(401, "INVALID_GRANT");
  }

  const rawRow = await env.DB.prepare(`
    SELECT coalesce(objects.storage_key, assets.storage_key) AS storage_key,
      assets.content_type, assets.byte_size, assets.sha256
    FROM print_assets AS assets
    LEFT JOIN print_asset_objects AS objects
      ON objects.sha256 = assets.object_sha256
    WHERE assets.id = ? AND assets.sha256 = ? AND assets.status = 'ready'
  `).bind(payload.assetId, payload.sha256).first();
  const decodedRow = Schema.decodeUnknownEither(PrintAssetRowSchema)(rawRow);
  if (Either.isLeft(decodedRow)) return assetError(404, "ASSET_NOT_FOUND");
  const row = decodedRow.right;
  const object = await env.DESIGN_ARTWORK.get(row.storage_key);
  if (!object) return assetError(503, "ASSET_UNAVAILABLE");
  const checksum = object.checksums.sha256;
  if (object.size !== row.byte_size || checksum === undefined ||
      bytesToHex(new Uint8Array(checksum)) !== row.sha256) {
    return assetError(503, "ASSET_UNAVAILABLE");
  }

  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="bent-${assetId}.png"`,
      "Content-Length": String(row.byte_size),
      "Content-Type": row.content_type,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function printAssetGrantExpiry(issuedAt: number) {
  return issuedAt + GRANT_LIFETIME_MS;
}

async function verifyGrant(
  token: string,
  secret: string,
  now: number,
): Promise<GrantPayload | undefined> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== GRANT_PREFIX) return undefined;
    const encodedPayload = parts[1];
    const encodedSignature = parts[2];
    if (!encodedPayload || !encodedSignature ||
        !await signatureMatches(encodedPayload, encodedSignature, secret)) {
      return undefined;
    }
    const json: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeBase64Url(encodedPayload),
      ),
    );
    const payload = Schema.decodeUnknownEither(GrantPayloadSchema)(json);
    if (Either.isLeft(payload)) return undefined;
    return payload.right.issuedAt <= now && payload.right.expiresAt > now
      ? payload.right
      : undefined;
  } catch {
    return undefined;
  }
}

async function sign(payload: string, secret: string) {
  const key = await signingKey(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${SIGNING_CONTEXT}${payload}`),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function signatureMatches(
  payload: string,
  signature: string,
  secret: string,
) {
  const key = await signingKey(secret, "verify");
  return crypto.subtle.verify(
    "HMAC",
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(`${SIGNING_CONTEXT}${payload}`),
  );
}

function signingKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    [usage],
  );
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url.");
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assetError(
  status: number,
  code: string,
  headers?: HeadersInit,
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(
    { error: { code, message: "Print asset is unavailable." } },
    { headers: responseHeaders, status },
  );
}
