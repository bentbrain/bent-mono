import type { IntegrationEnv } from "./integration-config";
import {
  IntegrationConfigError,
  requireShopifyWebhookConfig,
} from "./integration-config";
import { ingestPaidShopifyOrder } from "./paid-order-ingestion";
import { recordPersonalDataAccess } from "./personal-data-audit";

export const SHOPIFY_ORDERS_PAID_WEBHOOK_PATH =
  "/v2/webhooks/shopify/orders-paid";
const SHOPIFY_ORDERS_PAID_TOPIC = "orders/paid";

const MAX_WEBHOOK_BYTES = 1_048_576;
const SHOPIFY_HMAC_HEADER = "x-shopify-hmac-sha256";
const MINIMIZED_PAYLOAD_AUDIT = '{"schema":"orders-paid-audit-v1"}';

interface ShopifyWebhookEnv extends IntegrationEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
}

export async function handleShopifyWebhookRequest(
  request: Request,
  env: ShopifyWebhookEnv,
  now = () => Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== SHOPIFY_ORDERS_PAID_WEBHOOK_PATH) return undefined;
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
      Allow: "POST",
    });
  }

  let config: ReturnType<typeof requireShopifyWebhookConfig>;
  try {
    config = requireShopifyWebhookConfig(env);
  } catch (error) {
    if (error instanceof IntegrationConfigError) {
      return apiError(
        503,
        "CONFIGURATION_ERROR",
        "Shopify webhook verification is unavailable.",
      );
    }
    throw error;
  }

  const metadata = readWebhookMetadata(request.headers);
  if (metadata instanceof Response) return metadata;
  if (
    config.storeDomain &&
    metadata.shopDomain !== config.storeDomain.toLowerCase()
  ) {
    return apiError(403, "INVALID_SHOP", "Webhook shop is not authorized.");
  }

  const declaredLength = declaredContentLength(request.headers);
  if (declaredLength instanceof Response) return declaredLength;
  if (
    declaredLength !== undefined &&
    declaredLength > MAX_WEBHOOK_BYTES
  ) {
    return apiError(413, "PAYLOAD_TOO_LARGE", "Webhook payload is too large.");
  }

  const body = await readBoundedBody(request, declaredLength);
  if (body instanceof Response) return body;
  if (!await validHmac(body, metadata.hmac, config.clientSecret)) {
    return apiError(401, "INVALID_SIGNATURE", "Webhook signature is invalid.");
  }

  let payloadText: string;
  try {
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return apiError(400, "INVALID_PAYLOAD", "Webhook payload is invalid.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return apiError(400, "INVALID_PAYLOAD", "Webhook payload is invalid.");
  }
  if (!isRecord(payload)) {
    return apiError(400, "INVALID_PAYLOAD", "Webhook payload is invalid.");
  }

  const payloadSha256 = await sha256Hex(body);
  const receivedAt = now();
  try {
    await env.DB.prepare(`
      INSERT INTO shopify_webhook_inbox (
        webhook_id, topic, shop_domain, api_version, triggered_at,
        payload_sha256, payload_json, status, attempt_count, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
      ON CONFLICT (webhook_id) DO NOTHING
    `).bind(
      metadata.webhookId,
      metadata.topic,
      metadata.shopDomain,
      metadata.apiVersion,
      metadata.triggeredAt,
      payloadSha256,
      MINIMIZED_PAYLOAD_AUDIT,
      receivedAt,
    ).run();
    const stored = await env.DB.prepare(`
      SELECT topic, shop_domain, payload_sha256, status
      FROM shopify_webhook_inbox
      WHERE webhook_id = ?
    `).bind(metadata.webhookId).first<{
      topic: string;
      shop_domain: string;
      payload_sha256: string;
      status: "pending" | "processing" | "processed" | "failed";
    }>();
    if (
      stored?.topic !== metadata.topic ||
      stored.shop_domain !== metadata.shopDomain ||
      stored.payload_sha256 !== payloadSha256
    ) {
      return apiError(
        409,
        "WEBHOOK_ID_CONFLICT",
        "Webhook identifier conflicts with an existing delivery.",
      );
    }
    if (stored.status === "processed") return accepted();
  } catch {
    return apiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Webhook storage is unavailable.",
    );
  }

  let claimed: D1Result;
  try {
    claimed = await env.DB.prepare(`
      UPDATE shopify_webhook_inbox
      SET status = 'processing', attempt_count = attempt_count + 1,
        processing_started_at = ?, last_error = NULL
      WHERE webhook_id = ? AND (
        status IN ('pending', 'failed') OR
        (status = 'processing' AND processing_started_at < ?)
      )
    `).bind(receivedAt, metadata.webhookId, receivedAt - 5 * 60 * 1_000).run();
  } catch {
    return dependencyUnavailable();
  }
  if (claimed.meta.changes !== 1) return dependencyUnavailable();

  try {
    const shopifyOrderId = paidOrderId(payload);
    await recordPersonalDataAccess(env.DB, {
      action: "receive",
      actor: "system:shopify-webhook",
      purpose: "paid-order-ingestion",
      subject: shopifyOrderId,
    }, receivedAt);
    await ingestPaidShopifyOrder(env, payload, payloadSha256, receivedAt, fetcher);
    await env.DB.prepare(`
      UPDATE shopify_webhook_inbox
      SET status = 'processed', processed_at = ?, processing_started_at = NULL,
        last_error = NULL
      WHERE webhook_id = ? AND status = 'processing'
    `).bind(receivedAt, metadata.webhookId).run();
  } catch {
    try {
      await env.DB.prepare(`
        UPDATE shopify_webhook_inbox
        SET status = 'failed', processing_started_at = NULL,
          last_error = 'Paid-order processing failed.'
        WHERE webhook_id = ? AND status = 'processing'
      `).bind(metadata.webhookId).run();
    } catch {
      return dependencyUnavailable();
    }
    return dependencyUnavailable();
  }

  return accepted();
}

