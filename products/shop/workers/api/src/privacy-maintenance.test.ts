import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";

import { artworkPreviewKey } from "./design-repository";
import { runScheduledPrivacyMaintenance } from "./privacy-maintenance";

const NOW = 1_788_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const ABANDONED_ID = "a42a00a1-2e3b-4597-aa48-325a7f10f619";
const REFERENCED_ID = "e7118739-7e39-4a59-a98b-4fd9d649f83c";
const SHA = "a".repeat(64);
let platform: PlatformProxy<Env> | undefined;

function testPlatform() {
  if (!platform) throw new Error("Test bindings are unavailable.");
  return platform;
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ environment: "", persist: false });
  for (const name of [
    "0000_loving_king_bedlam.sql",
    "0001_faulty_taskmaster.sql",
    "0002_separate_product_design_ids.sql",
    "0003_idempotent-configured-products.sql",
    "0004_immutable_revision_ledger.sql",
    "0005_catch_up_revision_links.sql",
    "0006_anonymous_draft_capabilities.sql",
    "0007_paid_operation_quotas.sql",
    "0008_operational_controls.sql",
    "0009_printify_catalogue_snapshots.sql",
    "0010_shopify_variant_mappings.sql",
    "0011_reusable_design_revisions.sql",
    "0012_product_aware_catalogues.sql",
    "0013_versioned_product_projections.sql",
    "0014_default_design_product_family.sql",
    "0015_story_video_jobs.sql",
    "0016_story_video_renderer_v5.sql",
    "0017_story_video_renderer_v6.sql",
    "0018_story_video_execution_fence.sql",
    "0019_paid_order_foundation.sql",
    "0020_protected_customer_data_hardening.sql",
    "0031_order_management.sql",
  "0039_featured_media_composition.sql",
    "0040_recursive_video_placement.sql",
    "0041_product_image_jobs.sql",
    "0042_design_artwork_sources.sql",
    "0043_artwork_preparation_jobs.sql",
    "0044_video_preview_revisions.sql",
  ]) {
    const sql = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const rawStatement of sql.split("--> statement-breakpoint")) {
      const statement = rawStatement.trim();
      if (statement) await testPlatform().env.DB.prepare(statement).run();
    }
  }
});

beforeEach(async () => {
  const db = testPlatform().env.DB;
  await db.batch([
    db.prepare("DELETE FROM privacy_object_deletions"),
    db.prepare("DELETE FROM personal_data_access_log"),
    db.prepare("DELETE FROM fulfilment_exceptions"),
    db.prepare("DELETE FROM paid_order_lines"),
    db.prepare("DELETE FROM paid_orders"),
    db.prepare("DELETE FROM order_management_capabilities"),
    db.prepare("DELETE FROM shopify_webhook_inbox"),
    db.prepare("DELETE FROM design_upload_grants"),
    db.prepare("DELETE FROM products WHERE design_id IS NOT NULL"),
    db.prepare("DELETE FROM design_revisions"),
    db.prepare("DELETE FROM designs"),
  ]);
  const objects = await testPlatform().env.DESIGN_ARTWORK.list();
  if (objects.objects.length > 0) {
    await testPlatform().env.DESIGN_ARTWORK.delete(
      objects.objects.map((object) => object.key),
    );
  }
});

afterAll(async () => platform?.dispose());

