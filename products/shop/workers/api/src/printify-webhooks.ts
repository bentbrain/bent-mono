import { Schema } from "effect";

import type { IntegrationEnv } from "./integration-config";
import {
  IntegrationConfigError,
  requirePrintifyWebhookConfig,
} from "./integration-config";
import {
  makeShopifyAdminClient,
  ShopifyAdminAmbiguousMutationError,
  ShopifyAdminAuthenticationError,
  ShopifyAdminContractError,
  ShopifyAdminDependencyError,
  ShopifyAdminRateLimitError,
} from "./shopify-admin-client";

export const PRINTIFY_SHIPMENT_WEBHOOK_PATH =
  "/v2/webhooks/printify/order-shipment";

const MAX_WEBHOOK_BYTES = 1_048_576;
const PRINTIFY_SIGNATURE_HEADER = "x-pfy-signature";
const PROCESSING_LEASE_MS = 5 * 60 * 1_000;
const SHIPMENT_LEASE_MS = 2 * 60 * 1_000;
const PARCEL_COLLECTION_MS = 2 * 60 * 1_000;
const NonEmptyText = Schema.String.pipe(Schema.minLength(1));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const IsoDateTime = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value))),
);
const HttpUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }),
);

const CarrierSchema = Schema.Struct({
  code: NonEmptyText,
  tracking_number: NonEmptyText,
  tracking_url: HttpUrl,
});

const ShipmentCreatedDataSchema = Schema.Struct({
  carrier: CarrierSchema,
  shipped_at: IsoDateTime,
  shop_id: PositiveInt,
  skus: Schema.Array(NonEmptyText).pipe(Schema.minItems(1)),
});

const ShipmentDeliveredDataSchema = Schema.Struct({
  carrier: CarrierSchema,
  delivered_at: IsoDateTime,
  shop_id: PositiveInt,
  skus: Schema.Array(NonEmptyText).pipe(Schema.minItems(1)),
});

const ShipmentCreatedEventSchema = Schema.Struct({
  created_at: IsoDateTime,
  id: NonEmptyText,
  resource: Schema.Struct({
    data: ShipmentCreatedDataSchema,
    id: NonEmptyText,
    type: Schema.Literal("order"),
  }),
  type: Schema.Literal("order:shipment:created"),
});

const ShipmentDeliveredEventSchema = Schema.Struct({
  created_at: IsoDateTime,
  id: NonEmptyText,
  resource: Schema.Struct({
    data: ShipmentDeliveredDataSchema,
    id: NonEmptyText,
    type: Schema.Literal("order"),
  }),
  type: Schema.Literal("order:shipment:delivered"),
});

const PrintifyShipmentEventSchema = Schema.Union(
  ShipmentCreatedEventSchema,
  ShipmentDeliveredEventSchema,
);

type PrintifyShipmentEvent = Schema.Schema.Type<
  typeof PrintifyShipmentEventSchema
>;

interface PrintifyWebhookEnv extends IntegrationEnv {
  readonly DB: D1Database;
}

interface StoredInbox {
  readonly payload_sha256: string;
  readonly provider_order_id: string;
  readonly status: "ambiguous" | "failed" | "pending" | "processed" | "processing";
  readonly topic: string;
}

interface StoredOrder {
  readonly fulfilment_order_id: string;
  readonly paid_order_id: string;
  readonly shopify_order_id: string;
  readonly status: string;
}

interface StoredLine {
  readonly id: string;
  readonly paid_order_line_id: string;
  readonly provider_sku: string;
  readonly quantity: number;
  readonly shipped_quantity: number;
  readonly shopify_line_item_id: string;
}

interface ShipmentLine {
  readonly fulfilmentOrderLineId: string;
  readonly quantity: number;
  readonly shopifyLineItemId: string;
}

interface StoredShipment {
  readonly attempt_count: number;
  readonly id: string;
  readonly request_sha256: string;
  readonly shopify_fulfilment_id: string | null;
  readonly status: "ambiguous" | "creating" | "delivered" | "failed" | "pending" | "ready";
}

interface ShipmentSubmission {
  readonly carrier: string;
  readonly deliveredAt: number | null;
  readonly trackingNumber: string;
  readonly trackingUrl: string;
}

interface PendingShipmentRow {
  readonly attempt_count: number;
  readonly carrier: string;
  readonly delivered_at: number | null;
  readonly fulfilment_order_id: string;
  readonly paid_order_id: string;
  readonly request_sha256: string;
  readonly shipment_id: string;
  readonly shipment_status: "failed" | "pending";
  readonly shopify_fulfilment_id: null;
  readonly shopify_order_id: string;
  readonly tracking_number: string;
  readonly tracking_url: string;
}

