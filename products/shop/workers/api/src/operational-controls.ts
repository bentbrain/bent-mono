import type { BaseProductSlug } from "@forever-tee/contracts";

import {
  isAuthenticatedOperationsRequest,
  isAuthenticatedServiceRequest,
} from "./service-auth";

export const SALES_INTAKE_PATH = "/v2/internal/sales-intake";
export const SALES_PAUSE_CONTROL_PATH =
  "/v2/internal/operations/sales-pause";
export const SALES_PAUSE_MESSAGE =
  "Orders are temporarily paused. Please check back soon.";

const SALES_PAUSE_KEY = "sales_pause";
const CATALOGUE_PAUSE_KEY = "catalogue_pause";
const VARIANT_MAPPING_PAUSE_KEY = "variant_mapping_pause";
export const CATALOGUE_MAX_AGE_MS = 30 * 60 * 1_000;
const VARIANT_MAPPING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_REASON_LENGTH = 200;

interface OperationalControlsEnv {
  readonly BENT_SHIRT_OPERATIONS_SECRET?: string;
  readonly DB: D1Database;
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
}

interface OperationalControlRow {
  control_key: string;
  enabled: number;
  reason: string;
  updated_at: number;
}

interface SalesPauseUpdate {
  paused: boolean;
  reason: string;
}

export async function handleOperationalControlRequest(
  request: Request,
  env: OperationalControlsEnv,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === SALES_INTAKE_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    if (!(await isAuthenticatedServiceRequest(request, env))) {
      return apiError(401, "UNAUTHORIZED", "Service authentication is required.");
    }
    return readSalesIntake(env.DB, request.method === "HEAD");
  }

  if (path !== SALES_PAUSE_CONTROL_PATH) return undefined;
  if (request.method !== "PUT") return methodNotAllowed("PUT");
  if (!(await isAuthenticatedOperationsRequest(request, env))) {
    return apiError(401, "UNAUTHORIZED", "Operations authentication is required.");
  }
  const update = await parseSalesPauseUpdate(request);
  if (update instanceof Response) return update;
  return writeSalesPause(env.DB, update);
}

async function readSalesIntake(db: D1Database, head: boolean) {
  let controls: D1Result<OperationalControlRow>;
  let catalogueSnapshot: { retrieved_at: number } | null;
  let mappingSnapshot: { retrieved_at: number } | null;
  try {
    [controls, catalogueSnapshot, mappingSnapshot] = await Promise.all([
      db.prepare(`
      SELECT control_key, enabled, reason, updated_at
      FROM operational_controls
      WHERE control_key IN (?, ?, ?)
         OR control_key LIKE 'catalogue_pause:%'
         OR control_key LIKE 'variant_mapping_pause:%'
    `).bind(
        SALES_PAUSE_KEY,
        CATALOGUE_PAUSE_KEY,
        VARIANT_MAPPING_PAUSE_KEY,
      ).all<OperationalControlRow>(),
      db.prepare(`
        SELECT MIN(retrieved_at) AS retrieved_at
        FROM (
          SELECT base_product_slug, MAX(retrieved_at) AS retrieved_at
          FROM printify_catalogue_snapshots
          WHERE base_product_slug IN ('staple-tee', 'cotton-tote')
          GROUP BY base_product_slug
          HAVING COUNT(*) > 0
        )
        HAVING COUNT(*) = 2
      `).first<{ retrieved_at: number }>(),
      db.prepare(`
        SELECT MIN(retrieved_at) AS retrieved_at
        FROM (
          SELECT base_product_slug, MAX(retrieved_at) AS retrieved_at
          FROM shopify_variant_mapping_snapshots
          WHERE base_product_slug IN ('staple-tee', 'cotton-tote')
          GROUP BY base_product_slug
          HAVING COUNT(*) > 0
        )
        HAVING COUNT(*) = 2
      `).first<{ retrieved_at: number }>(),
    ]);
  } catch {
    return dependencyUnavailable();
  }

  const manualPause = controls.results.find(
    ({ control_key, enabled }) =>
      control_key === SALES_PAUSE_KEY && enabled === 1,
  );
  const cataloguePause = controls.results.find(
    ({ control_key, enabled }) =>
      (control_key === CATALOGUE_PAUSE_KEY ||
        control_key.startsWith(`${CATALOGUE_PAUSE_KEY}:`)) && enabled === 1,
  );
  const mappingPause = controls.results.find(
    ({ control_key, enabled }) =>
      (control_key === VARIANT_MAPPING_PAUSE_KEY ||
        control_key.startsWith(`${VARIANT_MAPPING_PAUSE_KEY}:`)) &&
      enabled === 1,
  );
  const catalogueStale = !catalogueSnapshot ||
    Date.now() - catalogueSnapshot.retrieved_at >
    CATALOGUE_MAX_AGE_MS;
  const mappingStale = !mappingSnapshot ||
    Date.now() - mappingSnapshot.retrieved_at > VARIANT_MAPPING_MAX_AGE_MS;
  const active = manualPause ?? cataloguePause ?? mappingPause;
  const paused = Boolean(active) || catalogueStale || mappingStale;
  const staleReason = catalogueStale
    ? "Printify catalogue data is stale."
    : mappingStale
      ? "Shopify variant mapping is stale."
      : null;
  const latestSnapshotTime = Math.min(
    catalogueSnapshot?.retrieved_at ?? 0,
    mappingSnapshot?.retrieved_at ?? 0,
  );
  const payload = {
    message: paused ? SALES_PAUSE_MESSAGE : null,
    paused,
    reason: active?.reason ?? staleReason,
    updatedAt: active
      ? new Date(active.updated_at).toISOString()
      : latestSnapshotTime > 0
        ? new Date(latestSnapshotTime).toISOString()
        : null,
  };
  return head
    ? new Response(null, { status: 200 })
    : Response.json(payload, {
        headers: { "Cache-Control": "no-store" },
      });
}