describe("scheduled privacy maintenance", () => {
  it("minimizes and expires operational copies of protected order data", async () => {
    const db = testPlatform().env.DB;
    await db.batch([
      webhook("old-webhook", NOW - 31 * DAY_MS, '{"email":"old@example.com"}'),
      webhook("recent-webhook", NOW - DAY_MS, '{"email":"recent@example.com"}'),
      db.prepare(`
        INSERT INTO paid_orders (
          id, shopify_order_id, shopify_order_name, source_payload_sha256,
          currency_code, total_minor_units, status, production_hold_expires_at,
          delivery_address_sha256, delivery_address_json, created_at, updated_at
        ) VALUES (?, ?, '#1001', ?, 'AUD', 7000, 'fulfilled', ?, ?, ?, ?, ?)
      `).bind(
        "paid-order-1",
        "gid://shopify/Order/1001",
        "b".repeat(64),
        NOW - 60 * DAY_MS,
        "c".repeat(64),
        '{"email":"buyer@example.com"}',
        NOW - 60 * DAY_MS,
        NOW - 46 * DAY_MS,
      ),
      db.prepare(`
        INSERT INTO personal_data_access_log (
          id, subject_hash, actor, action, purpose, occurred_at
        ) VALUES ('old-access', ?, 'system:shopify-webhook', 'receive',
          'paid-order-ingestion', ?)
      `).bind("d".repeat(64), NOW - 731 * DAY_MS),
      db.prepare(`
        INSERT INTO personal_data_access_log (
          id, subject_hash, actor, action, purpose, occurred_at
        ) VALUES ('recent-access', ?, 'system:shopify-webhook', 'receive',
          'paid-order-ingestion', ?)
      `).bind("e".repeat(64), NOW - DAY_MS),
      db.prepare(`
        INSERT INTO order_management_capabilities (
          token_hash, shopify_cart_id, expires_at, created_at
        ) VALUES (?, 'old-cart', ?, ?)
      `).bind("f".repeat(64), NOW - 31 * DAY_MS, NOW - 40 * DAY_MS),
    ]);

    const report = await runScheduledPrivacyMaintenance({
      DB: db,
      DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
    }, () => NOW);

    expect(report).toMatchObject({
      accessLogs: 1,
      deliveryAddresses: 1,
      expiredCapabilities: 1,
      webhookAudits: 1,
      webhookBodiesMinimized: 2,
    });
    const recentWebhook = await db.prepare(`
      SELECT payload_json FROM shopify_webhook_inbox
      WHERE webhook_id = 'recent-webhook'
    `).first<{ payload_json: string }>();
    expect(recentWebhook?.payload_json).toBe('{"schema":"orders-paid-audit-v1"}');
    const order = await db.prepare(`
      SELECT delivery_address_json, delivery_address_sha256,
        personal_data_purged_at
      FROM paid_orders WHERE id = 'paid-order-1'
    `).first<{
      delivery_address_json: string | null;
      delivery_address_sha256: string | null;
      personal_data_purged_at: number | null;
    }>();
    expect(order).toEqual({
      delivery_address_json: null,
      delivery_address_sha256: null,
      personal_data_purged_at: NOW,
    });
  });

  it("deletes only abandoned drafts after an atomic reference recheck", async () => {
    const db = testPlatform().env.DB;
    const abandonedKey = `designs/${ABANDONED_ID}/${SHA}.png`;
    const abandonedPreview = artworkPreviewKey(ABANDONED_ID, SHA);
    const referencedKey = `designs/${REFERENCED_ID}/${SHA}.png`;
    await Promise.all([
      testPlatform().env.DESIGN_ARTWORK.put(abandonedKey, new Uint8Array([1])),
      testPlatform().env.DESIGN_ARTWORK.put(abandonedPreview, new Uint8Array([2])),
      testPlatform().env.DESIGN_ARTWORK.put(referencedKey, new Uint8Array([3])),
    ]);
    await db.batch([
      design(ABANDONED_ID, abandonedKey, NOW - 31 * DAY_MS),
      design(REFERENCED_ID, referencedKey, NOW - 31 * DAY_MS),
      db.prepare(`
        INSERT INTO products (
          id, base_product_id, design_id, shopify_handle,
          status, created_at, deleted_at
        ) VALUES ('referenced-product', ?, ?, 'referenced-product',
          'active', ?, NULL)
      `).bind(REFERENCED_ID, REFERENCED_ID, NOW - 31 * DAY_MS),
    ]);

    const report = await runScheduledPrivacyMaintenance({
      DB: db,
      DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
    }, () => NOW);

    expect(report).toMatchObject({ abandonedDrafts: 1, objectsDeleted: 2 });
    expect(await testPlatform().env.DESIGN_ARTWORK.head(abandonedKey)).toBeNull();
    expect(await testPlatform().env.DESIGN_ARTWORK.head(abandonedPreview)).toBeNull();
    expect(await testPlatform().env.DESIGN_ARTWORK.head(referencedKey)).not.toBeNull();
    const states = await db.prepare(`
      SELECT id, status, deleted_at FROM designs ORDER BY id
    `).all<{ deleted_at: number | null; id: string; status: string }>();
    expect(states.results).toEqual([
      { deleted_at: NOW, id: ABANDONED_ID, status: "deleted" },
      { deleted_at: null, id: REFERENCED_ID, status: "ready" },
    ]);
  });

  it("prevents modification of a recorded protected-data access", async () => {
    const db = testPlatform().env.DB;
    await db.prepare(`
      INSERT INTO personal_data_access_log (
        id, subject_hash, actor, action, purpose, occurred_at
      ) VALUES ('access', ?, 'system:shopify-webhook', 'receive',
        'paid-order-ingestion', ?)
    `).bind("a".repeat(64), NOW).run();
    await expect(db.prepare(`
      UPDATE personal_data_access_log SET purpose = 'fraud-address-line-validation'
      WHERE id = 'access'
    `).run()).rejects.toThrow(/immutable/u);
  });
});

function webhook(id: string, receivedAt: number, payload: string) {
  return testPlatform().env.DB.prepare(`
    INSERT INTO shopify_webhook_inbox (
      webhook_id, topic, shop_domain, api_version, payload_sha256,
      payload_json, status, received_at
    ) VALUES (?, 'orders/paid', 'bent-shirt.myshopify.com', '2026-07', ?, ?,
      'processed', ?)
  `).bind(id, "a".repeat(64), payload, receivedAt);
}

function design(id: string, artworkKey: string, updatedAt: number) {
  return testPlatform().env.DB.prepare(`
    INSERT INTO designs (
      id, owner_id, artwork_key, content_type, byte_size, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width,
      depth, status, version, finalized_at, created_at, updated_at, deleted_at
    ) VALUES (?, 'anonymous-owner', ?, 'image/png', 1, ?, 0.5, 0.5, 1,
      0.3, 0.3, 0.2, 5, 'ready', 1, NULL, ?, ?, NULL)
  `).bind(id, artworkKey, SHA, updatedAt, updatedAt);
}
