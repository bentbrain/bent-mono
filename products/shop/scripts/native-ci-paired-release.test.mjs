import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { executeDevelopmentRelease } from "./native-ci-paired-release.mjs";
function fixture(failAt) {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE story_video_jobs (id TEXT PRIMARY KEY NOT NULL, status TEXT, attempt_count INTEGER,
    renderer_version TEXT, updated_at INTEGER, last_error TEXT);
    INSERT INTO story_video_jobs VALUES ('ready-product', 'ready', 1, 'story-video-renderer-v7', 10, NULL)`);
    const cf = { query: async (sql, params = []) => {
            const statement = db.prepare(sql);
            return [{ success: true, results: statement.columns().length ? statement.all(...params).map(row => ({ ...row })) : [],
                    meta: statement.columns().length ? { changes: 0 } : statement.run(...params) }];
        } };
    let time = 1000, applied = false;
    const calls = [];
    const step = name => {
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
        calls.push(name);
        if (failAt === name)
            throw new Error(`Uncertain ${name}`);
    };
    const old = { renderer: { imageDigest: "old", sourceDigest: "old" }, failure: { imageDigest: "old" } };
    const candidate = { imageDigest: `sha256:${"b".repeat(64)}`, sourceDigest: "c".repeat(64) };
    const planSha256 = "d".repeat(64), sourceCommit = "a".repeat(40);
    const worker = { review: { sourceCommit, bundleSha256: "e".repeat(64) }, verifyPrevious: async () => { }, migrate: async () => step("migration"),
        deploy: async () => { step("worker"); return { workerVersion: "verified" }; } };
    const image = { review: { planSha256, ...candidate }, apply: async () => { step("image"); applied = true; } };
    const release = { environment: "development", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", releaseId: "native-123",
        sourceCommit, planSha256, candidate, worker: worker.review, previous: { runtime: old } };
    let prepared;
    const store = { save: async (_name, bytes) => { prepared = bytes; return { key: "fixture" }; }, read: async () => prepared };
    return { db, calls, input: { cf, release, image, worker, store, inspectRuntime: async () => applied
                ? { renderer: candidate, failure: { imageDigest: candidate.imageDigest } } : old,
            verifyStatus: async () => { step("status"); return { executionProtocol: "claim-v1" }; },
            probeRuntime: async () => { step("startup"); return { startupVerified: true }; },
            wait: async (ms) => { assert.ok(ms <= 15000); time += ms; }, now: () => time } };
}
test("paired release pauses old claims in SQL, waits out grants, migrates, deploys and verifies before resume", async () => {
    const { db, calls, input } = fixture();
    try {
        await executeDevelopmentRelease(input);
        assert.deepEqual(calls, ["migration", "image", "startup", "worker", "status"]);
        assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM story_video_jobs").get().count, 1);
        assert.equal(db.prepare("SELECT status FROM story_video_jobs").get().status, "ready");
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_video_release_events").get().count, 10);
    }
    finally {
        db.close();
    }
});
test("migration, image, Worker and live-status uncertainty leave admissions paused without retry", async () => {
    for (const failAt of ["migration", "image", "startup", "worker", "status"]) {
        const { db, calls, input } = fixture(failAt);
        try {
            await assert.rejects(executeDevelopmentRelease(input));
            assert.equal(calls.filter(name => name === failAt).length, 1);
            const control = db.prepare("SELECT paused, release_id FROM native_video_release_control").get();
            assert.equal(control.paused, 1);
            assert.equal(control.release_id, "native-123");
            assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_video_release_events WHERE stage = 'verified'").get().count, 0);
        }
        finally {
            db.close();
        }
    }
});
test("mismatched preparation cannot install a pause or touch application resources", async () => {
    const { db, calls, input } = fixture();
    try {
        input.release.planSha256 = "wrong";
        await assert.rejects(executeDevelopmentRelease(input));
        assert.deepEqual(calls, []);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'native_video_release_control'").get().count, 0);
    }
    finally {
        db.close();
    }
});
test("paired release pauses still-image admissions and drains pre-pause image leases", async () => {
    const { db, input } = fixture();
    db.exec(`CREATE TABLE product_image_jobs(id TEXT PRIMARY KEY, status TEXT,attempt_count INTEGER,updated_at INTEGER);
    INSERT INTO product_image_jobs VALUES ('old-image','rendering',1,500),('new-image','queued',0,500)`);
    const originalWait = input.wait;
    input.wait = async (ms) => {
        db.prepare("UPDATE product_image_jobs SET status='rendering',attempt_count=1 WHERE id='new-image'").run();
        assert.equal(db.prepare("SELECT status FROM product_image_jobs WHERE id='new-image'").get().status, 'queued');
        await originalWait(ms);
    };
    try {
        await executeDevelopmentRelease(input);
        assert.equal(db.prepare("SELECT status FROM product_image_jobs WHERE id='old-image'").get().status, 'queued');
        db.prepare("UPDATE product_image_jobs SET status='rendering',attempt_count=1 WHERE id='new-image'").run();
        assert.equal(db.prepare("SELECT status FROM product_image_jobs WHERE id='new-image'").get().status, 'rendering');
    }
    finally {
        db.close();
    }
});
