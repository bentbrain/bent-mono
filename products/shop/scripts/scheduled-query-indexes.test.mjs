import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationDirectory = new URL("../workers/api/drizzle/", import.meta.url);
const migrationName = "0033_print_recovery_and_scheduled_indexes.sql";
const migration = readFileSync(new URL(migrationName, migrationDirectory), "utf8");
const videoSource = readFileSync(new URL("../workers/api/src/story-video-jobs.ts", import.meta.url), "utf8");
const privacySource = readFileSync(new URL("../workers/api/src/privacy-maintenance.ts", import.meta.url), "utf8");

function query(source, start) {
  const position = source.indexOf(start);
  assert.ok(position >= 0, `Missing query: ${start}`);
  const end = source.indexOf("`", position);
  assert.ok(end > position);
  return source.slice(position, end);
}

const recovery = query(videoSource, "SELECT DISTINCT jobs.design_revision_id");
const leases = query(videoSource, "UPDATE story_video_jobs\n    SET status = 'queued'");
const drafts = query(privacySource, "SELECT id, artwork_key, sha256");

function measure(run, samples = 25) {
  const timings = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    run();
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  return Number(timings[Math.floor(timings.length / 2)].toFixed(3));
}

test("scheduled indexes preserve query results and avoid historical scans", () => {
  const db = new DatabaseSync(":memory:");
  try {
    // Only columns used by the production queries, with the relevant existing
    // indexes. Synthetic history is not a D1 latency estimate.
    db.exec(`
      CREATE TABLE products (id TEXT PRIMARY KEY, design_revision_id TEXT, video_design_revision_id TEXT, status TEXT, design_id TEXT,
        placement_depth INTEGER NOT NULL DEFAULT 5);
      CREATE INDEX products_design_idx ON products(design_id);
      CREATE TABLE story_video_jobs (id TEXT PRIMARY KEY, product_id TEXT, design_revision_id TEXT,
        renderer_version TEXT, status TEXT, attempt_count INTEGER, updated_at INTEGER, last_error TEXT);
      CREATE INDEX story_video_jobs_revision_status_idx ON story_video_jobs(design_revision_id, status);
      CREATE INDEX story_video_jobs_product_status_idx ON story_video_jobs(product_id, status);
      CREATE TABLE designs (id TEXT PRIMARY KEY, artwork_key TEXT, sha256 TEXT, owner_id TEXT,
        finalized_at INTEGER, deleted_at INTEGER, updated_at INTEGER);
      CREATE INDEX designs_owner_updated_idx ON designs(owner_id, updated_at);
      CREATE TABLE design_revisions (id TEXT PRIMARY KEY, design_id TEXT);
      CREATE INDEX design_revisions_design_created_idx ON design_revisions(design_id);
      BEGIN;
    `);
    const jobInsert = db.prepare("INSERT INTO story_video_jobs VALUES (?, ?, ?, 'current', ?, 0, ?, NULL)");
    const productInsert = db.prepare("INSERT INTO products (id, design_revision_id, status, design_id) VALUES (?, ?, 'active', ?)");
    const draftInsert = db.prepare("INSERT INTO designs VALUES (?, 'fixture', 'checksum', 'owner', ?, NULL, ?)");
    for (let index = 0; index < 100_000; index += 1) {
      const id = `row-${index}`;
      const status = index < 100 ? "rendering" : index < 150 ? "queued" : index < 200 ? "failed" : "ready";
      jobInsert.run(id, id, id, status, index);
      productInsert.run(id, id, `finalized-${index}`);
      draftInsert.run(id, index < 100 ? null : 1, index);
    }
    db.exec("COMMIT; ANALYZE;");
    const cases = [
      { name: "video recovery", sql: recovery, args: ["current", 3, 12], index: "story_video_jobs_recovery_idx" },
      { name: "expired leases", sql: leases, args: [100_000, 1_000, 3, null, null], index: "story_video_jobs_status_updated_idx" },
      { name: "abandoned drafts", sql: drafts, args: [1_000, 25], index: "designs_abandoned_updated_idx" },
    ];
    function observe(entry) {
      const statement = db.prepare(entry.sql);
      const read = entry.sql.startsWith("SELECT");
      const run = () => {
        if (read) return statement.all(...entry.args);
        db.exec("SAVEPOINT benchmark");
        const result = statement.run(...entry.args);
        db.exec("ROLLBACK TO benchmark; RELEASE benchmark");
        return result;
      };
      return {
        result: run(),
        medianMs: measure(run),
        plan: db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.args).map(row => row.detail),
      };
    }
    function writeCost() {
      return measure(() => {
        db.exec("SAVEPOINT write_cost");
        db.prepare("UPDATE story_video_jobs SET status = 'queued', updated_at = updated_at + 1 WHERE id IN (SELECT id FROM story_video_jobs LIMIT 1000)").run();
        db.prepare("UPDATE designs SET finalized_at = NULL, updated_at = updated_at + 1 WHERE id IN (SELECT id FROM designs LIMIT 1000)").run();
        db.exec("ROLLBACK TO write_cost; RELEASE write_cost");
      });
    }
    const before = cases.map(observe);
    const writeBefore = writeCost();
    db.exec(migration);
    db.exec("ANALYZE");
    const after = cases.map(observe);
    for (let index = 0; index < cases.length; index += 1) {
      assert.deepEqual(after[index].result, before[index].result);
      assert.ok(after[index].plan.some(detail => detail.includes(cases[index].index)), JSON.stringify(after[index].plan));
    }
    console.log("Synthetic SQLite scheduled-query benchmark", JSON.stringify({
      rowsPerTable: 100_000,
      queries: cases.map((entry, index) => ({ name: entry.name, before: before[index].medianMs,
        after: after[index].medianMs, beforePlan: before[index].plan, afterPlan: after[index].plan })),
      update2000RowsMedianMs: { before: writeBefore, after: writeCost() },
    }));
  } finally { db.close(); }
});

test("additive recovery migration applies after the full history and enforces retry ownership", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      db.exec(readFileSync(new URL(name, migrationDirectory), "utf8"));
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.prepare("INSERT INTO products (id, base_product_id, shopify_handle, created_at) VALUES ('recovery-test', 'recovery-test', 'fixture', 1)").run();
    db.prepare("INSERT INTO print_asset_retries VALUES ('recovery-test', 1, 'claim', 100, 1)").run();
    assert.throws(() => db.prepare("UPDATE print_asset_retries SET attempt_count = 0").run(), /CHECK/);
    db.prepare("DELETE FROM products WHERE id = 'recovery-test'").run();
    assert.equal(db.prepare("SELECT count(*) AS count FROM print_asset_retries").get().count, 0);
  } finally { db.close(); }
});
