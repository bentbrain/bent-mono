import { releaseProgress } from "./release-progress.mjs";
import { readFile } from "node:fs/promises";

const DEVELOPMENT_DRAIN_MS = 300_000;
const check = (value, reason) => { if (!value) throw new Error(`Native release stopped: ${reason}`); };
const normalize = sql => sql.replace(/^\s*--.*$/gm, "").replace(/\bIF NOT EXISTS\s+/g, "").replace(/\s+/g, " ").trim().replace(/;$/, "");
const schemaPath = new URL("../workers/api/sql/native-release-controls.sql", import.meta.url);
const printSchemaPath = new URL("../workers/api/sql/native-print-release-controls.sql", import.meta.url);

async function printJobsExist(cf) {
  return (await cf.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'print_asset_jobs'"))[0].results.length === 1;
}

async function pauseDefinitions(cf) {
  const core = await readFile(schemaPath, "utf8");
  const prints = await printJobsExist(cf) ? await readFile(printSchemaPath, "utf8") : "";
  const imageTable=(await cf.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='product_image_jobs'"))[0].results;
  const images=imageTable.length ? await readFile(new URL("../workers/api/sql/native-image-release-controls.sql",import.meta.url),"utf8") : "";
  const artworkTable = (await cf.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='artwork_preparation_jobs'"))[0].results;
  const artwork = artworkTable.length ? await readFile(new URL("../workers/api/sql/native-artwork-release-controls.sql", import.meta.url), "utf8") : "";
  return [core, prints, images, artwork].flatMap(sql => sql.split("--> statement-breakpoint"));
}

export async function verifyPauseSchema(cf) {
  const definitions = (await pauseDefinitions(cf)).map(normalize).filter(statement => statement.startsWith("CREATE "));
  for (const definition of definitions) {
    const name = /^CREATE (?:TABLE|TRIGGER) (\w+)/.exec(definition)?.[1];
    check(name, "invalid checked-in pause schema.");
    const result = await cf.query("SELECT sql FROM sqlite_schema WHERE name = ?", [name]);
    check(result[0].results.length === 1 && normalize(result[0].results[0].sql) === definition, "pause schema differs from reviewed source.");
  }
}

export async function installPauseSchema(cf) {
  for (const statement of await pauseDefinitions(cf)) if (statement.trim()) await cf.query(statement);
  await verifyPauseSchema(cf);
}

export async function recordReleaseEvent(cf, releaseId, stage, value, now = Date.now()) {
  check(/^native-\d+$/.test(releaseId) && /^[a-z][a-z-]{0,39}$/.test(stage), "invalid release event identity.");
  const payload = JSON.stringify(value);
  check(payload && payload.length <= 32000, "invalid release evidence.");
  await cf.query(`INSERT INTO native_video_release_events (release_id, stage, payload, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (release_id, stage) DO NOTHING`, [releaseId, stage, payload, now]);
  const result = await cf.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = ?", [releaseId, stage]);
  check(result[0].results.length === 1 && result[0].results[0].payload === payload, "existing release evidence differs; it was not overwritten.");
  releaseProgress(releaseId, stage, "durable evidence verified", now);
}

export async function assertReleasePaused(cf, releaseId) {
  const result = await cf.query("SELECT paused, release_id, paused_at FROM native_video_release_control WHERE singleton = 1");
  const control = result[0].results[0];
  check(result[0].results.length === 1 && control.paused === 1 && control.release_id === releaseId &&
    Number.isSafeInteger(control.paused_at) && control.paused_at > 0, "pause ownership was not confirmed.");
  return control;
}

export async function beginReleasePause(cf, release, now = Date.now()) {
  check(/^native-\d+$/.test(release.releaseId) && /^[a-f0-9]{40}$/.test(release.sourceCommit) &&
    /^[a-f0-9]{64}$/.test(release.planSha256), "release identity/plan must be pinned before pausing.");
  await verifyPauseSchema(cf);
  // Exclusive immutable evidence is written before acquiring the pause. A
  // retry cannot replace the previous compatible pair with a partially deployed one.
  await recordReleaseEvent(cf, release.releaseId, "prepared", release, now);
  await cf.query(`UPDATE native_video_release_control SET paused = 1, release_id = ?, paused_at = ?, updated_at = ?
    WHERE singleton = 1 AND release_id IS NULL`, [release.releaseId, now, now]);
  return assertReleasePaused(cf, release.releaseId);
}

export async function unresolvedArtworkPreparation(cf, releaseId, now, recoverExpired = false) {
  const tables = (await cf.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='artwork_preparation_jobs'"))[0].results;
  if (!tables.some(row => row.name === "artwork_preparation_jobs")) return 0;
  await assertReleasePaused(cf, releaseId);
  // Cloudflare queue consumers have a 15-minute wall-time ceiling. Wait an
  // additional minute, then invalidate the dead lease before releasing drain.
  // https://developers.cloudflare.com/queues/platform/limits/
  if (recoverExpired) await cf.query(`UPDATE artwork_preparation_jobs SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
    lease_token = NULL, next_attempt_at = ?, updated_at = ? WHERE status = 'processing' AND updated_at <= ?`,
  [now, now, now - 16 * 60_000]);
  const rows = (await cf.query("SELECT count(*) AS count FROM artwork_preparation_jobs WHERE status='processing'"))[0].results;
  check(rows.length === 1 && Number.isSafeInteger(rows[0].count) && rows[0].count >= 0, "invalid artwork drain count.");
  await assertReleasePaused(cf, releaseId);
  return rows[0].count;
}

export async function inspectDevelopmentDrain(cf, releaseId, now = Date.now()) {
  const control = await assertReleasePaused(cf, releaseId);
  check(now >= control.paused_at, "clock precedes the durable pause.");
  if (now - control.paused_at < DEVELOPMENT_DRAIN_MS) {
    releaseProgress(releaseId, "draining", `remaining-seconds=${Math.ceil((DEVELOPMENT_DRAIN_MS - (now - control.paused_at)) / 1000)}`, now);
    return { drained: false, remainingMs: DEVELOPMENT_DRAIN_MS - (now - control.paused_at) };
  }
  if (await unresolvedArtworkPreparation(cf, releaseId, now, true)) return { drained: false, remainingMs: 15_000 };
  const imageTable = (await cf.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='product_image_jobs'"))[0].results;
  if (imageTable.length) {
    await cf.query(`UPDATE product_image_jobs SET status=CASE WHEN attempt_count<3 THEN 'queued' ELSE 'failed' END,
      updated_at=? WHERE status='rendering' AND updated_at<=?`,[now,control.paused_at]);
    const images=(await cf.query("SELECT count(*) AS count FROM product_image_jobs WHERE status='rendering'"))[0].results;
    check(images.length===1 && images[0].count===0,"product image execution remains active after drain.");
  }
  // Development only: verified 120s runtime + 60s async age + bounded dispatch
  // and the 180s transfer grant fit inside the five-minute admission hold.
  // Retain attempts and immutable output; the normal cache/recovery path owns retries.
  await cf.query(`UPDATE story_video_jobs SET status = CASE WHEN attempt_count < 3 THEN 'queued' ELSE 'failed' END,
    last_error = CASE WHEN attempt_count < 3 THEN 'RELEASE_DRAIN_RECOVERED' ELSE 'RELEASE_DRAIN_EXHAUSTED' END, updated_at = ?
    WHERE renderer_version = 'story-video-renderer-v7' AND status = 'rendering' AND updated_at <= ?`, [now, control.paused_at]);
  const result = await cf.query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE renderer_version = 'story-video-renderer-v7' AND status = 'rendering'");
  check(result[0].results.length === 1 && result[0].results[0].count === 0, "an execution remains active after the drain window.");
  if (await printJobsExist(cf)) {
    const prints = (await cf.query(`SELECT count(*) AS count, max(next_attempt_at) AS latest_lease
      FROM print_asset_jobs WHERE status = 'running' AND next_attempt_at > ?`, [now]))[0].results;
    check(prints.length === 1 && Number.isSafeInteger(prints[0].count), "print drain state unavailable.");
    if (prints[0].count > 0) {
      check(Number.isSafeInteger(prints[0].latest_lease) && prints[0].latest_lease > now, "print lease deadline invalid.");
      await assertReleasePaused(cf, releaseId);
      releaseProgress(releaseId, "draining", `active-print-jobs=${prints[0].count}`, now);
      return { drained: false, remainingMs: prints[0].latest_lease - now };
    }
    // Only expired attempts are recovered. Active leases are never shortened,
    // and pending jobs remain durable for the executor selected after resume.
    await cf.query(`UPDATE print_asset_jobs SET status = 'pending', lease_id = NULL,
      next_attempt_at = ?, updated_at = ? WHERE status = 'running' AND next_attempt_at <= ?`, [now, now, now]);
    const remaining = (await cf.query("SELECT count(*) AS count FROM print_asset_jobs WHERE status = 'running'"))[0].results;
    check(remaining.length === 1 && remaining[0].count === 0, "print execution remains active after drain.");
  }
  await assertReleasePaused(cf, releaseId);
  return { drained: true, pausedAt: control.paused_at, minimumHoldMs: DEVELOPMENT_DRAIN_MS };
}

export async function resumeVerifiedRelease(cf, releaseId, verifyLivePair) {
  await verifyPauseSchema(cf);
  await assertReleasePaused(cf, releaseId);
  // The caller supplies the actual AWS/Worker verifier, not a readiness boolean.
  // There is deliberately no catch/finally that reopens admissions on failure.
  const verified = await verifyLivePair();
  await recordReleaseEvent(cf, releaseId, "verified", verified);
  if (await printJobsExist(cf)) {
    await assertReleasePaused(cf, releaseId);
    // A historical queue consumer may have acknowledged a pause-rejected claim.
    // Make only its unclaimed delivery due for the restored API's normal cron.
    // Running attempts and pending render-failure backoffs remain untouched.
    const now = Date.now();
    await cf.query(`UPDATE print_asset_jobs SET next_attempt_at = ?, updated_at = ?
      WHERE status = 'dispatched' AND lease_id IS NULL AND next_attempt_at > ?
        AND EXISTS (SELECT 1 FROM native_video_release_control WHERE singleton = 1 AND paused = 1 AND release_id = ?)`,
    [now, now, now, releaseId]);
  }
  await cf.query(`UPDATE native_video_release_control SET paused = 0, release_id = NULL, current_release_id = ?, updated_at = ?
    WHERE singleton = 1 AND paused = 1 AND release_id = ?`, [releaseId, Date.now(), releaseId]);
  const result = await cf.query("SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1");
  check(result[0].results.length === 1 && result[0].results[0].paused === 0 && result[0].results[0].release_id === null &&
    result[0].results[0].current_release_id === releaseId, "resume response was not confirmed; inspect live state before retrying.");
  return verified;
}