export interface PrintifyShipmentReconciliationReport {
  readonly candidates: number;
  readonly disabled: boolean;
  readonly exceptions: number;
  readonly fenced: number;
  readonly reconciled: number;
  readonly retried: number;
}

type ShipmentOutcome =
  | { readonly kind: "ambiguous"; readonly code: string }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "processed" };

export async function handlePrintifyWebhookRequest(
  request: Request,
  env: PrintifyWebhookEnv,
  now = () => Date.now(),
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== PRINTIFY_SHIPMENT_WEBHOOK_PATH) return undefined;
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
      Allow: "POST",
    });
  }
  let config: ReturnType<typeof requirePrintifyWebhookConfig>;
  try {
    config = requirePrintifyWebhookConfig(env);
  } catch (error) {
    if (error instanceof IntegrationConfigError) {
      return apiError(
        503,
        "CONFIGURATION_ERROR",
        "Printify webhook verification is unavailable.",
      );
    }
    throw error;
  }
  const declaredLength = declaredContentLength(request.headers);
  if (declaredLength instanceof Response) return declaredLength;
  const body = await readBoundedBody(request, declaredLength);
  if (body instanceof Response) return body;
  const signature = request.headers.get(PRINTIFY_SIGNATURE_HEADER)?.trim();
  if (!signature || !await validSignature(body, signature, config.webhookSecret)) {
    return apiError(401, "INVALID_SIGNATURE", "Webhook signature is invalid.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return apiError(400, "INVALID_PAYLOAD", "Webhook payload is invalid.");
  }
  const decoded = Schema.decodeUnknownEither(PrintifyShipmentEventSchema)(payload);
  if (decoded._tag === "Left") {
    return apiError(400, "INVALID_PAYLOAD", "Webhook payload is invalid.");
  }
  const event = decoded.right;
  if (String(event.resource.data.shop_id) !== config.shopId) {
    return apiError(403, "INVALID_SHOP", "Webhook shop is not authorized.");
  }
  const payloadSha256 = await sha256Hex(body);
  const receivedAt = now();
  const stored = await storeInbox(env.DB, event, payloadSha256, receivedAt);
  if (stored instanceof Response) return stored;
  if (stored.status === "processed" || stored.status === "ambiguous") {
    return accepted();
  }
  const claimed = await claimInbox(env.DB, event.id, receivedAt);
  if (!claimed) return dependencyUnavailable();
  let outcome: ShipmentOutcome;
  try {
    outcome = await processShipmentEvent(env, event, now);
  } catch {
    await failInbox(env.DB, event.id, "SHIPMENT_PROCESSING_FAILED");
    return dependencyUnavailable();
  }
  await finishInbox(env.DB, event.id, outcome, now());
  return outcome.kind === "failed" ? dependencyUnavailable() : accepted();
}

