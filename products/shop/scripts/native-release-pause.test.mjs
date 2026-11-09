import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { beginReleasePause, installPauseSchema, inspectDevelopmentDrain, resumeVerifiedRelease, verifyPauseSchema, pauseSchemaManifest } from "./native-release-pause.mjs";

const release = { releaseId: "native-123", sourceCommit: "a".repeat(40), planSha256: "b".repeat(64),
  previous: { workerVersion: "previous", imageDigest: "previous-immutable" }, candidate: { imageDigest: "new-immutable" } };
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE story_video_jobs (id TEXT PRIMARY KEY, status TEXT, attempt_count INTEGER, renderer_version TEXT, updated_at INTEGER, last_error TEXT)`);
  return { db, cf: { query: async (sql, params = []) => {
    const statement = db.prepare(sql);
    const results = statement.columns().length ? statement.all(...params).map(row => ({ ...row })) : [];
    const meta = statement.columns().length ? { changes: 0 } : statement.run(...params);
    return [{ success: true, results, meta }];
  } } };
}

test("pause ownership and immutable previous-pair evidence survive retries and reject competing releases", async () => {
  const { db, cf } = database();
  try {
    await installPauseSchema(cf);
    assert.equal((await beginReleasePause(cf, release, 1000)).paused_at, 1000);
    assert.equal((await beginReleasePause(cf, release, 2000)).paused_at, 1000);
    await assert.rejects(beginReleasePause(cf, { ...release, releaseId: "native-456" }, 3000));
    await assert.rejects(beginReleasePause(cf, { ...release, previous: { workerVersion: "partly-deployed" } }, 4000));
    assert.throws(() => db.exec("UPDATE native_video_release_events SET payload = '{}'"));
    assert.throws(() => db.exec("DELETE FROM native_video_release_events"));
    await installPauseSchema(cf);
    assert.equal(db.prepare("SELECT release_id FROM native_video_release_control").get().release_id, "native-123");
    db.exec("DROP TRIGGER native_video_pause_attempt_update");
    await assert.rejects(verifyPauseSchema(cf));
  } finally { db.close(); }
});

test("drain waits out old grants, retains bounded attempts, and leaves admissions paused if live verification fails", async () => {
  const { db, cf } = database();
  try {
    db.exec(`INSERT INTO story_video_jobs VALUES ('retry', 'rendering', 1, 'story-video-renderer-v7', 500, NULL),
      ('exhausted', 'rendering', 3, 'story-video-renderer-v7', 500, NULL), ('ready', 'ready', 1, 'story-video-renderer-v7', 500, NULL)`);
    await installPauseSchema(cf);
    await beginReleasePause(cf, release, 1000);
    assert.deepEqual(await inspectDevelopmentDrain(cf, release.releaseId, 2000), { drained: false, remainingMs: 299000 });
    assert.equal(db.prepare("SELECT status FROM story_video_jobs WHERE id = 'retry'").get().status, "rendering");
    assert.equal((await inspectDevelopmentDrain(cf, release.releaseId, 301000)).drained, true);
    assert.deepEqual(db.prepare("SELECT id, status, attempt_count FROM story_video_jobs ORDER BY id").all().map(row => ({ ...row })), [
      { id: "exhausted", status: "failed", attempt_count: 3 }, { id: "ready", status: "ready", attempt_count: 1 }, { id: "retry", status: "queued", attempt_count: 1 },
    ]);
    await assert.rejects(resumeVerifiedRelease(cf, release.releaseId, async () => { throw new Error("Wrong live image"); }));
    assert.equal(db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
    await resumeVerifiedRelease(cf, release.releaseId, async () => ({ workerVersion: "verified", imageDigest: "verified-immutable" }));
    assert.deepEqual({ ...db.prepare("SELECT paused, release_id, current_release_id FROM native_video_release_control").get() },
      { paused: 0, release_id: null, current_release_id: "native-123" });
  } finally { db.close(); }
});

test("a newer execution or lost pause owner prevents drain confirmation", async () => {
  const { db, cf } = database();
  try {
    db.exec("INSERT INTO story_video_jobs VALUES ('unexpected', 'rendering', 1, 'story-video-renderer-v7', 2000, NULL)");
    await installPauseSchema(cf);
    await beginReleasePause(cf, release, 1000);
    await assert.rejects(inspectDevelopmentDrain(cf, release.releaseId, 301000));
    db.exec("UPDATE native_video_release_control SET release_id = 'native-456'");
    await assert.rejects(inspectDevelopmentDrain(cf, release.releaseId, 301000));
  } finally { db.close(); }
});


test("print pause blocks historical claims and drain preserves live leases until their exact expiry", async () => {
  const { db, cf } = database();
  try {
    db.exec(`CREATE TABLE print_asset_jobs (
      configured_product_id TEXT PRIMARY KEY, status TEXT, attempt_count INTEGER,
      lease_id TEXT, next_attempt_at INTEGER, updated_at INTEGER
    )`);
    db.exec(`INSERT INTO print_asset_jobs VALUES
      ('running', 'running', 2, 'old-attempt', 961000, 500),
      ('pending', 'pending', 0, NULL, 1000, 500),
      ('ready', 'ready', 1, NULL, 1000, 500)`);
    await installPauseSchema(cf);
    await beginReleasePause(cf, release, 1000);
    const claim = db.prepare(`UPDATE print_asset_jobs SET status = 'running', attempt_count = attempt_count + 1,
      lease_id = 'new-attempt' WHERE configured_product_id = 'pending'`).run();
    assert.equal(claim.changes, 0);
    const direct = db.prepare("INSERT INTO print_asset_jobs VALUES ('new', 'running', 1, 'new-attempt', 962000, 2000)").run();
    assert.equal(direct.changes, 0);
    assert.deepEqual(await inspectDevelopmentDrain(cf, release.releaseId, 301000), { drained: false, remainingMs: 660000 });
    assert.deepEqual({ ...db.prepare("SELECT status, lease_id, attempt_count FROM print_asset_jobs WHERE configured_product_id = 'running'").get() },
      { status: 'running', lease_id: 'old-attempt', attempt_count: 2 });
    assert.deepEqual(await inspectDevelopmentDrain(cf, release.releaseId, 960999), { drained: false, remainingMs: 1 });
    assert.equal((await inspectDevelopmentDrain(cf, release.releaseId, 961000)).drained, true);
    assert.deepEqual({ ...db.prepare("SELECT status, lease_id, attempt_count, next_attempt_at FROM print_asset_jobs WHERE configured_product_id = 'running'").get() },
      { status: 'pending', lease_id: null, attempt_count: 2, next_attempt_at: 961000 });
    assert.deepEqual({ ...db.prepare("SELECT status, attempt_count FROM print_asset_jobs WHERE configured_product_id = 'pending'").get() },
      { status: 'pending', attempt_count: 0 });
    assert.equal(db.prepare("SELECT status FROM print_asset_jobs WHERE configured_product_id = 'ready'").get().status, 'ready');
    const staleCommit = db.prepare("UPDATE print_asset_jobs SET status = 'ready' WHERE configured_product_id = 'running' AND lease_id = 'old-attempt'").run();
    assert.equal(staleCommit.changes, 0);
    await resumeVerifiedRelease(cf, release.releaseId, async () => ({ verified: true }));
    assert.equal(db.prepare(`UPDATE print_asset_jobs SET status = 'running', attempt_count = attempt_count + 1,
      lease_id = 'new-attempt' WHERE configured_product_id = 'pending'`).run().changes, 1);
  } finally { db.close(); }
});

test("print pause verification rejects missing guards and permits an existing attempt to complete", async () => {
  const { db, cf } = database();
  try {
    db.exec(`CREATE TABLE print_asset_jobs (
      configured_product_id TEXT PRIMARY KEY, status TEXT, attempt_count INTEGER,
      lease_id TEXT, next_attempt_at INTEGER, updated_at INTEGER
    )`);
    db.exec("INSERT INTO print_asset_jobs VALUES ('active', 'running', 1, 'lease', 999999, 500)");
    await installPauseSchema(cf);
    await beginReleasePause(cf, release, 1000);
    assert.equal(db.prepare("UPDATE print_asset_jobs SET status = 'ready', lease_id = NULL WHERE configured_product_id = 'active' AND lease_id = 'lease'").run().changes, 1);
    assert.equal((await inspectDevelopmentDrain(cf, release.releaseId, 301000)).drained, true);
    db.exec("DROP TRIGGER native_print_pause_attempt_update");
    await assert.rejects(verifyPauseSchema(cf), /pause schema differs/);
  } finally { db.close(); }
});


test("verified resume makes only unclaimed dispatched prints due for cron recovery", async () => {
  const { db, cf } = database();
  try {
    db.exec(`CREATE TABLE print_asset_jobs (
      configured_product_id TEXT PRIMARY KEY, status TEXT, attempt_count INTEGER,
      lease_id TEXT, next_attempt_at INTEGER, updated_at INTEGER
    )`);
    const future = Date.now() + 960000;
    for (const [id, status, lease] of [['delivery', 'dispatched', null], ['pending', 'pending', null],
      ['running', 'running', 'active'], ['claimed-delivery', 'dispatched', 'unexpected']]) {
      db.prepare("INSERT INTO print_asset_jobs VALUES (?, ?, 1, ?, ?, 0)").run(id, status, lease, future);
    }
    await installPauseSchema(cf);
    await beginReleasePause(cf, release, 1000);
    await assert.rejects(resumeVerifiedRelease(cf, release.releaseId, async () => { throw new Error('verification failed'); }));
    assert.equal(db.prepare("SELECT next_attempt_at FROM print_asset_jobs WHERE configured_product_id = 'delivery'").get().next_attempt_at, future);
    await resumeVerifiedRelease(cf, release.releaseId, async () => ({ verified: true }));
    const rows = db.prepare("SELECT configured_product_id, next_attempt_at, lease_id FROM print_asset_jobs ORDER BY configured_product_id").all();
    assert.ok(rows.find(row => row.configured_product_id === 'delivery').next_attempt_at <= Date.now());
    for (const id of ['pending', 'running', 'claimed-delivery']) {
      assert.equal(rows.find(row => row.configured_product_id === id).next_attempt_at, future);
    }
    assert.equal(rows.find(row => row.configured_product_id === 'running').lease_id, 'active');
  } finally { db.close(); }
});

test("artwork jobs cannot start during pause and in-flight preparation blocks cutover", async () => {
  const { db, cf } = database();
  try {
    db.exec(`CREATE TABLE artwork_preparation_jobs (id TEXT PRIMARY KEY, status TEXT,
        attempts INTEGER DEFAULT 1, lease_token TEXT DEFAULT 'lease', next_attempt_at INTEGER DEFAULT 960500, updated_at INTEGER DEFAULT 500);
      INSERT INTO artwork_preparation_jobs (id, status) VALUES ('active', 'processing'), ('next', 'pending')`);
    await installPauseSchema(cf);
    await beginReleasePause(cf, release, 1000);
    db.prepare("UPDATE artwork_preparation_jobs SET status='processing' WHERE id='next'").run();
    assert.equal(db.prepare("SELECT status FROM artwork_preparation_jobs WHERE id='next'").get().status, 'pending');
    assert.equal((await inspectDevelopmentDrain(cf, release.releaseId, 301000)).drained, false);
    assert.equal((await inspectDevelopmentDrain(cf, release.releaseId, 960501)).drained, true);
    assert.equal(db.prepare("SELECT status FROM artwork_preparation_jobs WHERE id='active'").get().status, 'pending');
    assert.equal(db.prepare("SELECT lease_token FROM artwork_preparation_jobs WHERE id='active'").get().lease_token, null);
    assert.equal((await inspectDevelopmentDrain(cf, release.releaseId, 301000)).drained, true);
    await resumeVerifiedRelease(cf, release.releaseId, async () => ({ verified: true }));
    db.prepare("UPDATE artwork_preparation_jobs SET status='processing' WHERE id='next'").run();
    assert.equal(db.prepare("SELECT status FROM artwork_preparation_jobs WHERE id='next'").get().status, 'processing');
  } finally { db.close(); }
});

test("guarded migration preserves existing pause definitions while installing guards for a new job table", async () => {
  const { db, cf } = database();
  try {
    await installPauseSchema(cf);
    const before = await pauseSchemaManifest(cf);
    db.exec("CREATE TABLE product_image_jobs (status TEXT, attempt_count INTEGER, updated_at INTEGER)");
    await verifyPauseSchema(cf, before);
    await assert.rejects(verifyPauseSchema(cf), /pause schema differs/);
    db.exec("DROP TRIGGER native_video_pause_attempt_insert");
    await assert.rejects(verifyPauseSchema(cf, before), /pause schema differs/);
    await installPauseSchema(cf);
    await verifyPauseSchema(cf);
  } finally { db.close(); }
});
