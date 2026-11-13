import { catalogue } from "./shopify-fixture.mjs";
export async function seedCatalogue(db) {
  const now = Date.now();
  await db
    .prepare(
      "CREATE TABLE native_video_release_control(singleton INTEGER PRIMARY KEY,paused INTEGER,current_release_id TEXT)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO native_video_release_control VALUES(1,0,'native-123')",
    )
    .run();
  await db
    .prepare(
      "CREATE TABLE native_video_release_events(release_id TEXT NOT NULL,stage TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL,PRIMARY KEY(release_id,stage))",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO native_video_release_events VALUES('native-123','verified',?,?)",
    )
    .bind(
      JSON.stringify({
        worker: { printExecutor: { releaseId: "native-123" } },
      }),
      now,
    )
    .run();
  for (const handle of ["bent-shirt", "cotton-tote"]) {
    const product = catalogue(handle);
    const tote = handle === "cotton-tote";
    const base = tote
      ? "97b629d7-1d3b-4d2a-a586-537168141e97"
      : "a51b7acf-77e9-4762-83c4-62d96dd8942c";
    const slug = tote ? "cotton-tote" : "staple-tee";
    const snapshot = crypto.randomUUID();
    const mapping = crypto.randomUUID();
    const statements = [
      db
        .prepare(
          `INSERT INTO products(id,base_product_id,design_id,shopify_handle,status,created_at) VALUES(?,?,NULL,?,'active',?) ON CONFLICT(id) DO NOTHING`,
        )
        .bind(base, base, handle, now),
      db
        .prepare(
          `INSERT INTO printify_catalogue_snapshots(id,shop_id,base_product_id,base_product_slug,blueprint_id,print_provider_id,retrieved_at,source_urls_json,variant_count) VALUES(?,'synthetic-shop',?,?,?,34,?,'[]',?)`,
        )
        .bind(
          snapshot,
          base,
          slug,
          tote ? 553 : 440,
          now,
          product.variants.nodes.length,
        ),
      db
        .prepare(
          `INSERT INTO shopify_variant_mapping_snapshots(id,catalogue_snapshot_id,base_product_id,base_product_slug,shopify_product_id,shopify_product_handle,shopify_product_title,retrieved_at,source_url,variant_count) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          mapping,
          snapshot,
          base,
          slug,
          product.id,
          handle,
          product.title,
          now,
          "https://ci.myshopify.com/synthetic",
          product.variants.nodes.length,
        ),
    ];
    for (const [index, variant] of product.variants.nodes.entries()) {
      const color = variant.selectedOptions.find(
        (o) => o.name === "Color",
      ).value;
      const size = variant.selectedOptions.find((o) => o.name === "Size").value;
      const printifyId = (tote ? 70000 : 200) + index;
      statements.push(
        db
          .prepare(
            `INSERT INTO printify_catalogue_variants(snapshot_id,printify_variant_id,colour,size,available,decoration_method,print_width,print_height,shipping_first_item,shipping_additional_item,shipping_currency,handling_days_from,handling_days_to) VALUES(?,?,?,?,1,'DTG',?,?,639,139,'USD',3,6)`,
          )
          .bind(
            snapshot,
            printifyId,
            color,
            size,
            tote ? 2835 : 3600,
            tote ? 3425 : 4200,
          ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO shopify_variant_mappings(snapshot_id,shopify_variant_id,printify_variant_id,colour,size,sku,shopify_available) VALUES(?,?,?,?,?,?,1)`,
          )
          .bind(mapping, variant.id, printifyId, color, size, variant.sku),
      );
    }
    await db.batch(statements);
  }
}