export async function runScheduledPrintifyShipmentReconciliation(
  env: PrintifyWebhookEnv,
  fetcher: typeof fetch = fetch,
  now = () => Date.now(),
): Promise<PrintifyShipmentReconciliationReport> {
  try {
    requirePrintifyWebhookConfig(env);
  } catch (error) {
    if (error instanceof IntegrationConfigError) {
      return {
        candidates: 0,
        disabled: true,
        exceptions: 0,
        fenced: 0,
        reconciled: 0,
        retried: 0,
      };
    }
    throw error;
  }
  const report = {
    candidates: 0,
    disabled: false,
    exceptions: 0,
    fenced: await fenceExpiredShipmentLeases(env.DB, now()),
    reconciled: 0,
    retried: 0,
  };
  const candidates = await env.DB.prepare(`
    SELECT shipment.id AS shipment_id,
      shipment.fulfilment_order_id, shipment.carrier,
      shipment.tracking_number, shipment.tracking_url,
      shipment.delivered_at, shipment.request_sha256,
      shipment.attempt_count,
      shipment.shopify_fulfilment_id,
      shipment.status AS shipment_status,
      fulfilment.paid_order_id, paid.shopify_order_id
    FROM printify_shipments AS shipment
    JOIN printify_fulfilment_orders AS fulfilment
      ON fulfilment.id = shipment.fulfilment_order_id
    JOIN paid_orders AS paid ON paid.id = fulfilment.paid_order_id
    WHERE shipment.status IN ('pending', 'failed')
      AND shipment.lease_id IS NULL
      AND (shipment.attempt_count > 0 OR shipment.updated_at <= ?)
      AND fulfilment.status IN ('in_production', 'fulfilled')
      AND NOT EXISTS (
        SELECT 1 FROM fulfilment_exceptions AS exception
        WHERE exception.paid_order_id = fulfilment.paid_order_id
          AND exception.status = 'open'
      )
    ORDER BY shipment.created_at
    LIMIT 100
  `).bind(now() - PARCEL_COLLECTION_MS).all<PendingShipmentRow>();
  report.candidates = candidates.results.length;
  for (let offset = 0; offset < candidates.results.length; offset += 4) {
    await Promise.all(candidates.results.slice(offset, offset + 4).map(async candidate => {
      const sibling = await env.DB.prepare(`SELECT id FROM printify_shipments
        WHERE fulfilment_order_id = ? AND tracking_number = ? AND id != ? LIMIT 1`)
        .bind(candidate.fulfilment_order_id, candidate.tracking_number, candidate.shipment_id).first();
      if (sibling) {
        await ensureException(env.DB, candidate.paid_order_id, "PRINTIFY_PARCEL_MULTIPLE_BATCHES", now());
        report.exceptions += 1;
        return;
      }
      const lines = await loadShipmentLines(env.DB, candidate.shipment_id);
      if (!lines) {
        await ensureException(
          env.DB,
          candidate.paid_order_id,
          "PRINTIFY_SHIPMENT_LINE_MISMATCH",
          now(),
        );
        report.exceptions += 1;
        return;
      }
      const outcome = await submitShipment(
        env,
        {
          fulfilment_order_id: candidate.fulfilment_order_id,
          paid_order_id: candidate.paid_order_id,
          shopify_order_id: candidate.shopify_order_id,
          status: "in_production",
        },
        {
          attempt_count: candidate.attempt_count,
          id: candidate.shipment_id,
          request_sha256: candidate.request_sha256,
          shopify_fulfilment_id: candidate.shopify_fulfilment_id,
          status: candidate.shipment_status,
        },
        lines,
        {
          carrier: candidate.carrier,
          deliveredAt: candidate.delivered_at,
          trackingNumber: candidate.tracking_number,
          trackingUrl: candidate.tracking_url,
        },
        fetcher,
        now,
      );
      if (outcome.kind === "processed") report.reconciled += 1;
      else if (outcome.kind === "failed") report.retried += 1;
      else report.exceptions += 1;
    }));
  }
  return report;
}

async function fenceExpiredShipmentLeases(db: D1Database, now: number) {
  const results = await db.batch([
    db.prepare(`
      INSERT INTO fulfilment_exceptions (
        id, paid_order_id, code, summary, status, created_at, resolved_at
      )
      SELECT fulfilment.paid_order_id || ':SHOPIFY_FULFILMENT_LEASE_EXPIRED',
        fulfilment.paid_order_id, 'SHOPIFY_FULFILMENT_LEASE_EXPIRED',
        'The Shopify fulfilment lease expired with an unknown mutation result.',
        'open', ?, NULL
      FROM printify_shipments AS shipment
      JOIN printify_fulfilment_orders AS fulfilment
        ON fulfilment.id = shipment.fulfilment_order_id
      WHERE shipment.status = 'creating' AND shipment.lease_expires_at <= ?
      ON CONFLICT (id) DO UPDATE SET summary = excluded.summary,
        status = 'open', resolved_at = NULL
    `).bind(now, now),
    db.prepare(`
      UPDATE printify_shipments
      SET status = 'ambiguous', lease_id = NULL, lease_expires_at = NULL,
        last_error_code = 'SHOPIFY_FULFILMENT_LEASE_EXPIRED', updated_at = ?
      WHERE status = 'creating' AND lease_expires_at <= ?
    `).bind(now, now),
  ]);
  return results[1]?.meta.changes ?? 0;
}

