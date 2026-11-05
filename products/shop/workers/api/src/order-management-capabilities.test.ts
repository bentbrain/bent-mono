import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";

import {
  handleOrderManagementCapabilityRequest,
  ORDER_MANAGEMENT_CAPABILITIES_PATH,
} from "./order-management-capabilities";

const SERVICE_SECRET = "test-service-secret";
const CART_ID = "gid://shopify/Cart/cart-token?key=cart-secret";
let platform: PlatformProxy<Env> | undefined;

function testPlatform() {
  if (!platform) throw new Error("Test bindings are unavailable.");
  return platform;
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ environment: "", persist: false });
  await createMigrationPrerequisites();
  const migration = await readFile(
    new URL("../drizzle/0019_paid_order_foundation.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    await testPlatform().env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await testPlatform().env.DB.prepare(
    "DELETE FROM order_management_capabilities",
  ).run();
});

afterAll(async () => platform?.dispose());

describe("order-management capability issuance", () => {
  it("stores only a hash and replaces an abandoned cart capability", async () => {
    const first = await issue(1_000);
    const second = await issue(2_000);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstPayload: unknown = await first.json();
    const secondPayload: unknown = await second.json();
    expect(firstPayload).not.toEqual(secondPayload);
    const stored = await testPlatform().env.DB.prepare(`
      SELECT token_hash, shopify_cart_id, created_at, expires_at
      FROM order_management_capabilities
    `).first<{
      token_hash: string;
      shopify_cart_id: string;
      created_at: number;
      expires_at: number;
    }>();
    expect(stored).toMatchObject({
      created_at: 2_000,
      expires_at: 2_592_002_000,
      shopify_cart_id: CART_ID,
    });
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(firstPayload)).not.toContain(stored?.token_hash);
    expect(JSON.stringify(secondPayload)).not.toContain(stored?.token_hash);
  });

  it("does not replace a capability after it has bound an order", async () => {
    await issue(1_000);
    await testPlatform().env.DB.prepare(`
      UPDATE order_management_capabilities SET bound_at = 1500
    `).run();

    const response = await issue(2_000);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "CART_ALREADY_BOUND" },
    });
  });

  it("requires service authentication and a Shopify cart GID", async () => {
    const unauthorized = await handleOrderManagementCapabilityRequest(
      request(CART_ID, false),
      { DB: testPlatform().env.DB, FOREVER_TEE_API_SHARED_SECRET: SERVICE_SECRET },
    );
    const invalid = await handleOrderManagementCapabilityRequest(
      request("cart-token", true),
      { DB: testPlatform().env.DB, FOREVER_TEE_API_SHARED_SECRET: SERVICE_SECRET },
    );
    expect(unauthorized?.status).toBe(401);
    expect(invalid?.status).toBe(400);
  });
});

function issue(now: number) {
  return handleOrderManagementCapabilityRequest(
    request(CART_ID, true),
    { DB: testPlatform().env.DB, FOREVER_TEE_API_SHARED_SECRET: SERVICE_SECRET },
    () => now,
  ).then((response) => {
    if (!response) throw new Error("Request was not handled.");
    return response;
  });
}

function request(shopifyCartId: string, authenticated: boolean) {
  return new Request(
    `https://api.example.com${ORDER_MANAGEMENT_CAPABILITIES_PATH}`,
    {
      body: JSON.stringify({ shopifyCartId }),
      headers: {
        "content-type": "application/json",
        ...(authenticated
          ? { "x-forever-tee-service-secret": SERVICE_SECRET }
          : {}),
      },
      method: "POST",
    },
  );
}

async function createMigrationPrerequisites() {
  await testPlatform().env.DB.prepare(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      base_product_id TEXT,
      design_id TEXT,
      design_revision_id TEXT,
      projection_version TEXT,
      status TEXT,
      shopify_handle TEXT
    )
  `).run();
  await testPlatform().env.DB.prepare(`
    CREATE TABLE design_revisions (id TEXT PRIMARY KEY)
  `).run();
  await testPlatform().env.DB.prepare(`
    CREATE TABLE shopify_variant_mapping_snapshots (
      id TEXT PRIMARY KEY,
      base_product_id TEXT NOT NULL
    )
  `).run();
  await testPlatform().env.DB.prepare(`
    CREATE TABLE shopify_variant_mappings (
      snapshot_id TEXT NOT NULL,
      shopify_variant_id TEXT NOT NULL,
      printify_variant_id INTEGER NOT NULL,
      colour TEXT NOT NULL,
      size TEXT NOT NULL
    )
  `).run();
}
