import { resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { compositionOperation } from "./featured-composition-worker.mjs";
import { syntheticCompositionManifest, syntheticCompositionSource } from "../workers/video-renderer/qualification/composition-fixture.mjs";
const approved = JSON.parse(resolveProtectedTemplate(readFileSync(new URL("./fixtures/content/featured-398-approved.json", import.meta.url))));
function fixture() {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const directory = new URL("../workers/api/drizzle/", import.meta.url);
    for (const name of readdirSync(directory).filter(n => n.endsWith(".sql")).sort())
        db.exec(readFileSync(new URL(name, directory), "utf8"));
    db.exec("CREATE TABLE native_video_release_control(singleton INTEGER PRIMARY KEY,paused INTEGER,release_id TEXT,current_release_id TEXT); INSERT INTO native_video_release_control VALUES(1,0,NULL,'native-12345')");
    const prepare = sql => ({ bind(...params) { return { sql, params, async first() { return db.prepare(sql).get(...params) ?? null; }, async all() { return { results: db.prepare(sql).all(...params) }; }, async run() { return { meta: db.prepare(sql).run(...params) }; } }; } });
    const DB = { prepare, async batch(statements) { db.exec("BEGIN"); try {
            const results = statements.map(s => ({ meta: db.prepare(s.sql).run(...s.params) }));
            db.exec("COMMIT");
            return results;
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        } } };
    const objects = new Map();
    const bucket = { async get(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length, async arrayBuffer() { return new Uint8Array(bytes).buffer; }, async json() { return JSON.parse(bytes.toString()); } } : null; },
        async head(key) { return objects.has(key) ? { size: objects.get(key).length } : null; }, async put(key, value) { objects.set(key, Buffer.from(value)); }, async delete(key) { objects.delete(key); } };
    const manifest = syntheticCompositionManifest({ ...approved, sources: approved.sources.map(s => ({ ...s, width: 64, height: 80 })) });
    const intentKey = "editorial/test-intent.json";
    objects.set(intentKey, Buffer.from(JSON.stringify({ manifest })));
    for (const source of manifest.sources)
        objects.set(`designs/${manifest.designId}/artwork/${source.sha256}`, syntheticCompositionSource(source));
    const env = { DB, DESIGN_ARTWORK: bucket, STORY_VIDEOS: bucket, OPERATION_SECRET: "s".repeat(64) };
    const operation = compositionOperation(manifest, "native-12345", "development", intentKey, "12345");
    const request = (method, token = env.OPERATION_SECRET) => new Request("https://fixture.test", { method, headers: { authorization: `Bearer ${token}` } });
    return { db, objects, manifest, env, operation, request, intentKey };
}
test("temporary operation authenticates the exact saved intent and verified sources before its one atomic commit", async () => {
    const f = fixture();
    try {
        assert.equal((await f.operation.fetch(f.request("POST", "wrong"), f.env)).status, 401);
        const key = `designs/${f.manifest.designId}/artwork/${f.manifest.sources[1].sha256}`, bytes = f.objects.get(key);
        f.objects.set(key, Buffer.from("corrupt"));
        assert.equal((await f.operation.fetch(f.request("POST"), f.env)).status, 409);
        assert.equal(f.db.prepare("SELECT count(*) AS n FROM designs WHERE id=?").get(f.manifest.designId).n, 0);
        f.objects.set(key, bytes);
        assert.deepEqual(await (await f.operation.fetch(f.request("POST"), f.env)).json(), { committed: true, replayed: false });
        assert.deepEqual(await (await f.operation.fetch(f.request("POST"), f.env)).json(), { committed: true, replayed: true });
        const snapshot = await (await f.operation.fetch(f.request("GET"), f.env)).json();
        assert.equal(snapshot.committed, true);
        assert.equal(snapshot.videos.length, 4);
        assert.equal((await f.operation.fetch(f.request("DELETE"), f.env)).status, 409, "active jobs cannot be cleaned up");
        f.db.prepare("UPDATE story_video_jobs SET status='failed',attempt_count=3 WHERE design_revision_id=?").run(f.manifest.outerRevisionId);
        assert.deepEqual(await (await f.operation.fetch(f.request("DELETE"), f.env)).json(), { cleaned: true });
        assert.equal(f.db.prepare("SELECT count(*) AS n FROM designs WHERE id=?").get(f.manifest.designId).n, 0);
    }
    finally {
        f.db.close();
    }
});
test("missing operation secret and altered durable intent cannot authorize writes", async () => {
    const f = fixture();
    try {
        assert.equal((await f.operation.fetch(f.request("POST", "undefined"), { ...f.env, OPERATION_SECRET: undefined })).status, 401);
        f.objects.set(f.intentKey, Buffer.from(JSON.stringify({ manifest: { ...f.manifest, commandId: "changed" } })));
        assert.equal((await f.operation.fetch(f.request("POST"), f.env)).status, 409);
    }
    finally {
        f.db.close();
    }
});
test("readiness authenticates the saved intent without creating products or jobs", async () => {
    const f = fixture();
    try {
        const request = token => new Request("https://fixture.test/health", { headers: { authorization: `Bearer ${token}` } });
        assert.equal((await f.operation.fetch(request("wrong"), f.env)).status, 401);
        assert.deepEqual(await (await f.operation.fetch(request(f.env.OPERATION_SECRET), f.env)).json(), { ready: true, runId: "12345" });
        assert.equal(f.db.prepare("SELECT count(*) AS n FROM designs WHERE id=?").get(f.manifest.designId).n, 0);
        assert.equal(f.db.prepare("SELECT count(*) AS n FROM story_video_jobs WHERE design_revision_id=?").get(f.manifest.outerRevisionId).n, 0);
        f.objects.delete(f.intentKey);
        assert.equal((await f.operation.fetch(request(f.env.OPERATION_SECRET), f.env)).status, 409);
    }
    finally {
        f.db.close();
    }
});
