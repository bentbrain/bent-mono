import { resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compositionOperation } from "./featured-composition-worker.mjs";
import { compositionRecords, compositionStatements, inspectComposition } from "./featured-composition-records.mjs";
const manifest = JSON.parse(resolveProtectedTemplate(readFileSync(new URL("./fixtures/content/featured-398-approved.json", import.meta.url))));
function fixture() {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const directory = new URL("../workers/api/drizzle/", import.meta.url);
    for (const name of readdirSync(directory).filter(n => n.endsWith(".sql")).sort())
        db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.exec("CREATE TABLE native_video_release_control(singleton INTEGER PRIMARY KEY,paused INTEGER,release_id TEXT,current_release_id TEXT); INSERT INTO native_video_release_control VALUES(1,0,NULL,'native-12345')");
    return db;
}
function execute(db, statements) {
    db.exec("BEGIN");
    try {
        for (const statement of statements)
            db.prepare(statement.sql).run(...statement.params);
        db.exec("COMMIT");
    }
    catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
const adapter = db => ({ prepare(sql) { return { bind(...values) { return { async first() { return db.prepare(sql).get(...values) ?? null; } }; } }; } });
test("new composition transaction creates exactly two immutable sources, products and four jobs with safe same-ID recovery", async () => {
    const db = fixture();
    try {
        const before = db.prepare("SELECT * FROM products ORDER BY id").all();
        execute(db, compositionStatements(manifest, "native-12345", "development"));
        assert.equal(await inspectComposition(adapter(db), manifest), true);
        assert.equal(db.prepare("SELECT count(*) AS n FROM design_revisions WHERE design_id=?").get(manifest.designId).n, 2);
        assert.equal(db.prepare("SELECT count(*) AS n FROM story_video_jobs WHERE design_revision_id=?").get(manifest.outerRevisionId).n, 4);
        for (const old of before)
            assert.deepEqual(db.prepare("SELECT * FROM products WHERE id=?").get(old.id), old);
        assert.throws(() => execute(db, compositionStatements(manifest, "native-12345", "development")), /UNIQUE/);
        assert.equal(await inspectComposition(adapter(db), manifest), true);
        assert.throws(() => db.prepare("UPDATE design_revisions SET video_placement_y=.2 WHERE id=?").run(manifest.innerRevisionId), /immutable/);
    }
    finally {
        db.close();
    }
});
test("changed release, paused admission and stale featured preconditions create no partial records", () => {
    for (const kind of ["different-release", "paused", "featured"]) {
        const db = fixture();
        try {
            if (kind === "paused")
                db.exec("UPDATE native_video_release_control SET paused=1");
            execute(db, compositionStatements(manifest, kind === "different-release" ? "native-54321" : "native-12345", kind === "featured" ? "production" : "development"));
            assert.equal(db.prepare("SELECT count(*) AS n FROM designs WHERE id=?").get(manifest.designId).n, 0);
            assert.equal(db.prepare("SELECT count(*) AS n FROM design_revisions WHERE design_id=?").get(manifest.designId).n, 0);
            assert.equal(db.prepare("SELECT count(*) AS n FROM story_video_jobs WHERE design_revision_id=?").get(manifest.outerRevisionId).n, 0);
        }
        finally {
            db.close();
        }
    }
});
test("failure halfway through a D1-style batch rolls back all new records", () => {
    const db = fixture();
    try {
        const statements = compositionStatements(manifest, "native-12345", "development");
        statements.splice(4, 0, { sql: "INSERT INTO missing_table VALUES(1)", params: [] });
        assert.throws(() => execute(db, statements), /missing_table/);
        assert.equal(db.prepare("SELECT count(*) AS n FROM designs WHERE id=?").get(manifest.designId).n, 0);
    }
    finally {
        db.close();
    }
});
test("malformed sources, duplicate IDs, invalid placement and unexpected product variants are rejected", () => {
    for (const mutate of [m => m.innerRevisionId = m.outerRevisionId, m => m.sources[1].placement.placementY = .9,
        m => m.sources[1].sha256 = m.sources[0].sha256, m => m.sources[0].crop.cropZoom = 0, m => m.products[0].baseProductId = "foreign",
        m => m.jobs[0].colour = "Red", m => m.jobs[0].id = m.jobs[1].id]) {
        const value = structuredClone(manifest);
        mutate(value);
        assert.throws(() => compositionRecords(value), /rejected/);
    }
});
test("failed synthetic fixture cleanup refuses active jobs, then removes rows with a keyless failed print and is resumable", async () => {
    const db = fixture(), objects = new Map(), deleted = [];
    const d1 = { prepare(sql) { return { bind(...params) { return { sql, params, async first() { return db.prepare(sql).get(...params) ?? null; }, async all() { return { results: db.prepare(sql).all(...params) }; }, async run() { return db.prepare(sql).run(...params); } }; } }; }, async batch(statements) { execute(db, statements); } };
    const bucket = { async get(key) { const value = objects.get(key); return value === undefined ? null : { async json() { return JSON.parse(value); } }; }, async put(key, value) { objects.set(key, value); }, async head(key) { return objects.has(key) ? {} : null; }, async delete(key) { assert.equal(typeof key, "string"); deleted.push(key); objects.delete(key); } };
    const intentKey = "fixture-intent", secret = "a".repeat(64), worker = compositionOperation(manifest, "native-12345", "development", intentKey, "123");
    const request = () => new Request("https://fixture.invalid", { method: "DELETE", headers: { Authorization: `Bearer ${secret}` } });
    const bindings = { DB: d1, DESIGN_ARTWORK: bucket, STORY_VIDEOS: bucket, OPERATION_SECRET: secret };
    objects.set(intentKey, JSON.stringify({ manifest }));
    try {
        execute(db, compositionStatements(manifest, "native-12345", "development"));
        const p = manifest.products[1];
        db.prepare("INSERT INTO print_assets(id,configured_product_id,design_revision_id,base_product_id,projection_version,geometry_key,status,created_at,updated_at) VALUES('failed-print',?,?,?,'safe-margin-v1','dtg:4682x5291','failed',1,1)").run(p.id, manifest.outerRevisionId, p.baseProductId);
        assert.equal((await worker.fetch(request(), bindings)).status, 409);
        assert.equal(deleted.length, 0);
        db.prepare("UPDATE story_video_jobs SET status='failed' WHERE design_revision_id=?").run(manifest.outerRevisionId);
        assert.deepEqual(await (await worker.fetch(request(), bindings)).json(), { cleaned: true });
        assert.equal(db.prepare("SELECT count(*) AS n FROM print_assets WHERE id='failed-print'").get().n, 0);
        assert.equal(db.prepare("SELECT count(*) AS n FROM designs WHERE id=?").get(manifest.designId).n, 0);
        assert.equal(deleted.length, 6);
        assert.deepEqual(await (await worker.fetch(request(), bindings)).json(), { cleaned: true });
    }
    finally {
        db.close();
    }
});
