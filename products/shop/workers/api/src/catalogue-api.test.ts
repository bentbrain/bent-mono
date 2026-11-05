import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";

import {
  CATALOGUE_PATH,
  CATALOGUE_REFRESH_PATH,
  handleCatalogueRequest,
} from "./catalogue-api";

const OPERATIONS_SECRET = "operations-secret";
const SERVICE_SECRET = "service-secret";
let platform: PlatformProxy<Env> | undefined;

function testPlatform() {
  if (!platform) throw new Error("Test bindings are unavailable.");
  return platform;
}

function workerEnv() {
  return {
    BENT_SHIRT_OPERATIONS_SECRET: OPERATIONS_SECRET,
    DB: testPlatform().env.DB,
    FOREVER_TEE_API_SHARED_SECRET: SERVICE_SECRET,
    PRINTIFY_API_TOKEN: "printify-token",
    PRINTIFY_SHOP_ID: "123",
  };
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ environment: "", persist: false });
  for (const name of [
    "0008_operational_controls.sql",
    "0009_printify_catalogue_snapshots.sql",
    "0010_shopify_variant_mappings.sql",
    "0012_product_aware_catalogues.sql",
  ]) {
    const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    const statements = sql.split("--> statement-breakpoint");
    for (const statement of statements) {
      await testPlatform().env.DB.prepare(
        statement
          .replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")
          .replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS")
          .replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS"),
      ).run();
    }
  }
});

beforeEach(async () => {
  await testPlatform().env.DB.batch([
    testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_variants"),
    testPlatform().env.DB.prepare("DELETE FROM printify_catalogue_snapshots"),
    testPlatform().env.DB.prepare("DELETE FROM operational_controls"),
  ]);
});

afterAll(async () => platform?.dispose());

describe("Printify catalogue snapshots", () => {
  it("requires operations authentication before refreshing", async () => {
    const response = await handled(CATALOGUE_REFRESH_PATH, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("persists and reads an immutable authenticated snapshot", async () => {
    const fetcher = printifyFetcher();
    const refreshed = await handled(CATALOGUE_REFRESH_PATH, {
      headers: { "x-bent-shirt-operations-secret": OPERATIONS_SECRET },
      method: "POST",
    }, fetcher);

    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      products: [
        {
          availableVariantCount: 1,
          baseProductSlug: "staple-tee",
          variantCount: 2,
        },
        {
          availableVariantCount: 1,
          baseProductSlug: "cotton-tote",
          variantCount: 2,
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(12);

    const read = await handled(CATALOGUE_PATH, {
      headers: { "x-forever-tee-service-secret": SERVICE_SECRET },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      baseProductSlug: "staple-tee",
      blueprintId: 440,
      printProviderId: 34,
      printGeometries: [{
        decorationMethod: "dtg",
        printHeight: 4690,
        printWidth: 4150,
        sizes: ["S"],
      }],
      variants: [
        {
          available: true,
          color: "Black",
          id: 101,
          size: "S",
          standardShippingToAustralia: {
            firstItem: { amount: 639, currency: "USD" },
          },
        },
        {
          available: false,
          color: "White",
          id: 102,
          size: "S",
        },
      ],
    });

    const toteRead = await handled(
      `${CATALOGUE_PATH}?baseProduct=cotton-tote`,
      { headers: { "x-forever-tee-service-secret": SERVICE_SECRET } },
    );
    expect(await toteRead.json()).toMatchObject({
      baseProductSlug: "cotton-tote",
      blueprintId: 553,
      variants: [
        { color: "Black", id: 70603, printHeight: 3425, printWidth: 2835 },
        { color: "Cream", id: 70646, printHeight: 3425, printWidth: 2835 },
      ],
    });

    const row = await testPlatform().env.DB.prepare(`
      SELECT id FROM printify_catalogue_snapshots LIMIT 1
    `).first<{ id: string }>();
    if (!row) throw new Error("Snapshot was not stored.");
    await expect(testPlatform().env.DB.prepare(`
      UPDATE printify_catalogue_snapshots SET variant_count = 3 WHERE id = ?
    `).bind(row.id).run()).rejects.toThrow("catalogue snapshots are immutable");
  });

  it("requires service authentication before reading stock", async () => {
    const response = await handled(CATALOGUE_PATH);
    expect(response.status).toBe(401);
  });

  it("activates the automatic pause when a refresh fails", async () => {
    const failedFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 503 }))
    );
    const response = await handled(CATALOGUE_REFRESH_PATH, {
      headers: { "x-bent-shirt-operations-secret": OPERATIONS_SECRET },
      method: "POST",
    }, failedFetch);
    expect(response.status).toBe(503);

    const control = await testPlatform().env.DB.prepare(`
      SELECT enabled, reason FROM operational_controls
      WHERE control_key = 'catalogue_pause:staple-tee'
    `).first<{ enabled: number; reason: string }>();
    expect(control).toEqual({
      enabled: 1,
      reason: "Printify staple-tee catalogue refresh failed.",
    });
  });

  it("tracks launch catalogue refresh failures independently", async () => {
    const delegate = printifyFetcher();
    const toteFailure = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.pathname.includes("/blueprints/553")
        ? Promise.resolve(new Response(null, { status: 503 }))
        : delegate(input, init);
    });
    const response = await handled(CATALOGUE_REFRESH_PATH, {
      headers: { "x-bent-shirt-operations-secret": OPERATIONS_SECRET },
      method: "POST",
    }, toteFailure);
    expect(response.status).toBe(503);

    const controls = await testPlatform().env.DB.prepare(`
      SELECT control_key, enabled FROM operational_controls
      WHERE control_key LIKE 'catalogue_pause:%'
      ORDER BY control_key
    `).all<{ control_key: string; enabled: number }>();
    expect(controls.results).toEqual([
      { control_key: "catalogue_pause:cotton-tote", enabled: 1 },
      { control_key: "catalogue_pause:staple-tee", enabled: 0 },
    ]);
  });
});

