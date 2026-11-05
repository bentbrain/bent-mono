import { Either, Schema } from "effect";

import { DesignRevisionId } from "./design";
import {
  ArtworkSha256Schema,
  ProductId,
  ProductProjectionVersionSchema,
} from "./product";

const MINIMUM_SIGNING_SECRET_LENGTH = 32;
const TOKEN_PREFIX = "v1";
const SIGNING_CONTEXT = "bent-shirt-cart-line-v1\0";
const CompactUuidSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{22}$/),
);
const CompactSha256Schema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/),
);

const CompactCartLineCapabilitySchema = Schema.Tuple(
  Schema.Literal(1),
  CompactUuidSchema,
  CompactUuidSchema,
  CompactUuidSchema,
  ProductProjectionVersionSchema,
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  CompactUuidSchema,
  CompactSha256Schema,
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  Schema.Int.pipe(Schema.positive()),
  CompactUuidSchema,
  Schema.Literal("Black", "Cream", "White"),
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  Schema.Int.pipe(Schema.between(1, 10)),
  Schema.Int.pipe(Schema.positive()),
  Schema.Int.pipe(Schema.positive()),
);

export const CartLineCapabilityPayloadSchema = Schema.Struct({
  baseProductId: ProductId,
  color: Schema.Literal("Black", "Cream", "White"),
  configuredProductId: ProductId,
  designRevisionId: DesignRevisionId,
  expiresAt: Schema.Int.pipe(Schema.positive()),
  issuedAt: Schema.Int.pipe(Schema.positive()),
  printGeometryKey: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128),
  ),
  printAssetId: Schema.UUID,
  printAssetSha256: ArtworkSha256Schema,
  printifyVariantId: Schema.Int.pipe(Schema.positive()),
  projectionVersion: ProductProjectionVersionSchema,
  quantity: Schema.Int.pipe(Schema.between(1, 10)),
  shopifyVariantId: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(256),
  ),
  size: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  variantMappingSnapshotId: Schema.UUID,
  version: Schema.Literal(1),
}).pipe(
  Schema.filter(
    (payload) => payload.expiresAt > payload.issuedAt,
    { message: () => "Cart-line capability expiry must follow its issue time." },
  ),
);

export type CartLineCapabilityPayload = Schema.Schema.Type<
  typeof CartLineCapabilityPayloadSchema
>;

export class CartLineCapabilityError extends Error {}

export async function signCartLineCapability(
  input: CartLineCapabilityPayload,
  secret: string,
) {
  requireSigningSecret(secret);
  const payload = decodeCapabilityPayload(input);
  const encodedPayload = encodeUtf8(JSON.stringify(compactPayload(payload)));
  const signature = await sign(encodedPayload, secret);
  const token = `${TOKEN_PREFIX}.${encodedPayload}.${signature}`;
  if (token.length > 500) {
    throw new CartLineCapabilityError(
      "The cart-line capability exceeds Shopify's attribute limit.",
    );
  }
  return token;
}

