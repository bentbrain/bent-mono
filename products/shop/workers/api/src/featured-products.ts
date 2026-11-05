import { COTTON_TOTE_BASE_PRODUCT_ID, STAPLE_TEE_BASE_PRODUCT_ID, parseFeaturedProducts } from "@forever-tee/contracts";
import { verifyOperationsIdentity, type OperationsIdentityEnv } from "./operations-identity";
import { isAuthenticatedOperationsRequest, isAuthenticatedServiceRequest } from "./service-auth";

const FEATURED_PRODUCTS_PATH = "/v2/internal/featured-products";
export const FEATURED_PRODUCTS_OPERATIONS_PATH = "/v2/internal/operations/featured-products";
interface FeaturedEnv extends OperationsIdentityEnv {
  readonly DB: D1Database;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
}
interface ConfigurationRow { slot: number; productId: string }
interface ChangeRow { request_body: string; revision: number }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const eligible = `p.status = 'active' AND p.design_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM products shirt WHERE shirt.design_id = p.design_id AND shirt.design_revision_id IS p.design_revision_id AND shirt.base_product_id = ? AND shirt.status = 'active')
  AND EXISTS (SELECT 1 FROM products tote WHERE tote.design_id = p.design_id AND tote.design_revision_id IS p.design_revision_id AND tote.base_product_id = ? AND tote.status = 'active')`;

async function activeProducts(db: D1Database) {
  const rows = await db.prepare(`SELECT featured.slot, featured.product_id AS productId FROM featured_products featured JOIN products p ON p.id = featured.product_id WHERE ${eligible} ORDER BY featured.slot`)
    .bind(STAPLE_TEE_BASE_PRODUCT_ID, COTTON_TOTE_BASE_PRODUCT_ID).all<ConfigurationRow>();
  return rows.results;
}

export async function handleFeaturedProductsRequest(request: Request, env: FeaturedEnv, authenticate = verifyOperationsIdentity): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== FEATURED_PRODUCTS_PATH && path !== FEATURED_PRODUCTS_OPERATIONS_PATH) return;
  if (path === FEATURED_PRODUCTS_PATH) {
    if (!await isAuthenticatedServiceRequest(request, env)) return json({ error: "UNAUTHORIZED" }, 401);
    if (request.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    const products = parseFeaturedProducts(await activeProducts(env.DB));
    return products ? json({ products }) : json({ error: "FEATURED_PRODUCTS_UNAVAILABLE" }, 503);
  }
  if (!await isAuthenticatedOperationsRequest(request, env)) return json({ error: "UNAUTHORIZED" }, 401);
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const body = await request.text();
  if (body.length > 3000) return json({ error: "INVALID_REQUEST" }, 400);
  const identity = await authenticate(request, env, body);
  if (!identity) return json({ error: "WORKFLOW_IDENTITY_REQUIRED" }, 401);
  if (request.method === "GET") {
    const state = await env.DB.prepare("SELECT revision FROM featured_product_state WHERE id = 1").first<{ revision: number }>();
    const products = await env.DB.prepare("SELECT slot, product_id AS productId FROM featured_products ORDER BY slot").all<ConfigurationRow>();
    const changes = await env.DB.prepare("SELECT command_id AS commandId, revision, actor, run_id AS runId, created_at AS createdAt FROM featured_product_changes ORDER BY revision DESC LIMIT 10").all();
    return json({ revision: state?.revision, products: products.results, eligibleProducts: await activeProducts(env.DB), changes: changes.results });
  }
  if (!identity.owner) return json({ error: "OWNER_REQUIRED" }, 403);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "JSON_REQUIRED" }, 415);
  let input: unknown;
  try { input = JSON.parse(body); } catch { return json({ error: "INVALID_REQUEST" }, 400); }
  if (typeof input !== "object" || input === null || !("products" in input) ||
      !("expectedRevision" in input) || typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !("commandId" in input) || typeof input.commandId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.commandId) ||
      Object.keys(input).some(key => !["products", "expectedRevision", "commandId"].includes(key))) return json({ error: "INVALID_REQUEST" }, 400);
  const products = parseFeaturedProducts(input.products);
  if (!products) return json({ error: "INVALID_PRODUCTS" }, 400);
  const commandId = input.commandId;
  const canonical = JSON.stringify({ products, expectedRevision: input.expectedRevision });
  const existing = await env.DB.prepare("SELECT request_body, revision FROM featured_product_changes WHERE command_id = ?").bind(commandId).first<ChangeRow>();
  if (existing) return existing.request_body === canonical ? json({ revision: existing.revision, replayed: true }) : json({ error: "COMMAND_CONFLICT" }, 409);
  const gate = "EXISTS (SELECT 1 FROM featured_product_changes change JOIN featured_product_state state ON change.revision = state.revision + 1 WHERE state.id = 1 AND change.command_id = ?)";
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO featured_product_changes (command_id, revision, request_body, products_json, previous_products_json, actor, run_id, created_at)
      SELECT ?, revision + 1, ?, ?, (SELECT json_group_array(json_object('slot', slot, 'productId', product_id)) FROM featured_products), ?, ?, ? FROM featured_product_state
      WHERE id = 1 AND revision = ? AND (SELECT count(DISTINCT p.design_id) FROM products p WHERE p.id IN (${products.map(() => "?").join(",")}) AND ${eligible}) = ?`)
      .bind(commandId, canonical, JSON.stringify(products), identity.actor, identity.runId, now, input.expectedRevision, ...products.map(product => product.productId), STAPLE_TEE_BASE_PRODUCT_ID, COTTON_TOTE_BASE_PRODUCT_ID, products.length),
    env.DB.prepare(`DELETE FROM featured_products WHERE ${gate}`).bind(commandId),
    env.DB.prepare(`INSERT INTO featured_products (slot, product_id, updated_at) SELECT json_extract(entry.value, '$.slot'), json_extract(entry.value, '$.productId'), change.created_at FROM featured_product_changes change, json_each(change.products_json) entry WHERE change.command_id = ? AND ${gate}`).bind(commandId, commandId),
    env.DB.prepare(`UPDATE featured_product_state SET revision = revision + 1 WHERE id = 1 AND ${gate}`).bind(commandId),
  ]);
  const committed = await env.DB.prepare("SELECT request_body, revision FROM featured_product_changes WHERE command_id = ?").bind(commandId).first<ChangeRow>();
  return committed?.request_body === canonical ? json({ revision: committed.revision }) : json({ error: "CONFIGURATION_CHANGED_OR_PRODUCT_UNAVAILABLE" }, 409);
}
