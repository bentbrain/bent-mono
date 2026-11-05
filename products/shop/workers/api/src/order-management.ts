import { ManagedOrder, OrderManagementCommand } from "@forever-tee/contracts";
import { Either, Schema } from "effect";
import type { IntegrationEnv } from "./integration-config";
import { isAuthenticatedServiceRequest } from "./service-auth";
import { makeShopifyAdminClient, ShopifyAdminContractError } from "./shopify-admin-client";

export const ORDER_MANAGEMENT_PATH = "/v2/internal/manage-order";
interface ManagementEnv extends IntegrationEnv {
  readonly DB: D1Database;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
}
interface OrderRow {
  readonly id: string;
  readonly shopify_order_id: string;
  readonly shopify_order_name: string;
  readonly order_management_capability_hash: string;
  readonly status: string;
  readonly production_hold_expires_at: number;
  readonly total_minor_units: number;
  readonly currency_code: string;
  readonly revoked_at: number | null;
  readonly expires_at: number;
}
interface CommandRow {
  readonly id: string;
  readonly paid_order_id: string;
  readonly operation: "address" | "cancel";
  readonly request_sha256: string;
  readonly status: "pending" | "processing" | "succeeded" | "rejected" | "ambiguous";
  readonly shopify_job_id: string | null;
  readonly created_at: number;
}
const json = (body: unknown, status = 200) => Response.json(body, {status, headers: {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"}});
const unavailable = () => json({error: "ORDER_UNAVAILABLE", message: "This order link has expired or is unavailable. Contact support@bent.build."}, 410);
const receipt = (row: CommandRow) => json({commandId: row.id, status: row.status}, row.status === "pending" || row.status === "processing" ? 202 : 200);
const leaseMs = 120_000;

export async function handleOrderManagementRequest(request: Request, env: ManagementEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== ORDER_MANAGEMENT_PATH) return;
  if (!['GET', 'POST'].includes(request.method)) return json({error: "METHOD_NOT_ALLOWED"}, 405);
  if (!await isAuthenticatedServiceRequest(request, env)) return json({error: "UNAUTHORIZED"}, 401);
  const capability = request.headers.get("x-order-management-capability");
  if (!capability || !/^[A-Za-z0-9_-]{43}$/u.test(capability)) return unavailable();
  const hash = await sha256(capability);
  const order = await env.DB.prepare(`SELECT orders.*, capability.revoked_at, capability.expires_at
    FROM paid_orders orders JOIN order_management_capabilities capability ON capability.token_hash = orders.order_management_capability_hash
    WHERE capability.token_hash = ? AND capability.bound_at IS NOT NULL`).bind(hash).first<OrderRow>();
  if (!order) return unavailable();
  const checkedAt = now();
  if (request.method === "GET") {
    if (!editable(order, checkedAt)) return unavailable();
    try {
      const shopify = makeShopifyAdminClient(env, fetcher);
      const current = await shopify.loadManagedOrder(order.shopify_order_id);
      await audit(env.DB, order.id, "customer:capability", "read", now());
      if (current.cancelledAt !== null || current.financialStatus !== "PAID") return unavailable();
      const rawAddress = current.address;
      const decoded = Schema.decodeUnknownEither(ManagedOrder)({orderName: order.shopify_order_name, deadline: new Date(order.production_hold_expires_at).toISOString(), serverTime: new Date(now()).toISOString(), totalMinorUnits: order.total_minor_units, currencyCode: order.currency_code, address: rawAddress, addressValidation: current.addressValidationResult});
      if (Either.isLeft(decoded)) return json({error: "ORDER_READ_UNAVAILABLE"}, 503);
      const stillOpen = await env.DB.prepare(`SELECT 1 AS open FROM paid_orders orders JOIN order_management_capabilities capability ON capability.token_hash = orders.order_management_capability_hash
        WHERE orders.id = ? AND orders.fulfilment_locked_at IS NULL AND orders.status IN ('production_hold','exception_review') AND orders.production_hold_expires_at > ? AND capability.revoked_at IS NULL AND capability.expires_at > ?`).bind(order.id, now(), now()).first();
      if (!stillOpen) return unavailable();
      // No order state, capability, or lease changes on GET. Only the required
      // protected-data access audit is appended.
      return json(decoded.right);
    } catch { return json({error: "ORDER_READ_UNAVAILABLE"}, 503); }
  }
  if (!request.headers.get("content-type")?.includes("application/json")) return json({error: "JSON_REQUIRED"}, 415);
  const body = await request.text();
  if (body.length > 4000) return json({error: "INVALID_REQUEST"}, 400);
  let value: unknown;
  try { value = JSON.parse(body); } catch { return json({error: "INVALID_REQUEST"}, 400); }
  const decoded = Schema.decodeUnknownEither(OrderManagementCommand, {onExcessProperty: "error"})(value);
  if (Either.isLeft(decoded)) return json({error: "INVALID_REQUEST"}, 400);
  const input = decoded.right;
  const requestHash = await sha256(JSON.stringify(input));
  const previous = await env.DB.prepare("SELECT * FROM order_management_commands WHERE id = ?").bind(input.commandId).first<CommandRow>();
  if (previous) {
    if (previous.paid_order_id !== order.id || previous.request_sha256 !== requestHash) return json({error: "COMMAND_CONFLICT"}, 409);
    return receipt(previous);
  }
  if (!editable(order, checkedAt)) return unavailable();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO order_management_commands(id, paid_order_id, operation, request_sha256, status, created_at, updated_at)
      SELECT ?, id, ?, ?, 'pending', ?, ? FROM paid_orders
      WHERE id = ? AND status IN ('production_hold','exception_review') AND fulfilment_locked_at IS NULL
        AND production_hold_expires_at > ? AND (production_lease_id IS NULL OR production_lease_expires_at <= ?)
        AND EXISTS (SELECT 1 FROM order_management_capabilities WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?)
        AND NOT EXISTS (SELECT 1 FROM order_management_commands WHERE paid_order_id = paid_orders.id AND status IN ('pending','processing','ambiguous'))
      ON CONFLICT(id) DO NOTHING`).bind(input.commandId, input.operation, requestHash, checkedAt, checkedAt, order.id, checkedAt, checkedAt, hash, checkedAt),
    env.DB.prepare(`UPDATE paid_orders SET production_lease_id = ?, production_lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM order_management_commands WHERE id = ? AND status = 'pending')`).bind(input.commandId, checkedAt + leaseMs, checkedAt, order.id, input.commandId),
    env.DB.prepare(`INSERT INTO fulfilment_exceptions(id, paid_order_id, code, summary, status, created_at)
      SELECT ? || ':ORDER_MANAGEMENT_PENDING', ?, 'ORDER_MANAGEMENT_PENDING', 'A customer order change requires completion or review.', 'open', ?
      WHERE EXISTS (SELECT 1 FROM order_management_commands WHERE id = ? AND status = 'pending')
      ON CONFLICT(id) DO UPDATE SET status = 'open', resolved_at = NULL`).bind(order.id, order.id, checkedAt, input.commandId),
    env.DB.prepare(`UPDATE order_management_capabilities SET revoked_at = ? WHERE token_hash = ? AND ? = 'cancel'
      AND EXISTS (SELECT 1 FROM order_management_commands WHERE id = ? AND status = 'pending')`).bind(checkedAt, hash, input.operation, input.commandId),
    env.DB.prepare("UPDATE order_management_commands SET status = 'processing' WHERE id = ? AND status = 'pending'").bind(input.commandId),
  ]);
  if (results[0]?.meta.changes !== 1) return json({error: "ORDER_BUSY", message: "The order is being checked or changed. Try again shortly."}, 409);
  try {
    await audit(env.DB, order.id, "customer:capability", input.operation, now());
    const shopify = makeShopifyAdminClient(env, fetcher);
    if (input.operation === "address") {
      await shopify.updateOrderAddress(order.shopify_order_id, input.address);
      await finishAddress(env.DB, order.id, input.commandId, "succeeded", now());
      return json({commandId: input.commandId, status: "succeeded"});
    }
    const jobId = await shopify.cancelAndRefundOrder(order.shopify_order_id);
    await env.DB.prepare("UPDATE order_management_commands SET shopify_job_id = ?, updated_at = ? WHERE id = ? AND status = 'processing'").bind(jobId, now(), input.commandId).run();
    return json({commandId: input.commandId, status: "processing"}, 202);
  } catch (error) {
    const rejected = error instanceof ShopifyAdminContractError;
    if (input.operation === "address" && rejected) await finishAddress(env.DB, order.id, input.commandId, "rejected", now());
    else await env.DB.prepare("UPDATE order_management_commands SET status = ?, updated_at = ? WHERE id = ?").bind(rejected ? "rejected" : "ambiguous", now(), input.commandId).run();
    return json({commandId: input.commandId, status: rejected ? "rejected" : "ambiguous"});
  }
}
function editable(order: OrderRow, now: number) {
  return order.revoked_at === null && order.expires_at > now && order.production_hold_expires_at > now && ['production_hold','exception_review'].includes(order.status);
}
async function finishAddress(db: D1Database, orderId: string, commandId: string, status: "succeeded" | "rejected", now: number) {
  await db.batch([
    db.prepare("UPDATE order_management_commands SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'").bind(status, now, now, commandId),
    db.prepare(`UPDATE paid_orders SET production_lease_id = NULL, production_lease_expires_at = NULL, address_validation_result = 'pending', updated_at = ? WHERE id = ? AND production_lease_id = ?`).bind(now, orderId, commandId),
    db.prepare("UPDATE fulfilment_exceptions SET status = 'resolved', resolved_at = ? WHERE id = ?").bind(now, `${orderId}:ORDER_MANAGEMENT_PENDING`),
  ]);
}
export async function reconcileOrderManagement(env: ManagementEnv, fetcher: typeof fetch = fetch, now = () => Date.now()) {
  // A crash during an address change has an unknown provider outcome. Never
  // replay the mutation or allow lease expiry to release production.
  await env.DB.prepare(`UPDATE order_management_commands SET status = 'ambiguous', updated_at = ? WHERE operation = 'address' AND status IN ('pending','processing') AND updated_at < ?`).bind(now(), now() - leaseMs).run();
  const commands = await env.DB.prepare(`SELECT commands.*, orders.shopify_order_id, orders.total_minor_units, orders.currency_code
    FROM order_management_commands commands JOIN paid_orders orders ON orders.id = commands.paid_order_id
    WHERE commands.operation = 'cancel' AND commands.status IN ('processing','ambiguous') ORDER BY commands.updated_at LIMIT 25`).all<CommandRow & {shopify_order_id: string; total_minor_units: number; currency_code: string}>();
  if (!commands.results.length) return;
  const shopify = makeShopifyAdminClient(env, fetcher);
  for (const command of commands.results) {
    try {
      const result = await shopify.loadRefundState(command.shopify_order_id);
      await audit(env.DB, command.paid_order_id, "system:order-management", "refund-read", now());
      if (result.cancelledAt === null || result.financialStatus !== "REFUNDED" || result.currencyCode !== command.currency_code || result.refundedMinorUnits !== command.total_minor_units) continue;
      await env.DB.batch([
        env.DB.prepare("UPDATE order_management_commands SET status = 'succeeded', updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('processing','ambiguous')").bind(now(), now(), command.id),
        env.DB.prepare("UPDATE paid_orders SET status = 'refunded', production_lease_id = NULL, production_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND fulfilment_locked_at IS NULL").bind(now(), command.paid_order_id),
        env.DB.prepare("UPDATE fulfilment_exceptions SET status = 'resolved', resolved_at = ? WHERE id = ?").bind(now(), `${command.paid_order_id}:ORDER_MANAGEMENT_PENDING`),
      ]);
    } catch { /* Retain the exception; never retry the refund mutation. */ }
  }
}
async function audit(db: D1Database, orderId: string, actor: "customer:capability" | "system:order-management", action: "read" | "address" | "cancel" | "refund-read", now: number) {
  await db.prepare("INSERT INTO order_management_access_log(id, subject_hash, actor, action, occurred_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), await sha256(orderId), actor, action, now).run();
}
async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
