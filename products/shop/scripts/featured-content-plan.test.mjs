import { resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { featuredContentPlan } from "./featured-content-plan.mjs";
const proposal = JSON.parse(resolveProtectedTemplate(readFileSync(new URL("./fixtures/content/featured-396-398.json", import.meta.url), "utf8")));
const sql = readFileSync(new URL("../workers/api/sql/featured-content-396-398.sql", import.meta.url), "utf8");
const TOTE = "97b629d7-1d3b-4d2a-a586-537168141e97";
function inventory() {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(`
      CREATE TABLE products (id TEXT, design_id TEXT, design_revision_id TEXT, base_product_id TEXT,
        status TEXT, default_color TEXT, placement_x REAL, placement_y REAL, placement_width REAL,
        placement_depth INTEGER, projection_version TEXT);
      CREATE TABLE design_revisions (id TEXT, artwork_key TEXT, content_type TEXT, byte_size INTEGER,
        artwork_width INTEGER, artwork_height INTEGER, sha256 TEXT, crop_x REAL, crop_y REAL, crop_zoom REAL);
      CREATE TABLE paid_order_lines (configured_product_id TEXT);
      CREATE TABLE story_video_jobs (product_id TEXT, colour TEXT, status TEXT, renderer_version TEXT, story_key TEXT, attempt_count INTEGER);
      CREATE TABLE featured_product_state (id INTEGER, revision INTEGER);
      CREATE TABLE featured_products (slot INTEGER, product_id TEXT);
      INSERT INTO featured_product_state VALUES (1, 3);
    `);
        for (const { slot, productId, expected: p } of proposal.products) {
            db.prepare("INSERT INTO design_revisions VALUES (?,?,?,?,?,?,?,?,?,?)").run(p.design_revision_id, p.artwork_key, p.content_type, p.byte_size, p.artwork_width, p.artwork_height, p.sha256, p.crop_x, p.crop_y, p.crop_zoom);
            for (const [id, base] of [[productId, p.base_product_id], [`tote-${slot}`, TOTE]]) {
                db.prepare("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, p.design_id, p.design_revision_id, base, p.status, p.default_color, p.placement_x, p.placement_y, p.placement_width, p.placement_depth, p.projection_version);
                for (const colour of base === TOTE ? ["Black", "Cream"] : ["Black", "White"]) {
                    db.prepare("INSERT INTO story_video_jobs VALUES (?,?,?,?,?,?)").run(id, colour, "ready", "story-video-renderer-v7", `story-videos/v7/${p.design_revision_id}/${id}/${colour.toLowerCase()}.mp4`, 1);
                }
            }
            db.prepare("INSERT INTO featured_products VALUES (?,?)").run(slot, productId);
        }
        db.prepare("INSERT INTO paid_order_lines VALUES (?)").run(proposal.products[1].productId);
        db.prepare("INSERT INTO featured_products VALUES (5,'old-fifth-product')").run();
        // Execute the actual operator query in read-only mode, not a mock of its result.
        db.exec("PRAGMA query_only = ON");
        return sql.split(";").filter(statement => statement.trim()).map(statement => ({
            success: true, results: db.prepare(statement).all().map(row => ({ ...row })),
            meta: { changed_db: false, rows_written: 0 },
        }));
    }
    finally {
        db.close();
    }
}
test("inventory and plan preserve paid-order references and explicitly remove unselected slots", () => {
    const result = featuredContentPlan(inventory(), proposal.videoAttachment);
    assert.equal(result.mode, "review-only");
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.candidateFeaturedWorkflowInputs.expected_revision, "3");
    assert.equal(result.candidateFeaturedWorkflowInputs.slot_1, proposal.products[0].productId);
    assert.equal(result.candidateFeaturedWorkflowInputs.slot_5, "");
    assert.equal(result.candidateFeaturedWorkflowInputs.slot_6, "");
    assert.deepEqual(result.slotChanges, [{ slot: 5, before: "old-fifth-product", after: null }]);
    assert.equal(result.products[1].family.find(product => product.productId === proposal.products[1].productId).paidOrderLineCount, 1);
    assert.ok(result.products.flatMap(product => product.family).every(product => product.videoLedgerReady && !product.videoObjectVerified));
    assert.deepEqual(result.unresolved, ["fifth-product", "owner-chair-photo", "white-shirt-print-and-video-separation"]);
});
test("rejects changed immutable artwork, placements, product identity and incomplete families", () => {
    for (const change of [
        input => { input[0].results[0].sha256 = "f".repeat(64); },
        input => { input[0].results[0].placement_depth = 1; },
        input => { input[0].results[0].design_revision_id = "different"; },
        input => { input[0].results.pop(); },
        input => { input[1].results.find(row => row.base_product_id === TOTE).status = "suspended"; },
        input => { input[1].results.find(row => row.base_product_id === TOTE).design_revision_id = "different"; },
        input => { input[1].results.push({ ...input[1].results[0], id: "duplicate-family" }); },
    ]) {
        const input = inventory();
        change(input);
        assert.throws(() => featuredContentPlan(input, proposal.videoAttachment));
    }
});
test("rejects failed or mutating inventory, missing configuration and wrong attachment", () => {
    for (const change of [
        input => { input[0].success = false; },
        input => { input[0].meta.rows_written = 1; },
        input => { input[0].meta.changed_db = true; },
        input => { input[2].results = []; },
        input => { input[2].results[0].revision = -1; },
    ]) {
        const input = inventory();
        change(input);
        assert.throws(() => featuredContentPlan(input, proposal.videoAttachment));
    }
    assert.throws(() => featuredContentPlan(inventory(), { ...proposal.videoAttachment, sha256: "f".repeat(64) }), /attachment/);
    assert.throws(() => featuredContentPlan(inventory(), { ...proposal.videoAttachment, byteSize: 1 }), /attachment/);
});
test("missing, failed and wrongly addressed videos request inspection without regeneration", () => {
    for (const jobs of [[], [{ colour: "Black", status: "failed" }], [
            { colour: "Black", status: "ready", rendererVersion: "story-video-renderer-v7", storyKey: "wrong" },
            { colour: "Cream", status: "ready", rendererVersion: "story-video-renderer-v7", storyKey: "wrong" },
        ]]) {
        const input = inventory();
        input[1].results[0].videos = JSON.stringify(jobs);
        const result = featuredContentPlan(input, proposal.videoAttachment);
        const affected = result.products.flatMap(product => product.family).find(row => row.productId === input[1].results[0].id);
        assert.equal(affected.videoLedgerReady, false);
        assert.equal(affected.action, "inspect-missing-or-failed-story-videos");
        assert.equal(result.executionAuthorized, false);
    }
});
