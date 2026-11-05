import { verifyOperationsIdentity, type OperationsIdentityEnv } from "./operations-identity";
import { isAuthenticatedOperationsRequest } from "./service-auth";

export const PRODUCT_LIFECYCLE_PATH = "/v2/internal/operations/product-lifecycle";
type ProductState = "active" | "suspended" | "unpublished" | "retired";
interface LifecycleEnv extends OperationsIdentityEnv {
  readonly DB: D1Database;
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
}
interface TransitionInput {
  readonly commandId: string;
  readonly productId: string;
  readonly from: ProductState;
  readonly to: ProductState;
  readonly reason: string;
  readonly confirmation: string | undefined;
}
interface RecordedTransition {
  readonly command_id: string;
  readonly product_id: string;
  readonly from_status: ProductState;
  readonly to_status: ProductState;
  readonly actor: string;
  readonly actor_id: string;
  readonly run_id: string;
  readonly reason: string;
  readonly request_body: string;
  readonly applied_at: number | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const state = (value: unknown): value is ProductState =>
  value === "active" || value === "suspended" || value === "unpublished" || value === "retired";
function parseInput(value: unknown): TransitionInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  if (!("commandId" in value) || typeof value.commandId !== "string" || !uuid.test(value.commandId) ||
      !("productId" in value) || typeof value.productId !== "string" || !uuid.test(value.productId) ||
      !("from" in value) || !state(value.from) || !("to" in value) || !state(value.to) ||
      !("reason" in value) || typeof value.reason !== "string" || value.reason.trim().length < 5 || value.reason.length > 200) return;
  if (Object.keys(value).some(key => !["commandId", "productId", "from", "to", "reason", "confirmation"].includes(key))) return;
  const confirmation = "confirmation" in value && typeof value.confirmation === "string" ? value.confirmation : undefined;
  return { commandId: value.commandId, productId: value.productId, from: value.from, to: value.to, reason: value.reason.trim(), confirmation };
}
function allowed(from: ProductState, to: ProductState) {
  return (from === "active" && (to === "suspended" || to === "unpublished")) ||
    (from === "suspended" && (to === "active" || to === "unpublished")) ||
    (from === "unpublished" && to === "retired");
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleProductLifecycleRequest(
  request: Request,
  env: LifecycleEnv,
  authenticate = verifyOperationsIdentity,
): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== PRODUCT_LIFECYCLE_PATH) return;
  if (request.method !== "POST" && request.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!await isAuthenticatedOperationsRequest(request, env)) return json({ error: "UNAUTHORIZED" }, 401);
  if (request.method === "POST" && !request.headers.get("content-type")?.includes("application/json")) return json({ error: "JSON_REQUIRED" }, 415);
  const body = await request.text();
  if (body.length > 2_000) return json({ error: "INVALID_REQUEST" }, 400);
  const identity = await authenticate(request, env, body);
  if (!identity) return json({ error: "WORKFLOW_IDENTITY_REQUIRED" }, 401);
  if (request.method === "GET") {
    const productId = new URL(request.url).searchParams.get("productId");
    if (!productId || !uuid.test(productId)) return json({ error: "PRODUCT_ID_REQUIRED" }, 400);
    const product = await env.DB.prepare("SELECT id, status FROM products WHERE id = ? AND design_id IS NOT NULL").bind(productId).first();
    if (!product) return json({ error: "PRODUCT_NOT_FOUND" }, 404);
    const history = await env.DB.prepare("SELECT command_id, from_status, to_status, actor, actor_id, run_id, reason, applied_at FROM product_lifecycle_transitions WHERE product_id = ? ORDER BY created_at DESC LIMIT 50").bind(productId).all();
    return json({ product, history: history.results });
  }
  let input: TransitionInput | undefined;
  try { input = parseInput(JSON.parse(body)); } catch { /* Invalid JSON is rejected below. */ }
  if (!input || !allowed(input.from, input.to)) return json({ error: "INVALID_TRANSITION" }, 400);
  if (input.to === "unpublished" || input.to === "retired") {
    if (!identity.owner) return json({ error: "OWNER_REQUIRED" }, 403);
    if (input.confirmation !== `${input.to === "unpublished" ? "UNPUBLISH" : "RETIRE"} ${input.productId}`) {
      return json({ error: "IRREVERSIBLE_CONFIRMATION_REQUIRED" }, 400);
    }
  }
  const existing = await readTransition(env.DB, input.commandId);
  if (existing) return replay(existing, body, identity.actorId);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO product_lifecycle_transitions
        (command_id, product_id, from_status, to_status, actor, actor_id, run_id, reason, request_body, created_at)
      SELECT ?, id, status, ?, ?, ?, ?, ?, ?, ? FROM products
      WHERE id = ? AND status = ? AND design_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM paid_orders orders JOIN paid_order_lines lines ON lines.paid_order_id = orders.id
          WHERE lines.configured_product_id = products.id
            AND orders.production_lease_id IS NOT NULL AND orders.production_lease_expires_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM printify_fulfilment_orders fulfilment JOIN paid_order_lines lines ON lines.paid_order_id = fulfilment.paid_order_id
          WHERE lines.configured_product_id = products.id
            AND fulfilment.lease_id IS NOT NULL AND fulfilment.lease_expires_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM printify_production_products resources WHERE resources.configured_product_id = products.id
            AND resources.lease_id IS NOT NULL AND resources.lease_expires_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM printify_media_copies media JOIN print_assets assets ON assets.id = media.print_asset_id
          WHERE assets.configured_product_id = products.id
            AND media.lease_id IS NOT NULL AND media.lease_expires_at > ?
        )
      ON CONFLICT(command_id) DO NOTHING
    `).bind(input.commandId, input.to, identity.actor, identity.actorId, identity.runId, input.reason, body, now, input.productId, input.from, now, now, now, now),
    env.DB.prepare(`
      UPDATE products SET status = ? WHERE id = ? AND status = ? AND EXISTS (
        SELECT 1 FROM product_lifecycle_transitions WHERE command_id = ? AND applied_at IS NULL
      )
    `).bind(input.to, input.productId, input.from, input.commandId),
    env.DB.prepare(`
      UPDATE paid_orders SET status = 'exception_review', updated_at = ?
      WHERE ? != 'active' AND status IN ('production_hold', 'exception_review')
        AND id IN (SELECT paid_order_id FROM paid_order_lines WHERE configured_product_id = ?)
        AND EXISTS (SELECT 1 FROM product_lifecycle_transitions WHERE command_id = ? AND applied_at IS NULL)
    `).bind(now, input.to, input.productId, input.commandId),
    env.DB.prepare(`
      INSERT INTO fulfilment_exceptions(id, paid_order_id, code, summary, status, created_at, resolved_at)
      SELECT id || ':PRODUCT_LIFECYCLE_REVIEW', id, 'PRODUCT_LIFECYCLE_REVIEW',
        'A configured product requires operator review before production.', 'open', ?, NULL
      FROM paid_orders WHERE ? != 'active' AND status IN ('exception_review', 'fulfilment_locked')
        AND NOT EXISTS (SELECT 1 FROM printify_fulfilment_orders WHERE paid_order_id = paid_orders.id AND status IN ('in_production','fulfilled'))
        AND id IN (SELECT paid_order_id FROM paid_order_lines WHERE configured_product_id = ?)
        AND EXISTS (SELECT 1 FROM product_lifecycle_transitions WHERE command_id = ? AND applied_at IS NULL)
      ON CONFLICT(id) DO UPDATE SET status = 'open', resolved_at = NULL
    `).bind(now, input.to, input.productId, input.commandId),
    env.DB.prepare(`
      UPDATE fulfilment_exceptions SET status = 'resolved', resolved_at = ?
      WHERE ? = 'active' AND code = 'PRODUCT_LIFECYCLE_REVIEW' AND status = 'open'
        AND paid_order_id IN (SELECT paid_order_id FROM paid_order_lines WHERE configured_product_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM paid_order_lines lines JOIN products ON products.id = lines.configured_product_id
          WHERE lines.paid_order_id = fulfilment_exceptions.paid_order_id
            AND products.status IN ('suspended', 'unpublished', 'retired')
        )
        AND EXISTS (SELECT 1 FROM product_lifecycle_transitions WHERE command_id = ? AND applied_at IS NULL)
    `).bind(now, input.to, input.productId, input.commandId),
    env.DB.prepare(`UPDATE product_lifecycle_transitions SET applied_at = ? WHERE command_id = ? AND applied_at IS NULL`).bind(now, input.commandId),
  ]);
  const recorded = await readTransition(env.DB, input.commandId);
  if (!recorded) return json({ error: "STATE_CHANGED_OR_FULFILMENT_BUSY", message: "Read the current state and active order lease before retrying." }, 409);
  return replay(recorded, body, identity.actorId);
}
function readTransition(db: D1Database, commandId: string) {
  return db.prepare("SELECT * FROM product_lifecycle_transitions WHERE command_id = ?").bind(commandId).first<RecordedTransition>();
}
function replay(record: RecordedTransition, body: string, actorId: string) {
  if (record.request_body !== body || record.actor_id !== actorId || record.applied_at === null) return json({ error: "COMMAND_CONFLICT" }, 409);
  return json({ commandId: record.command_id, productId: record.product_id, from: record.from_status, to: record.to_status, actor: record.actor, runId: record.run_id, reason: record.reason, appliedAt: new Date(record.applied_at).toISOString() });
}