async function processShipmentEvent(
  env: PrintifyWebhookEnv,
  event: PrintifyShipmentEvent,
  now: () => number,
): Promise<ShipmentOutcome> {
  const order = await env.DB.prepare(`
    SELECT fulfilment.id AS fulfilment_order_id,
      fulfilment.paid_order_id, fulfilment.status,
      paid.shopify_order_id
    FROM printify_fulfilment_orders AS fulfilment
    JOIN paid_orders AS paid ON paid.id = fulfilment.paid_order_id
    WHERE fulfilment.provider_order_id = ?
  `).bind(event.resource.id).first<StoredOrder>();
  if (!order || !["in_production", "fulfilled"].includes(order.status)) {
    return ensureException(
      env.DB,
      order?.paid_order_id,
      "PRINTIFY_SHIPMENT_ORDER_MISMATCH",
      now(),
    );
  }
  const rows = await env.DB.prepare(`
    SELECT fulfilment_line.id, fulfilment_line.paid_order_line_id,
      fulfilment_line.provider_sku, fulfilment_line.quantity,
      fulfilment_line.shipped_quantity, paid_line.shopify_line_item_id
    FROM printify_fulfilment_order_lines AS fulfilment_line
    JOIN paid_order_lines AS paid_line
      ON paid_line.id = fulfilment_line.paid_order_line_id
    WHERE fulfilment_line.fulfilment_order_id = ?
    ORDER BY paid_line.line_position
  `).bind(order.fulfilment_order_id).all<StoredLine>();
  const shipments = await env.DB.prepare(`
    SELECT id, request_sha256, shopify_fulfilment_id, status, attempt_count,
      carrier, tracking_number, tracking_url
    FROM printify_shipments WHERE fulfilment_order_id = ?
    ORDER BY created_at, id
  `).bind(order.fulfilment_order_id).all<StoredShipment & {
    carrier: string; tracking_number: string; tracking_url: string;
  }>();
  const existing = await Promise.all(shipments.results.map(async shipment => ({
    shipment, lines: await loadShipmentLines(env.DB, shipment.id),
  })));
  const selected = mapShipmentLines(event.resource.data.skus, rows.results);
  if (!selected || existing.some(batch => !batch.lines)) {
    return ensureException(env.DB, order.paid_order_id,
      "PRINTIFY_SHIPMENT_LINE_MISMATCH", now());
  }
  const affected = new Set<string>();
  const unreserved: ShipmentLine[] = [];
  for (const line of selected) {
    const matches = existing.filter(batch => batch.lines?.some(stored =>
      stored.fulfilmentOrderLineId === line.fulfilmentOrderLineId));
    if (matches.length === 0) {
      const stored = rows.results.find(row => row.id === line.fulfilmentOrderLineId);
      if (stored?.shipped_quantity !== 0) {
        return ensureException(env.DB, order.paid_order_id,
          "PRINTIFY_SHIPMENT_LINE_MISMATCH", now());
      }
      unreserved.push(line);
      continue;
    }
    const batch = matches[0];
    if (matches.length !== 1 ||
        batch?.shipment.tracking_number !== event.resource.data.carrier.tracking_number ||
        batch.shipment.carrier !== event.resource.data.carrier.code ||
        batch.shipment.tracking_url !== event.resource.data.carrier.tracking_url ||
        !batch.lines?.some(stored => stored.fulfilmentOrderLineId === line.fulfilmentOrderLineId &&
          stored.quantity === line.quantity)) {
      return ensureException(env.DB, order.paid_order_id,
        "PRINTIFY_SHIPMENT_DUPLICATE_MISMATCH", now());
    }
    affected.add(batch.shipment.id);
  }
  // A parcel remains mutable until its first Shopify attempt. Separate item
  // events extend that parcel; only the scheduled reconciler sends its email.
  const batches: StoredShipment[] = existing.filter(batch => affected.has(batch.shipment.id))
    .map(batch => batch.shipment);
  if (unreserved.length > 0) {
    const parcel = existing.filter(batch =>
      batch.shipment.tracking_number === event.resource.data.carrier.tracking_number);
    if (parcel.some(batch => batch.shipment.carrier !== event.resource.data.carrier.code ||
        batch.shipment.tracking_url !== event.resource.data.carrier.tracking_url)) {
      return ensureException(env.DB, order.paid_order_id,
        "PRINTIFY_SHIPMENT_DUPLICATE_MISMATCH", now());
    }
    const current = parcel[0];
    if (parcel.length > 1 || (current &&
        (current.shipment.attempt_count !== 0 || current.shipment.status !== "pending"))) {
      return ensureException(env.DB, order.paid_order_id,
        "PRINTIFY_PARCEL_LINES_AFTER_SUBMISSION", now());
    }
    const combined = [...(current?.lines ?? []), ...unreserved]
      .sort((left, right) => left.fulfilmentOrderLineId.localeCompare(right.fulfilmentOrderLineId));
    const hash = await sha256Text(JSON.stringify(shipmentEventIdentity(event, combined)));
    if (current) {
      await appendParcelLines(env.DB, order.fulfilment_order_id, current.shipment, unreserved, hash, now());
      batches.push(current.shipment);
    } else {
      batches.push(await createShipment(env.DB, order.fulfilment_order_id, event, unreserved, hash, now()));
    }
  }
  for (const shipment of batches) {
    if (shipment.status === "ambiguous") {
      return { kind: "ambiguous", code: "SHOPIFY_FULFILMENT_AMBIGUOUS" };
    }
    if (event.type === "order:shipment:delivered") {
      await markShipmentDelivered(env.DB, shipment.id, event, now());
    }
  }
  return { kind: "processed" };
}

