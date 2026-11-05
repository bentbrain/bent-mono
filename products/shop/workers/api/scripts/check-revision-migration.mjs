import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { getPlatformProxy } from "wrangler";

const migrationNames = [
  "0000_loving_king_bedlam.sql",
  "0001_faulty_taskmaster.sql",
  "0002_separate_product_design_ids.sql",
  "0003_idempotent-configured-products.sql",
];
const configuredDesignId = "1c22bf7e-e698-4a0a-90c4-66c5549f1c45";
const creatingStoredDesignId = "66d755f9-49bb-45a0-ad4d-2f94876e77e3";
const deletedOnlyDesignId = "dd992fb7-e6c1-4fe5-8cab-89b50f1c2694";
const pendingDesignId = "b046df8c-61ca-407e-a3bc-201382426215";
const postMigrationDesignId = "0bcd361e-21ae-489c-9e35-418bf7c2a358";
const postMigrationProductId = "556a3c42-20da-41e8-8a32-79272139ad64";
const deployRaceDesignId = "b43d55df-5a1c-4b10-9c69-51fa9509ae20";
const deployRaceProductId = "de5ea123-7679-491e-b439-1b61bef924e2";
const placementRaceDesignId = "a1b07f7a-0e3f-4c8e-bfc2-bc23d2bfb81e";
const placementRaceProductId = "db579713-84ae-4d30-97dc-07f1edca4f67";

function statements(sql) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function applySql(db, sql) {
  for (const statement of statements(sql)) {
    await db.prepare(statement).run();
  }
}

async function migrationSql(name) {
  return readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
}

async function catchUpSql() {
  return readFile(
    new URL("../sql/catch-up-design-revisions.sql", import.meta.url),
    "utf8",
  );
}

async function placementCatchUpSql() {
  return readFile(
    new URL("../sql/catch-up-configured-product-placement.sql", import.meta.url),
    "utf8",
  );
}

async function seedDesign(db, id, status, sha256) {
  const artworkKey = sha256 === "" ? `designs/${id}/pending` : `designs/${id}/artwork/${sha256}`;
  await db.prepare(`
    INSERT INTO designs (
      id, owner_id, artwork_key, content_type, byte_size, sha256,
      crop_x, crop_y, crop_zoom, placement_x, placement_y,
      placement_width, depth, status, created_at, updated_at, deleted_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 0.5, 0.5, 1, 0.39, 0.43, 0.22, 5, ?, ?, ?, ?)
  `).bind(
    id,
    artworkKey,
    sha256 === "" ? "application/octet-stream" : "image/png",
    sha256 === "" ? 0 : 128,
    sha256,
    status,
    1786831200000,
    1786831260000,
    status === "deleted" ? 1786831320000 : null,
  ).run();
}

async function seedProduct(db, id, designId, status) {
  await db.prepare(`
    INSERT INTO products (
      id, base_product_id, design_id, shopify_handle,
      status, created_at, deleted_at
    ) VALUES (?, 'a51b7acf-77e9-4762-83c4-62d96dd8942c', ?, 'bent-shirt', ?, ?, ?)
  `).bind(
    id,
    designId,
    status,
    1786831380000,
    status === "deleted" ? 1786831440000 : null,
  ).run();
}

const platform = await getPlatformProxy({
  configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: false,
});