function accepted() {
  return Response.json(
    { accepted: true },
    { headers: { "Cache-Control": "no-store" }, status: 202 },
  );
}

function dependencyUnavailable() {
  return apiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Paid-order processing is unavailable.",
  );
}

function paidOrderId(payload: Record<string, unknown>) {
  const value = payload["admin_graphql_api_id"];
  if (typeof value !== "string" ||
      !/^gid:\/\/shopify\/Order\/[0-9]+$/u.test(value)) {
    throw new Error("Shopify paid-order webhook has an invalid order ID.");
  }
  return value;
}

function readWebhookMetadata(headers: Headers) {
  const hmac = headers.get(SHOPIFY_HMAC_HEADER)?.trim();
  const webhookId = headers.get("x-shopify-webhook-id")?.trim();
  const topic = headers.get("x-shopify-topic")?.trim();
  const shopDomain = headers.get("x-shopify-shop-domain")?.trim();
  const apiVersion = headers.get("x-shopify-api-version")?.trim();
  const triggeredAt = headers.get("x-shopify-triggered-at")?.trim() ?? null;
  if (!hmac || !webhookId || !topic || !shopDomain || !apiVersion) {
    return apiError(
      400,
      "INVALID_HEADERS",
      "Required Shopify webhook headers are missing.",
    );
  }
  if (topic !== SHOPIFY_ORDERS_PAID_TOPIC) {
    return apiError(400, "INVALID_TOPIC", "Webhook topic is invalid.");
  }
  if (!isShopifyDomain(shopDomain)) {
    return apiError(400, "INVALID_SHOP", "Webhook shop is invalid.");
  }
  if (
    hmac.length > 128 || webhookId.length > 128 ||
    shopDomain.length > 255 || apiVersion.length > 32 ||
    (triggeredAt?.length ?? 0) > 64
  ) {
    return apiError(400, "INVALID_HEADERS", "Webhook headers are invalid.");
  }
  return { apiVersion, hmac, shopDomain, topic, triggeredAt, webhookId };
}

function declaredContentLength(headers: Headers) {
  const value = headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) {
    return apiError(400, "INVALID_HEADERS", "Content-Length is invalid.");
  }
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0
    ? length
    : apiError(400, "INVALID_HEADERS", "Content-Length is invalid.");
}

async function readBoundedBody(
  request: Request,
  declaredLength: number | undefined,
) {
  if (!request.body) {
    return declaredLength === undefined || declaredLength === 0
      ? new Uint8Array()
      : apiError(400, "INVALID_PAYLOAD", "Webhook payload is truncated.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (
      let item = await reader.read();
      !item.done;
      item = await reader.read()
    ) {
      length += item.value.byteLength;
      if (
        (declaredLength !== undefined && length > declaredLength) ||
        length > MAX_WEBHOOK_BYTES
      ) {
        await reader.cancel();
        return apiError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Webhook payload exceeds its declared length.",
        );
      }
      chunks.push(item.value);
    }
  } catch {
    return apiError(400, "INVALID_PAYLOAD", "Webhook payload is unreadable.");
  }
  if (declaredLength !== undefined && length !== declaredLength) {
    return apiError(400, "INVALID_PAYLOAD", "Webhook payload is truncated.");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function validHmac(
  body: Uint8Array,
  encodedSignature: string,
  secret: string,
) {
  let signature: Uint8Array;
  try {
    const binary = atob(encodedSignature);
    signature = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    copyToArrayBuffer(signature),
    copyToArrayBuffer(body),
  );
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copyToArrayBuffer(bytes),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function copyToArrayBuffer(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function isShopifyDomain(value: string) {
  return !value.includes(":") && !value.includes("/") &&
    value.endsWith(".myshopify.com") &&
    value.length > ".myshopify.com".length;
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
    headers ? { headers, status } : { status },
  );
}