export async function verifyCartLineCapability(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<CartLineCapabilityPayload | undefined> {
  try {
    requireSigningSecret(secret);
    if (token.length > 500) return undefined;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return undefined;
    const encodedPayload = parts[1];
    const encodedSignature = parts[2];
    if (!encodedPayload || !encodedSignature) return undefined;
    if (!await signatureMatches(encodedPayload, encodedSignature, secret)) {
      return undefined;
    }
    const decodedJson: unknown = JSON.parse(decodeUtf8(encodedPayload));
    const compact = Schema.decodeUnknownEither(
      CompactCartLineCapabilitySchema,
    )(decodedJson);
    if (Either.isLeft(compact)) return undefined;
    const payload = decodeCapabilityPayload(expandPayload(compact.right));
    return payload.issuedAt <= now && payload.expiresAt > now
      ? payload
      : undefined;
  } catch {
    return undefined;
  }
}

// Cart intents bind the customer's selection before rendering finishes. Their
// separate prefix and schema cannot be accepted as paid-order capabilities.
const CartLineIntentSchema = CartLineCapabilityPayloadSchema.pipe(
  Schema.omit("printAssetId", "printAssetSha256", "version"),
);
export type CartLineIntentPayload = Schema.Schema.Type<typeof CartLineIntentSchema>;
const CompactIntentSchema = Schema.Tuple(
  Schema.Literal("cart-intent"), CompactUuidSchema, CompactUuidSchema,
  CompactUuidSchema, ProductProjectionVersionSchema, Schema.String,
  Schema.String, Schema.Int, CompactUuidSchema, Schema.String, Schema.String,
  Schema.Int, Schema.Int, Schema.Int,
);

export async function signCartLineIntent(input: CartLineIntentPayload, secret: string) {
  requireSigningSecret(secret);
  const payload = Schema.decodeUnknownSync(CartLineIntentSchema)(input);
  if (payload.expiresAt <= payload.issuedAt) throw new CartLineCapabilityError("Invalid intent expiry.");
  const encoded = encodeUtf8(JSON.stringify([
    "cart-intent", compactUuid(payload.baseProductId), compactUuid(payload.configuredProductId),
    compactUuid(payload.designRevisionId), payload.projectionVersion, payload.printGeometryKey,
    payload.shopifyVariantId, payload.printifyVariantId, compactUuid(payload.variantMappingSnapshotId),
    payload.color, payload.size, payload.quantity, payload.issuedAt, payload.expiresAt,
  ]));
  const token = `i1.${encoded}.${await sign(encoded, secret)}`;
  if (token.length > 500) throw new CartLineCapabilityError("Cart intent exceeds the attribute limit.");
  return token;
}

export async function verifyCartLineIntent(token: string, secret: string, now = Date.now()): Promise<CartLineIntentPayload | undefined> {
  try {
    requireSigningSecret(secret);
    if (token.length > 500) return undefined;
    const [prefix, encoded, signature, extra] = token.split(".");
    if (prefix !== "i1" || !encoded || !signature || extra !== undefined) return undefined;
    if (!await signatureMatches(encoded, signature, secret)) return undefined;
    const parsed: unknown = JSON.parse(decodeUtf8(encoded));
    const compact = Schema.decodeUnknownSync(CompactIntentSchema)(parsed);
    const payload = Schema.decodeUnknownSync(CartLineIntentSchema)({
      baseProductId: expandUuid(compact[1]), configuredProductId: expandUuid(compact[2]),
      designRevisionId: expandUuid(compact[3]), projectionVersion: compact[4], printGeometryKey: compact[5],
      shopifyVariantId: compact[6], printifyVariantId: compact[7], variantMappingSnapshotId: expandUuid(compact[8]),
      color: compact[9], size: compact[10], quantity: compact[11], issuedAt: compact[12], expiresAt: compact[13],
    });
    return payload.issuedAt <= now && payload.expiresAt > now ? payload : undefined;
  } catch {
    return undefined;
  }
}

function compactPayload(payload: CartLineCapabilityPayload) {
  return [
    payload.version,
    compactUuid(payload.baseProductId),
    compactUuid(payload.configuredProductId),
    compactUuid(payload.designRevisionId),
    payload.projectionVersion,
    payload.printGeometryKey,
    compactUuid(payload.printAssetId),
    compactSha256(payload.printAssetSha256),
    payload.shopifyVariantId,
    payload.printifyVariantId,
    compactUuid(payload.variantMappingSnapshotId),
    payload.color,
    payload.size,
    payload.quantity,
    payload.issuedAt,
    payload.expiresAt,
  ];
}

function expandPayload(
  payload: Schema.Schema.Type<typeof CompactCartLineCapabilitySchema>,
) {
  return {
    baseProductId: expandUuid(payload[1]),
    color: payload[11],
    configuredProductId: expandUuid(payload[2]),
    designRevisionId: expandUuid(payload[3]),
    expiresAt: payload[15],
    issuedAt: payload[14],
    printAssetId: expandUuid(payload[6]),
    printAssetSha256: expandSha256(payload[7]),
    printGeometryKey: payload[5],
    printifyVariantId: payload[9],
    projectionVersion: payload[4],
    quantity: payload[13],
    shopifyVariantId: payload[8],
    size: payload[12],
    variantMappingSnapshotId: expandUuid(payload[10]),
    version: payload[0],
  };
}

function compactUuid(value: string) {
  return encodeHex(value.replaceAll("-", ""));
}

function expandUuid(value: string) {
  const hex = decodeHex(value, 16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function compactSha256(value: string) {
  return encodeHex(value);
}

function expandSha256(value: string) {
  return decodeHex(value, 32);
}

function encodeHex(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return encodeBytes(bytes);
}

function decodeHex(value: string, expectedBytes: number) {
  const bytes = decodeBytes(value);
  if (bytes?.byteLength !== expectedBytes) {
    throw new CartLineCapabilityError("Invalid capability identifier.");
  }
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function decodeCapabilityPayload(value: unknown) {
  const decoded = Schema.decodeUnknownEither(CartLineCapabilityPayloadSchema)(
    value,
  );
  if (Either.isLeft(decoded)) {
    throw new CartLineCapabilityError("The cart-line capability is invalid.");
  }
  return decoded.right;
}

function requireSigningSecret(secret: string) {
  if (secret.length < MINIMUM_SIGNING_SECRET_LENGTH) {
    throw new CartLineCapabilityError(
      "The cart-line signing secret is not configured securely.",
    );
  }
}

async function sign(encodedPayload: string, secret: string) {
  const key = await signingKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${SIGNING_CONTEXT}${encodedPayload}`),
  );
  return encodeBytes(new Uint8Array(signature));
}

async function signatureMatches(
  encodedPayload: string,
  encodedSignature: string,
  secret: string,
) {
  const signature = decodeBytes(encodedSignature);
  if (!signature) return false;
  const key = await signingKey(secret, ["verify"]);
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(`${SIGNING_CONTEXT}${encodedPayload}`),
  );
}

function signingKey(secret: string, usages: KeyUsage[]) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    usages,
  );
}

function encodeUtf8(value: string) {
  return encodeBytes(new TextEncoder().encode(value));
}

function decodeUtf8(value: string) {
  const bytes = decodeBytes(value);
  if (!bytes) throw new CartLineCapabilityError("Invalid capability encoding.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const padding = "=".repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}
