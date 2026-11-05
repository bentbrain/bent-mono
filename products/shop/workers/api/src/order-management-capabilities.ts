import { isAuthenticatedServiceRequest } from "./service-auth";

export const ORDER_MANAGEMENT_CAPABILITIES_PATH =
  "/v2/internal/order-management-capabilities";

const CAPABILITY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const SHOPIFY_CART_ID_PATTERN = /^gid:\/\/shopify\/Cart\/[A-Za-z0-9_-]+(?:\?key=[A-Za-z0-9_-]+)?$/u;

interface OrderManagementCapabilityEnv {
  readonly DB: D1Database;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
}

export async function handleOrderManagementCapabilityRequest(
  request: Request,
  env: OrderManagementCapabilityEnv,
  now = () => Date.now(),
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== ORDER_MANAGEMENT_CAPABILITIES_PATH) return undefined;
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use POST.", { Allow: "POST" });
  }
  if (!(await isAuthenticatedServiceRequest(request, env))) {
    return apiError(401, "UNAUTHORIZED", "Service authentication is required.");
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send a JSON request.");
  }
  const input = parseRequest(await request.json().catch(() => undefined));
  if (!input) {
    return apiError(400, "INVALID_REQUEST", "A Shopify cart identifier is required.");
  }

  const issuedAt = now();
  const capability = randomCapability();
  const tokenHash = await sha256Hex(capability);
  try {
    const result = await env.DB.prepare(`
      INSERT INTO order_management_capabilities (
        token_hash, shopify_cart_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (shopify_cart_id) DO UPDATE SET
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at,
        bound_at = NULL,
        revoked_at = NULL
      WHERE order_management_capabilities.bound_at IS NULL
        AND order_management_capabilities.revoked_at IS NULL
    `).bind(
      tokenHash,
      input.shopifyCartId,
      issuedAt + CAPABILITY_LIFETIME_MS,
      issuedAt,
    ).run();
    if (result.meta.changes !== 1) {
      return apiError(
        409,
        "CART_ALREADY_BOUND",
        "This Shopify cart has already been bound to an order.",
      );
    }
  } catch {
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Order management capability could not be issued.",
    );
  }

  return Response.json(
    { capability },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function parseRequest(value: unknown) {
  if (!isRecord(value)) return undefined;
  const shopifyCartId = value["shopifyCartId"];
  if (
    typeof shopifyCartId !== "string" || shopifyCartId.length > 512 ||
    !SHOPIFY_CART_ID_PATTERN.test(shopifyCartId)
  ) return undefined;
  return { shopifyCartId };
}

function randomCapability() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    { error: { code, message } },
    { ...(headers ? { headers } : {}), status },
  );
}