async function handled(
  path: string,
  init: RequestInit = {},
  fetcher?: typeof fetch,
) {
  const response = await handleCatalogueRequest(
    new Request(`https://api.example.com${path}`, init),
    workerEnv(),
    fetcher,
  );
  if (!response) throw new Error("Catalogue route was not handled.");
  return response;
}

function printifyFetcher() {
  const teeVariants = [
    variant(101, "Black", "S"),
    variant(102, "White", "S"),
  ];
  const toteVariants = [
    variant(70603, "Black", "One size", 2835, 3425),
    variant(70646, "Cream", "One size", 2835, 3425),
  ];
  return vi.fn<typeof fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const tote = url.pathname.includes("/blueprints/553");
    const allVariants = tote ? toteVariants : teeVariants;
    if (url.pathname.endsWith("/shops.json")) {
      return Promise.resolve(Response.json([{
        id: 123,
        sales_channel: "custom_integration",
        title: "bent.shop",
      }]));
    }
    if (url.pathname.endsWith("/blueprints/440.json") ||
        url.pathname.endsWith("/blueprints/553.json")) {
      return Promise.resolve(Response.json({
        brand: "AS Colour",
        id: tote ? 553 : 440,
        model: tote ? "1001" : "5001",
        title: tote ? "Cotton Tote" : "Adult Staple Tee",
      }));
    }
    if (url.pathname.endsWith("/print_providers.json")) {
      return Promise.resolve(Response.json([{
        id: 34,
        title: "The Print Bar",
      }]));
    }
    if (url.pathname.endsWith("/variants.json")) {
      const variants = url.searchParams.get("show-out-of-stock") === "1"
        ? allVariants
        : [allVariants[0]];
      return Promise.resolve(Response.json({
        id: 34,
        title: "The Print Bar",
        variants,
      }));
    }
    if (url.pathname.endsWith("/shipping/standard.json")) {
      return Promise.resolve(Response.json({
        data: allVariants.map((item) => shippingEntry(item.id)),
      }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

function variant(
  id: number,
  color: string,
  size: string,
  width = 4150,
  height = 4690,
) {
  return {
    id,
    options: { color, size },
    placeholders: [{
      decoration_method: "dtg",
      height,
      position: "front",
      width,
    }],
    title: `${color} / ${size}`,
  };
}

function shippingEntry(variantId: number) {
  return {
    attributes: {
      country: { code: "AU" },
      handlingTime: { from: 3, to: 6 },
      shippingCost: {
        additionalItems: { amount: 139, currency: "USD" },
        firstItem: { amount: 639, currency: "USD" },
      },
      variantId,
    },
    id: String(variantId),
    type: "variant_shipping_standard_au",
  };
}