async function submitShipment(
  env: PrintifyWebhookEnv,
  order: StoredOrder,
  shipment: StoredShipment,
  shipmentLines: readonly ShipmentLine[],
  submission: ShipmentSubmission,
  fetcher: typeof fetch,
  now: () => number,
): Promise<ShipmentOutcome> {
  const leaseId = crypto.randomUUID();
  const claimed = await env.DB.prepare(`
    UPDATE printify_shipments
    SET status = 'creating', lease_id = ?, lease_expires_at = ?,
      attempt_count = attempt_count + 1, last_error_code = NULL,
      updated_at = ?
    WHERE id = ? AND status IN ('pending', 'failed') AND lease_id IS NULL
      AND request_sha256 = ?
      AND (attempt_count > 0 OR updated_at <= ?)
      AND NOT EXISTS (SELECT 1 FROM printify_shipments sibling
        WHERE sibling.fulfilment_order_id = printify_shipments.fulfilment_order_id
          AND sibling.tracking_number = printify_shipments.tracking_number
          AND sibling.id != printify_shipments.id)
  `).bind(
    leaseId,
    now() + SHIPMENT_LEASE_MS,
    now(),
    shipment.id,
    shipment.request_sha256,
    now() - PARCEL_COLLECTION_MS,
  ).run();
  if (claimed.meta.changes !== 1) {
    return { kind: "failed", code: "SHOPIFY_FULFILMENT_BUSY" };
  }
  const shopify = makeShopifyAdminClient(env, fetcher);
  try {
    const result = await shopify.createFulfilment(order.shopify_order_id, {
      carrier: submission.carrier,
      lines: shipmentLines.map((line) => ({
        quantity: line.quantity,
        shopifyLineItemId: line.shopifyLineItemId,
      })),
      trackingNumber: submission.trackingNumber,
      trackingUrl: submission.trackingUrl,
    });
    await env.DB.prepare(`
      UPDATE printify_shipments
      SET status = CASE WHEN COALESCE(delivered_at, ?) IS NULL THEN 'ready' ELSE 'delivered' END,
        shopify_fulfilment_id = ?, lease_id = NULL,
        lease_expires_at = NULL, last_error_code = NULL, updated_at = ?,
        delivered_at = COALESCE(delivered_at, ?)
      WHERE id = ? AND lease_id = ? AND status = 'creating'
    `).bind(
      submission.deliveredAt,
      result.id,
      now(),
      submission.deliveredAt,
      shipment.id,
      leaseId,
    ).run();
    await finalizeOrderIfShipped(env.DB, order, now());
    return { kind: "processed" };
  } catch (error) {
    if (error instanceof ShopifyAdminAmbiguousMutationError) {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE printify_shipments
          SET status = 'ambiguous', lease_id = NULL, lease_expires_at = NULL,
            last_error_code = 'SHOPIFY_FULFILMENT_AMBIGUOUS', updated_at = ?
          WHERE id = ? AND lease_id = ?
        `).bind(now(), shipment.id, leaseId),
        exceptionStatement(
          env.DB,
          order.paid_order_id,
          "SHOPIFY_FULFILMENT_AMBIGUOUS",
          "The Shopify fulfilment result is unknown and requires reconciliation.",
          now(),
        ),
      ]);
      return { kind: "ambiguous", code: "SHOPIFY_FULFILMENT_AMBIGUOUS" };
    }
    if (error instanceof ShopifyAdminDependencyError ||
        error instanceof ShopifyAdminRateLimitError) {
      await resetShipment(env.DB, shipment.id, leaseId, error.name, now());
      return { kind: "failed", code: "SHOPIFY_FULFILMENT_RETRY" };
    }
    const code = error instanceof ShopifyAdminAuthenticationError
      ? "SHOPIFY_FULFILMENT_AUTHENTICATION"
      : error instanceof ShopifyAdminContractError
        ? "SHOPIFY_FULFILMENT_MISMATCH"
        : "SHOPIFY_FULFILMENT_FAILED";
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE printify_shipments
        SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
          last_error_code = ?, updated_at = ?
        WHERE id = ? AND lease_id = ?
      `).bind(code, now(), shipment.id, leaseId),
      exceptionStatement(
        env.DB,
        order.paid_order_id,
        code,
        "The Printify shipment could not be mapped into Shopify.",
        now(),
      ),
    ]);
    return { kind: "ambiguous", code };
  }
}