try {
  for (const name of migrationNames) {
    await applySql(platform.env.DB, await migrationSql(name));
  }

  await seedDesign(platform.env.DB, configuredDesignId, "ready", "a".repeat(64));
  await seedProduct(
    platform.env.DB,
    "9bbfc2c9-3bba-49d4-aab5-ab5fa5872071",
    configuredDesignId,
    "active",
  );
  await seedProduct(
    platform.env.DB,
    "5e7dd974-ce7e-42a6-b126-526008d00cd5",
    configuredDesignId,
    "deleted",
  );
  await seedDesign(platform.env.DB, deletedOnlyDesignId, "deleted", "b".repeat(64));
  await seedProduct(
    platform.env.DB,
    "3ae1892d-e53a-4e82-8dc2-2cc63929194c",
    deletedOnlyDesignId,
    "deleted",
  );
  await seedDesign(platform.env.DB, pendingDesignId, "creating", "");
  await seedProduct(
    platform.env.DB,
    "68020929-65d5-49ad-9a57-cfcb2fed440f",
    pendingDesignId,
    "active",
  );
  await seedDesign(
    platform.env.DB,
    creatingStoredDesignId,
    "creating",
    "c".repeat(64),
  );
  await seedProduct(
    platform.env.DB,
    "67171b10-bbbb-46ce-b7c7-2b9fcae051c9",
    creatingStoredDesignId,
    "active",
  );
  await seedDesign(
    platform.env.DB,
    postMigrationDesignId,
    "ready",
    "d".repeat(64),
  );

  const revisionMigration = await migrationSql("0004_immutable_revision_ledger.sql");
  await applySql(platform.env.DB, revisionMigration);

  const revisions = await platform.env.DB.prepare(`
    SELECT id, design_id, fingerprint FROM design_revisions ORDER BY id
  `).all();
  assert.equal(revisions.results.length, 3);
  assert.deepEqual(revisions.results, [
    {
      id: configuredDesignId,
      design_id: configuredDesignId,
      fingerprint: `legacy-v1:${configuredDesignId}:${"a".repeat(64)}`,
    },
    {
      id: creatingStoredDesignId,
      design_id: creatingStoredDesignId,
      fingerprint: `legacy-v1:${creatingStoredDesignId}:${"c".repeat(64)}`,
    },
    {
      id: deletedOnlyDesignId,
      design_id: deletedOnlyDesignId,
      fingerprint: `legacy-v1:${deletedOnlyDesignId}:${"b".repeat(64)}`,
    },
  ]);

  const productLinks = await platform.env.DB.prepare(`
    SELECT design_id, design_revision_id, status
    FROM products
    WHERE design_id IN (?, ?, ?, ?)
    ORDER BY design_id, status
  `).bind(
    configuredDesignId,
    creatingStoredDesignId,
    deletedOnlyDesignId,
    pendingDesignId,
  ).all();
  assert.deepEqual(productLinks.results, [
    { design_id: configuredDesignId, design_revision_id: configuredDesignId, status: "active" },
    { design_id: configuredDesignId, design_revision_id: configuredDesignId, status: "deleted" },
    { design_id: creatingStoredDesignId, design_revision_id: creatingStoredDesignId, status: "active" },
    { design_id: pendingDesignId, design_revision_id: null, status: "active" },
    { design_id: deletedOnlyDesignId, design_revision_id: deletedOnlyDesignId, status: "deleted" },
  ]);

  const backfillStatements = statements(revisionMigration).filter((statement) =>
    statement.startsWith("INSERT INTO `design_revisions`") ||
    statement.startsWith("UPDATE `products`") ||
    statement.startsWith("UPDATE `designs`")
  );
  await applySql(platform.env.DB, backfillStatements.join("--> statement-breakpoint"));
  const countAfterRetry = await platform.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM design_revisions",
  ).first();
  assert.equal(countAfterRetry?.count, 3);

  await seedProduct(
    platform.env.DB,
    postMigrationProductId,
    postMigrationDesignId,
    "active",
  );
  const catchUpCandidates = await platform.env.DB.prepare(`
    SELECT id FROM products
    WHERE design_id IS NOT NULL AND design_revision_id IS NULL
    ORDER BY id
  `).all();
  assert.deepEqual(catchUpCandidates.results, [
    { id: postMigrationProductId },
    { id: "68020929-65d5-49ad-9a57-cfcb2fed440f" },
  ]);
  const postMigrationRevision = await platform.env.DB.prepare(
    "SELECT id FROM design_revisions WHERE design_id = ?",
  ).bind(postMigrationDesignId).first();
  assert.equal(postMigrationRevision, null);

  const catchUpMigration = await migrationSql(
    "0005_catch_up_revision_links.sql",
  );
  await applySql(platform.env.DB, catchUpMigration);
  await applySql(platform.env.DB, catchUpMigration);
  const postMigrationLink = await platform.env.DB.prepare(`
    SELECT products.design_revision_id, design_revisions.fingerprint
    FROM products
    LEFT JOIN design_revisions
      ON design_revisions.id = products.design_revision_id
    WHERE products.id = ?
  `).bind(postMigrationProductId).first();
  const expectedPostMigrationFingerprint = await platform.env.DB.prepare(`
    SELECT 'revision-v1:' || sha256 || ':settings-v1:' || printf(
      '%!.17g,%!.17g,%!.17g,%!.17g,%!.17g,%!.17g,%!.17g',
      crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth
    ) AS fingerprint
    FROM designs WHERE id = ?
  `).bind(postMigrationDesignId).first();
  assert.deepEqual(postMigrationLink, {
    design_revision_id: postMigrationProductId,
    fingerprint: expectedPostMigrationFingerprint?.fingerprint,
  });
  const pendingAfterCatchUp = await platform.env.DB.prepare(
    "SELECT design_revision_id FROM products WHERE design_id = ?",
  ).bind(pendingDesignId).first();
  assert.deepEqual(pendingAfterCatchUp, { design_revision_id: null });

  await seedDesign(
    platform.env.DB,
    deployRaceDesignId,
    "ready",
    "e".repeat(64),
  );
  await seedProduct(
    platform.env.DB,
    deployRaceProductId,
    deployRaceDesignId,
    "active",
  );
  const residualRace = await platform.env.DB.prepare(
    "SELECT design_revision_id FROM products WHERE id = ?",
  ).bind(deployRaceProductId).first();
  assert.deepEqual(residualRace, { design_revision_id: null });

  const postDeployCatchUp = await catchUpSql();
  await applySql(platform.env.DB, postDeployCatchUp);
  await applySql(platform.env.DB, postDeployCatchUp);
  const caughtUpRace = await platform.env.DB.prepare(
    "SELECT design_revision_id FROM products WHERE id = ?",
  ).bind(deployRaceProductId).first();
  assert.deepEqual(caughtUpRace, { design_revision_id: deployRaceProductId });
  const remainingStoredNulls = await platform.env.DB.prepare(`
    SELECT products.id
    FROM products
    JOIN designs ON designs.id = products.design_id
    WHERE products.design_revision_id IS NULL
      AND designs.sha256 <> ''
      AND designs.artwork_key <> 'designs/' || designs.id || '/pending'
  `).all();
  assert.deepEqual(remainingStoredNulls.results, []);

  await applySql(platform.env.DB, await migrationSql("0011_reusable_design_revisions.sql"));
  const migratedPlacement = await platform.env.DB.prepare(`
    SELECT placement_x, placement_y, placement_width, placement_depth
    FROM products WHERE id = ?
  `).bind("9bbfc2c9-3bba-49d4-aab5-ab5fa5872071").first();
  assert.deepEqual(migratedPlacement, {
    placement_x: 0.39,
    placement_y: 0.43,
    placement_width: 0.22,
    placement_depth: 5,
  });
  const toteBaseProduct = await platform.env.DB.prepare(`
    SELECT id, base_product_id, design_id FROM products WHERE id = ?
  `).bind("97b629d7-1d3b-4d2a-a586-537168141e97").first();
  assert.deepEqual(toteBaseProduct, {
    id: "97b629d7-1d3b-4d2a-a586-537168141e97",
    base_product_id: "97b629d7-1d3b-4d2a-a586-537168141e97",
    design_id: null,
  });

  await seedDesign(
    platform.env.DB,
    placementRaceDesignId,
    "ready",
    "f".repeat(64),
  );
  await seedProduct(
    platform.env.DB,
    placementRaceProductId,
    placementRaceDesignId,
    "active",
  );
  const placementRaceBeforeCatchUp = await platform.env.DB.prepare(`
    SELECT placement_x, placement_y, placement_width, placement_depth
    FROM products WHERE id = ?
  `).bind(placementRaceProductId).first();
  assert.deepEqual(placementRaceBeforeCatchUp, {
    placement_x: null,
    placement_y: null,
    placement_width: null,
    placement_depth: null,
  });
  await applySql(platform.env.DB, postDeployCatchUp);
  const placementCatchUp = await placementCatchUpSql();
  await applySql(platform.env.DB, placementCatchUp);
  await applySql(platform.env.DB, placementCatchUp);
  const placementRaceAfterCatchUp = await platform.env.DB.prepare(`
    SELECT placement_x, placement_y, placement_width, placement_depth
    FROM products WHERE id = ?
  `).bind(placementRaceProductId).first();
  assert.deepEqual(placementRaceAfterCatchUp, {
    placement_x: 0.39,
    placement_y: 0.43,
    placement_width: 0.22,
    placement_depth: 5,
  });

  await applySql(
    platform.env.DB,
    await migrationSql("0013_versioned_product_projections.sql"),
  );
  const projectionVersions = await platform.env.DB.prepare(`
    SELECT id, projection_version FROM products
    WHERE id IN (?, ?, ?)
    ORDER BY id
  `).bind(
    placementRaceProductId,
    "9bbfc2c9-3bba-49d4-aab5-ab5fa5872071",
    "97b629d7-1d3b-4d2a-a586-537168141e97",
  ).all();
  assert.deepEqual(projectionVersions.results, [
    {
      id: "97b629d7-1d3b-4d2a-a586-537168141e97",
      projection_version: null,
    },
    {
      id: "9bbfc2c9-3bba-49d4-aab5-ab5fa5872071",
      projection_version: "legacy-shirt-v1",
    },
    {
      id: placementRaceProductId,
      projection_version: "legacy-shirt-v1",
    },
  ]);
  const historicalArtworkDimensions = await platform.env.DB.prepare(`
    SELECT designs.artwork_width, designs.artwork_height,
      design_revisions.artwork_width AS revision_width,
      design_revisions.artwork_height AS revision_height
    FROM designs
    JOIN design_revisions ON design_revisions.design_id = designs.id
    WHERE designs.id = ?
  `).bind(configuredDesignId).first();
  assert.deepEqual(historicalArtworkDimensions, {
    artwork_width: null,
    artwork_height: null,
    revision_width: null,
    revision_height: null,
  });

  await assert.rejects(
    platform.env.DB.prepare(`
      INSERT INTO design_revisions (
        id, design_id, fingerprint, artwork_key, content_type, byte_size,
        sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y,
        placement_width, depth, created_at
      ) SELECT ?, design_id, fingerprint, artwork_key, content_type, byte_size,
        sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y,
        placement_width, depth, created_at
      FROM design_revisions WHERE id = ?
    `).bind("6d035a71-a9ef-438a-aa3a-21f181496543", configuredDesignId).run(),
  );
} finally {
  await platform.dispose();
}
