import { withDatabasePrepare } from "./test-database";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { reconcileConfiguredProductPrintAssets } from "./print-assets";

let platform: PlatformProxy<Env> | undefined;
function bindings() {
  if (!platform) throw new Error("Test bindings are unavailable.");
  return platform.env;
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ environment: "", persist: false, remoteBindings: false });
  const schema = [
    "CREATE TABLE products(id TEXT PRIMARY KEY, base_product_id TEXT, design_id TEXT, design_revision_id TEXT, shopify_handle TEXT, status TEXT, projection_version TEXT, created_at INTEGER)",
    "CREATE TABLE print_asset_jobs(configured_product_id TEXT PRIMARY KEY, status TEXT)",
    "CREATE TABLE print_asset_retries(configured_product_id TEXT PRIMARY KEY, next_attempt_at INTEGER, last_attempt_at INTEGER)",
    "CREATE TABLE printify_catalogue_snapshots(id TEXT PRIMARY KEY, base_product_id TEXT)",
    "CREATE TABLE printify_catalogue_variants(snapshot_id TEXT, printify_variant_id INTEGER, decoration_method TEXT, print_width INTEGER, print_height INTEGER, PRIMARY KEY(snapshot_id, printify_variant_id))",
    "CREATE TABLE shopify_variant_mapping_snapshots(id TEXT PRIMARY KEY, base_product_id TEXT, shopify_product_handle TEXT, catalogue_snapshot_id TEXT, retrieved_at INTEGER)",
    "CREATE INDEX shopify_variant_mapping_snapshots_retrieved_at_idx ON shopify_variant_mapping_snapshots(retrieved_at DESC)",
    "CREATE TABLE print_assets(id TEXT PRIMARY KEY, configured_product_id TEXT, design_revision_id TEXT, base_product_id TEXT, projection_version TEXT, geometry_key TEXT, status TEXT)",
    "CREATE UNIQUE INDEX print_assets_provider_identity_unique_idx ON print_assets(configured_product_id, design_revision_id, base_product_id, projection_version, geometry_key)",
    `WITH RECURSIVE history(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM history WHERE n < 499)
      INSERT INTO printify_catalogue_snapshots SELECT 'snapshot-' || n, 'base' FROM history`,
    `INSERT INTO shopify_variant_mapping_snapshots
      SELECT 'mapping-' || id, 'base', 'shirt', id, CAST(substr(id, 10) AS INTEGER) FROM printify_catalogue_snapshots`,
    `WITH RECURSIVE variants(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM variants WHERE n < 29)
      INSERT INTO printify_catalogue_variants SELECT id, n, 'dtg', 2835, 3425 FROM printify_catalogue_snapshots CROSS JOIN variants`,
  ];
  await bindings().DB.batch(schema.map(sql => bindings().DB.prepare(sql)));
});
afterAll(async () => platform?.dispose());
beforeEach(async () => {
  const db = bindings().DB;
  await db.batch([
    db.prepare("DELETE FROM print_assets"), db.prepare("DELETE FROM print_asset_jobs"),
    db.prepare("DELETE FROM print_asset_retries"), db.prepare("DELETE FROM products"),
    db.prepare("INSERT INTO products VALUES('base', 'base', NULL, NULL, 'shirt', 'active', NULL, 0)"),
    db.prepare(`WITH RECURSIVE products(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM products WHERE n < 127)
      INSERT INTO products SELECT 'product-' || n, 'base', 'design-' || n, 'revision-' || n, NULL, 'active', 'safe-margin-v1', n FROM products`),
    db.prepare(`INSERT INTO print_assets SELECT 'asset-' || id, id, design_revision_id, base_product_id, projection_version, 'dtg:2835x3425', 'ready'
      FROM products WHERE design_id IS NOT NULL`),
    db.prepare("INSERT INTO print_asset_jobs SELECT id, 'ready' FROM products WHERE design_id IS NOT NULL"),
  ]);
});

async function observeCandidates() {
  const env = bindings(), db = env.DB;
  let candidates: unknown[] = [];
  let rowsRead: number | undefined;
  function observe(statement: D1PreparedStatement): D1PreparedStatement {
    return {
      bind: (...values) => observe(statement.bind(...values)),
      first: statement.first.bind(statement), run: statement.run.bind(statement), raw: statement.raw.bind(statement),
      all: async <T>(): Promise<D1Result<T>> => {
        const result = await statement.all<T>();
        candidates = result.results;
        rowsRead = result.meta.rows_read;
        // Observe the real selection query. Existing integration tests cover
        // the fenced rendering loop; this fixture never invokes image services.
        return { ...result, results: [] };
      },
    };
  }
  const observedDb = withDatabasePrepare(db, sql => sql.includes("SELECT products.id AS configured_product_id")
    ? observe(db.prepare(sql)) : db.prepare(sql));
  await expect(reconcileConfiguredProductPrintAssets({ ...env, DB: observedDb }))
    .resolves.toEqual({ productsFailed: 0, productsReconciled: 0 });
  return { candidates, rowsRead };
}

it("bounds recovery reads with completed products and 15,000 historical catalogue variants", async () => {
  const result = await observeCandidates();
  expect(result.candidates).toEqual([]);
  expect(result.rowsRead).toBeGreaterThan(0);
  expect(result.rowsRead).toBeLessThan(20_000);
});

it("selects missing accepted geometry while retaining retry and durable-job fences", async () => {
  const db = bindings().DB;
  await db.batch([
    db.prepare("DELETE FROM print_assets WHERE configured_product_id IN ('product-0', 'product-1', 'product-2')"),
    db.prepare("INSERT INTO print_asset_retries VALUES('product-1', ?, 0)").bind(Date.now() + 60_000),
    db.prepare("UPDATE print_asset_jobs SET status = 'running' WHERE configured_product_id = 'product-2'"),
    db.prepare("INSERT INTO printify_catalogue_snapshots VALUES('unmapped-newer', 'base')"),
    db.prepare("INSERT INTO printify_catalogue_variants VALUES('unmapped-newer', 1, 'dtg', 5000, 6000)"),
  ]);
  expect((await observeCandidates()).candidates).toEqual([{ configured_product_id: "product-0" }]);
});