async function loadShipmentLines(
  db: D1Database,
  shipmentId: string,
): Promise<readonly ShipmentLine[] | undefined> {
  const rows = await db.prepare(`
    SELECT shipment_line.fulfilment_order_line_id,
      shipment_line.quantity, paid_line.shopify_line_item_id
    FROM printify_shipment_lines AS shipment_line
    JOIN printify_fulfilment_order_lines AS fulfilment_line
      ON fulfilment_line.id = shipment_line.fulfilment_order_line_id
    JOIN paid_order_lines AS paid_line
      ON paid_line.id = fulfilment_line.paid_order_line_id
    WHERE shipment_line.shipment_id = ?
    ORDER BY fulfilment_line.created_at, fulfilment_line.id
  `).bind(shipmentId).all<{
    fulfilment_order_line_id: string;
    quantity: number;
    shopify_line_item_id: string;
  }>();
  const lines = rows.results.map((row) => ({
    fulfilmentOrderLineId: row.fulfilment_order_line_id,
    quantity: row.quantity,
    shopifyLineItemId: row.shopify_line_item_id,
  }));
  return lines.length > 0 ? lines : undefined;
}

function mapShipmentLines(
  skus: readonly string[],
  storedLines: readonly StoredLine[],
): readonly ShipmentLine[] | undefined {
  const storedBySku = new Map(storedLines.map((line) => [line.provider_sku, line]));
  const selected: ShipmentLine[] = [];
  for (const sku of new Set(skus)) {
    const stored = storedBySku.get(sku);
    const quantity = stored?.quantity ?? 0;
    if (!stored || quantity <= 0) {
      return undefined;
    }
    selected.push({
      fulfilmentOrderLineId: stored.id,
      quantity,
      shopifyLineItemId: stored.shopify_line_item_id,
    });
  }
  return selected.length > 0
    ? selected.sort((left, right) => left.fulfilmentOrderLineId.localeCompare(right.fulfilmentOrderLineId))
    : undefined;
}

async function appendParcelLines(
  db: D1Database,
  fulfilmentOrderId: string,
  shipment: StoredShipment,
  lines: readonly ShipmentLine[],
  requestSha256: string,
  now: number,
) {
  // The hash is an optimistic version. A concurrent append or scheduler claim
  // makes the whole conditional batch a no-op, so the webhook can retry safely.
  const results = await db.batch([
    db.prepare(`UPDATE printify_shipments SET request_sha256 = ?, updated_at = ?
      WHERE id = ? AND request_sha256 = ? AND status = 'pending' AND attempt_count = 0`)
      .bind(requestSha256, now, shipment.id, shipment.request_sha256),
    ...lines.flatMap(line => [
      db.prepare(`INSERT INTO printify_shipment_lines (shipment_id, fulfilment_order_line_id, quantity)
        SELECT id, ?, ? FROM printify_shipments
        WHERE id = ? AND request_sha256 = ? AND status = 'pending' AND attempt_count = 0`)
        .bind(line.fulfilmentOrderLineId, line.quantity, shipment.id, requestSha256),
      db.prepare(`UPDATE printify_fulfilment_order_lines SET shipped_quantity = shipped_quantity + ?
        WHERE id = ? AND fulfilment_order_id = ? AND EXISTS (
          SELECT 1 FROM printify_shipments WHERE id = ? AND request_sha256 = ?
            AND status = 'pending' AND attempt_count = 0)`)
        .bind(line.quantity, line.fulfilmentOrderLineId, fulfilmentOrderId, shipment.id, requestSha256),
    ]),
  ]);
  if (results.some(result => result.meta.changes !== 1)) throw new Error("Parcel collection changed; retry the event.");
}