async function writeSalesPause(db: D1Database, update: SalesPauseUpdate) {
  const updatedAt = Date.now();
  try {
    await upsertControl(db, SALES_PAUSE_KEY, update, updatedAt);
  } catch {
    return dependencyUnavailable();
  }

  return Response.json({
    message: update.paused ? SALES_PAUSE_MESSAGE : null,
    paused: update.paused,
    reason: update.reason,
    updatedAt: new Date(updatedAt).toISOString(),
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function setAutomaticCataloguePause(
  db: D1Database,
  paused: boolean,
  reason: string,
  baseProductSlug?: BaseProductSlug,
) {
  await upsertControl(
    db,
    productControlKey(CATALOGUE_PAUSE_KEY, baseProductSlug),
    { paused, reason },
    Date.now(),
  );
}

export async function setAutomaticVariantMappingPause(
  db: D1Database,
  paused: boolean,
  reason: string,
  baseProductSlug?: BaseProductSlug,
) {
  await upsertControl(
    db,
    productControlKey(VARIANT_MAPPING_PAUSE_KEY, baseProductSlug),
    { paused, reason },
    Date.now(),
  );
}

function productControlKey(key: string, slug: BaseProductSlug | undefined) {
  return slug ? `${key}:${slug}` : key;
}

function upsertControl(
  db: D1Database,
  key: string,
  update: SalesPauseUpdate,
  updatedAt: number,
) {
  return db.prepare(`
    INSERT INTO operational_controls (
      control_key, enabled, reason, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(control_key) DO UPDATE SET
      enabled = excluded.enabled,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `).bind(
    key,
    update.paused ? 1 : 0,
    update.reason,
    updatedAt,
  ).run();
}

async function parseSalesPauseUpdate(
  request: Request,
): Promise<SalesPauseUpdate | Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return apiError(415, "INVALID_REQUEST", "Send a JSON request body.");
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "INVALID_REQUEST", "Send a valid JSON request body.");
  }
  if (!isRecord(payload) || typeof payload["paused"] !== "boolean") {
    return apiError(400, "INVALID_REQUEST", "paused must be a boolean.");
  }
  const reason = typeof payload["reason"] === "string"
    ? payload["reason"].trim()
    : "";
  if (reason.length === 0 || reason.length > MAXIMUM_REASON_LENGTH) {
    return apiError(
      400,
      "INVALID_REQUEST",
      `reason must be between 1 and ${String(MAXIMUM_REASON_LENGTH)} characters.`,
    );
  }
  return { paused: payload["paused"], reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyUnavailable() {
  return apiError(
    503,
    "DEPENDENCY_UNAVAILABLE",
    "Operational controls are unavailable.",
  );
}

function methodNotAllowed(allow: string) {
  return apiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
    Allow: allow,
  });
}

function apiError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    { error: { code, message } },
    headers ? { status, headers } : { status },
  );
}
