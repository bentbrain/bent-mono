import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = readFileSync(new URL("../workers/api/drizzle/0039_featured_media_composition.sql", import.meta.url), "utf8");
const placementMigration = readFileSync(new URL("../workers/api/drizzle/0040_recursive_video_placement.sql", import.meta.url), "utf8");
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE designs (id TEXT PRIMARY KEY, status TEXT);
    INSERT INTO designs VALUES ('design','active'),('replacement','active');
    CREATE TABLE design_revisions (id TEXT PRIMARY KEY, design_id TEXT, sha256 TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, design_id TEXT, design_revision_id TEXT REFERENCES design_revisions(id),
      status TEXT, placement_x REAL, placement_y REAL, placement_width REAL, placement_depth INTEGER, projection_version TEXT);
    CREATE TABLE paid_order_lines (id TEXT PRIMARY KEY, configured_product_id TEXT REFERENCES products(id),
      design_revision_id TEXT REFERENCES design_revisions(id), print_asset_sha256 TEXT);
    INSERT INTO design_revisions VALUES ('old','design','old-hash'),('outer','replacement','outer-hash'),
      ('inner','replacement','inner-hash'),('different','elsewhere','different-hash');
    INSERT INTO products VALUES ('paid-product','design','old','active',0.3,0.3,0.2,5,'safe-margin-v1');
    INSERT INTO paid_order_lines VALUES ('paid-line','paid-product','old','paid-print-hash');`);
  db.exec(migration);
  return db;
}
function insert(db, id = "new-shirt", source = "inner", revision = "outer") {
  db.prepare(`INSERT INTO products (id,design_id,design_revision_id,status,print_mode,video_recursive_revision_id)
    VALUES (?,'replacement',?,'active','base-image-only',?)`).run(id, revision, source);
}
test("independent video placement is optional, bounded, complete and immutable once published", () => {
  const db = fixture();
  try {
    db.exec(placementMigration);
    assert.deepEqual({ ...db.prepare("SELECT video_placement_x,video_placement_y,video_placement_width FROM design_revisions WHERE id='old'").get() },
      { video_placement_x: null, video_placement_y: null, video_placement_width: null });
    const update = db.prepare("UPDATE design_revisions SET video_placement_x=?,video_placement_y=?,video_placement_width=? WHERE id='inner'");
    for (const values of [[null, .48, .45], [.26, null, .45], [.26, .48, null], [-.1, .48, .45], [.6, .48, .45], [.26, .6, .45], [.26, .48, 0], ['bad', .48, .45]]) {
      assert.throws(() => update.run(...values), /CHECK constraint/);
    }
    update.run(.267994, .48, .455717);
    insert(db);
    assert.throws(() => update.run(.267994, .4, .455717), /immutable/);
    assert.throws(() => update.run(null, null, null), /immutable/);
    assert.equal(db.prepare("SELECT video_placement_y FROM design_revisions WHERE id='inner'").get().video_placement_y, .48);
  } finally { db.close(); }
});
test("migration preserves legacy product and paid snapshot while new pairs share immutable two-source identity", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM paid_order_lines").get();
    insert(db); insert(db, "new-tote");
    assert.deepEqual(db.prepare("SELECT * FROM paid_order_lines").get(), before);
    assert.deepEqual({ ...db.prepare("SELECT print_mode,video_recursive_revision_id FROM products WHERE id='paid-product'").get() },
      { print_mode: "recursive", video_recursive_revision_id: null });
    assert.throws(() => db.exec("UPDATE products SET print_mode='base-image-only', video_recursive_revision_id='inner' WHERE id='paid-product'"), /immutable/);
    assert.throws(() => db.exec("UPDATE products SET video_recursive_revision_id='different' WHERE id='new-shirt'"), /immutable/);
    assert.throws(() => db.exec("UPDATE products SET placement_depth=1 WHERE id='new-shirt'"), /immutable/);
    assert.throws(() => db.exec("UPDATE design_revisions SET sha256='changed' WHERE id='inner'"), /immutable/);
    assert.throws(() => db.exec("UPDATE design_revisions SET sha256='changed' WHERE id='outer'"), /immutable/);
    assert.throws(() => db.exec("DELETE FROM design_revisions WHERE id='inner'"), /FOREIGN KEY/);
    assert.throws(() => db.exec("INSERT OR REPLACE INTO design_revisions VALUES ('inner','replacement','changed')"), /cannot be replaced/);
    assert.throws(() => db.exec("INSERT OR REPLACE INTO products(id,design_id,design_revision_id,status) VALUES('new-shirt','replacement','outer','active')"), /cannot be replaced/);
  } finally { db.close(); }
});
test("new compositions reject other designs, missing sources and mixed sibling compositions", () => {
  const db = fixture();
  try {
    for (const source of [null, "outer", "different", "missing"]) assert.throws(() => insert(db, "invalid", source));
    insert(db);
    assert.throws(() => db.exec("INSERT INTO products(id,design_id,design_revision_id,status) VALUES('mixed','replacement','outer','active')"), /composition/);
    assert.throws(() => insert(db, "existing-revision", "inner", "old"), /composition/);
  } finally { db.close(); }
});
for (const status of ["deleted", "suspended", "unpublished", "retired"]) {
  test(`deleted designs may release both references on ${status} products after application retention checks`, () => {
    const db = fixture();
    try {
      insert(db);
      const clear = "UPDATE products SET design_revision_id=NULL,video_recursive_revision_id=NULL WHERE id='new-shirt'";
      assert.throws(() => db.exec(clear), /immutable/);
      db.prepare("UPDATE products SET status=? WHERE id='new-shirt'").run(status);
      assert.throws(() => db.exec(clear), /immutable/);
      db.exec("UPDATE designs SET status='deleted' WHERE id='replacement'");
      assert.throws(() => db.exec("UPDATE products SET video_recursive_revision_id=NULL WHERE id='new-shirt'"), /immutable/);
      assert.throws(() => db.exec("UPDATE products SET design_revision_id=NULL,video_recursive_revision_id=NULL,placement_depth=1 WHERE id='new-shirt'"), /immutable/);
      db.exec(clear);
      db.exec("DELETE FROM design_revisions WHERE id IN ('outer','inner')");
      assert.equal(db.prepare("SELECT status FROM products WHERE id='new-shirt'").get().status, status);
      assert.equal(db.prepare("SELECT print_asset_sha256 FROM paid_order_lines").get().print_asset_sha256, "paid-print-hash");
    } finally { db.close(); }
  });
}