async function createShipment(
  db: D1Database,
  fulfilmentOrderId: string,
  event: PrintifyShipmentEvent,
  lines: readonly ShipmentLine[],
  requestSha256: string,
  now: number,
) {
  const id = await sha256Text(JSON.stringify([fulfilmentOrderId, event.resource.data.carrier.tracking_number]));
  const shippedAt = event.type === "order:shipment:created"
    ? Date.parse(event.resource.data.shipped_at)
    : Date.parse(event.created_at);
  const deliveredAt = event.type === "order:shipment:delivered"
    ? Date.parse(event.resource.data.delivered_at)
    : null;
  const results = await db.batch([
    db.prepare(`
      INSERT INTO printify_shipments (
        id, fulfilment_order_id, carrier, tracking_number, tracking_url,
        shipped_at, delivered_at, request_sha256, status, attempt_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).bind(
      id,
      fulfilmentOrderId,
      event.resource.data.carrier.code,
      event.resource.data.carrier.tracking_number,
      event.resource.data.carrier.tracking_url,
      shippedAt,
      deliveredAt,
      requestSha256,
      now,
      now,
    ),
    ...lines.flatMap((line) => [
      db.prepare(`
        INSERT INTO printify_shipment_lines (
          shipment_id, fulfilment_order_line_id, quantity
        ) VALUES (?, ?, ?)
      `).bind(id, line.fulfilmentOrderLineId, line.quantity),
      db.prepare(`
        UPDATE printify_fulfilment_order_lines
        SET shipped_quantity = shipped_quantity + ?
        WHERE id = ? AND fulfilment_order_id = ?
      `).bind(line.quantity, line.fulfilmentOrderLineId, fulfilmentOrderId),
    ]),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error("Shipment reservation failed.");
  }
  return {
    attempt_count: 0,
    id,
    request_sha256: requestSha256,
    shopify_fulfilment_id: null,
    status: "pending",
  } satisfies StoredShipment;
}

async function markShipmentDelivered(
  db: D1Database,
  shipmentId: string,
  event: Extract<PrintifyShipmentEvent, { readonly type: "order:shipment:delivered" }>,
  now: number,
) {
  await db.prepare(`
    UPDATE printify_shipments
    SET status = CASE WHEN shopify_fulfilment_id IS NULL THEN status ELSE 'delivered' END,
      delivered_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(Date.parse(event.resource.data.delivered_at), now, shipmentId).run();
}

async function finalizeOrderIfShipped(
  db: D1Database,
  order: StoredOrder,
  now: number,
) {
  const remaining = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM printify_fulfilment_order_lines AS line
    WHERE line.fulfilment_order_id = ? AND (
      line.shipped_quantity < line.quantity OR NOT EXISTS (
        SELECT 1 FROM printify_shipment_lines AS shipment_line
        JOIN printify_shipments AS shipment ON shipment.id = shipment_line.shipment_id
        WHERE shipment_line.fulfilment_order_line_id = line.id
          AND shipment.status IN ('ready', 'delivered')
          AND shipment.shopify_fulfilment_id IS NOT NULL
      )
    )
  `).bind(order.fulfilment_order_id).first<{ count: number }>();
  if (remaining?.count !== 0) return;
  await db.batch([
    db.prepare(`
      UPDATE printify_fulfilment_orders
      SET status = 'fulfilled', fulfilled_at = ?, updated_at = ?
      WHERE id = ? AND status = 'in_production'
    `).bind(now, now, order.fulfilment_order_id),
    db.prepare(`
      UPDATE paid_orders SET status = 'fulfilled', updated_at = ?
      WHERE id = ? AND status = 'fulfilment_locked'
    `).bind(now, order.paid_order_id),
  ]);
}

async function storeInbox(
  db: D1Database,
  event: PrintifyShipmentEvent,
  payloadSha256: string,
  receivedAt: number,
) {
  try {
    await db.prepare(`
      INSERT INTO printify_webhook_inbox (
        event_id, topic, provider_order_id, payload_sha256, status,
        attempt_count, received_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?)
      ON CONFLICT (event_id) DO NOTHING
    `).bind(
      event.id,
      event.type,
      event.resource.id,
      payloadSha256,
      receivedAt,
    ).run();
    const stored = await db.prepare(`
      SELECT topic, provider_order_id, payload_sha256, status
      FROM printify_webhook_inbox WHERE event_id = ?
    `).bind(event.id).first<StoredInbox>();
    if (stored?.topic !== event.type ||
        stored.provider_order_id !== event.resource.id ||
        stored.payload_sha256 !== payloadSha256) {
      return apiError(
        409,
        "WEBHOOK_ID_CONFLICT",
        "Webhook identifier conflicts with an existing delivery.",
      );
    }
    return stored;
  } catch {
    return dependencyUnavailable();
  }
}

async function claimInbox(db: D1Database, eventId: string, now: number) {
  const result = await db.prepare(`
    UPDATE printify_webhook_inbox
    SET status = 'processing', attempt_count = attempt_count + 1,
      processing_started_at = ?, last_error_code = NULL
    WHERE event_id = ? AND (
      status IN ('pending', 'failed') OR
      (status = 'processing' AND processing_started_at < ?)
    )
  `).bind(now, eventId, now - PROCESSING_LEASE_MS).run();
  return result.meta.changes === 1;
}

async function finishInbox(
  db: D1Database,
  eventId: string,
  outcome: ShipmentOutcome,
  now: number,
) {
  await db.prepare(`
    UPDATE printify_webhook_inbox
    SET status = ?, processing_started_at = NULL, processed_at = ?,
      last_error_code = ?
    WHERE event_id = ? AND status = 'processing'
  `).bind(
    outcome.kind,
    outcome.kind === "failed" ? null : now,
    outcome.kind === "processed" ? null : outcome.code,
    eventId,
  ).run();
}

async function failInbox(
  db: D1Database,
  eventId: string,
  code: string,
) {
  await db.prepare(`
    UPDATE printify_webhook_inbox
    SET status = 'failed', processing_started_at = NULL,
      last_error_code = ?
    WHERE event_id = ? AND status = 'processing'
  `).bind(code, eventId).run();
}

async function resetShipment(
  db: D1Database,
  shipmentId: string,
  leaseId: string,
  code: string,
  now: number,
) {
  await db.prepare(`
    UPDATE printify_shipments
    SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
      last_error_code = ?, updated_at = ?
    WHERE id = ? AND lease_id = ?
  `).bind(code, now, shipmentId, leaseId).run();
}

async function ensureException(
  db: D1Database,
  paidOrderId: string | undefined,
  code: string,
  now: number,
): Promise<ShipmentOutcome> {
  if (paidOrderId) {
    await exceptionStatement(
      db,
      paidOrderId,
      code,
      "The Printify shipment does not match its locked order.",
      now,
    ).run();
  }
  return { kind: "ambiguous", code };
}

function exceptionStatement(
  db: D1Database,
  paidOrderId: string,
  code: string,
  summary: string,
  now: number,
) {
  return db.prepare(`
    INSERT INTO fulfilment_exceptions (
      id, paid_order_id, code, summary, status, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, 'open', ?, NULL)
    ON CONFLICT (id) DO UPDATE SET summary = excluded.summary,
      status = 'open', resolved_at = NULL
  `).bind(`${paidOrderId}:${code}`, paidOrderId, code, summary, now);
}

function shipmentEventIdentity(
  event: PrintifyShipmentEvent,
  lines: readonly ShipmentLine[],
) {
  return {
    carrier: event.resource.data.carrier,
    lines: lines.map((line) => ({
      fulfilmentOrderLineId: line.fulfilmentOrderLineId,
      quantity: line.quantity,
    })),
    providerOrderId: event.resource.id,
  };
}

async function validSignature(
  body: Uint8Array<ArrayBuffer>,
  supplied: string,
  secret: string,
) {
  if (!/^sha256=[0-9a-f]{64}$/u.test(supplied)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, body);
  const expected = `sha256=${bytesToHex(new Uint8Array(digest))}`;
  const suppliedBytes = new TextEncoder().encode(supplied);
  const expectedBytes = new TextEncoder().encode(expected);
  if (suppliedBytes.length !== expectedBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < suppliedBytes.length; index += 1) {
    difference |= (suppliedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

function declaredContentLength(headers: Headers) {
  const value = headers.get("content-length");
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) {
    return apiError(400, "INVALID_HEADERS", "Content-Length is invalid.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    return apiError(400, "INVALID_HEADERS", "Content-Length is invalid.");
  }
  if (length > MAX_WEBHOOK_BYTES) {
    return apiError(413, "PAYLOAD_TOO_LARGE", "Webhook payload is too large.");
  }
  return length;
}

async function readBoundedBody(
  request: Request,
  declaredLength: number | undefined,
) {
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_WEBHOOK_BYTES) {
    return apiError(413, "PAYLOAD_TOO_LARGE", "Webhook payload is too large.");
  }
  if (declaredLength !== undefined && declaredLength !== body.byteLength) {
    return apiError(400, "INVALID_PAYLOAD", "Webhook payload is truncated.");
  }
  return body;
}

function accepted() {
  return Response.json(
    { accepted: true },
    { headers: { "Cache-Control": "no-store" }, status: 200 },
  );
}

function dependencyUnavailable() {
  return apiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Shipment processing is unavailable.",
  );
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(
    { error: { code, message } },
    { headers: responseHeaders, status },
  );
}

async function sha256Hex(value: Uint8Array<ArrayBuffer>) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function sha256Text(value: string) {
  return sha256Hex(new TextEncoder().encode(value));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
