import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { MAX_PREPARED_ARTWORK_BYTES } from "@forever-tee/contracts/limits";
import { Effect } from "effect";
import { artworkPreviewKey, storeArtworkPreview } from "./artwork-preview";
import { byteStream, readBoundedStream, prepareStoredArtwork, validateSourceImage, type ImageProcessingBinding } from "./image-processing";
import { takeProviderToken } from "./provider-admission";
import { printBufferAdmission } from "./print-asset-memory";
import type { ScreenedPortraitResult } from "./portrait-processing";

export interface ArtworkPreparationMessage { readonly artworkJobId: string }
export interface ArtworkPreparationEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly IMAGES: ImageProcessingBinding;
  readonly PRINT_ASSET_JOBS?: { send(message: ArtworkPreparationMessage): Promise<unknown> };
}
interface Job {
  id: string; design_id: string; source_key: string; source_bytes: number; source_sha256: string;
  status: string; attempts: number; next_attempt_at: number; updated_at: number; created_at: number;
}
const LEASE_MS = 16 * 60_000;
const MAX_ATTEMPTS = 3;

export function isArtworkPreparationMessage(value: unknown): value is ArtworkPreparationMessage {
  return typeof value === "object" && value !== null && "artworkJobId" in value &&
    typeof value.artworkJobId === "string" && /^[0-9a-f-]{36}$/.test(value.artworkJobId);
}
async function digest(bytes: Uint8Array) {
  const input = bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

export async function publishArtworkPreparation(
  env: ArtworkPreparationEnv,
  grant: { design_id: string; owner_id: string; expected_version: number },
  source: Uint8Array,
  preview: Extract<ScreenedPortraitResult, { ok: true }>,
) {
  if (!preview.original) throw new Error("Original preview is missing.");
  const id = crypto.randomUUID();
  const now = Date.now();
  const sourceHash = await digest(source);
  const sourceKey = `designs/${grant.design_id}/preparation/${id}/source`;
  const sources = await Promise.all([
    { kind: "original", image: preview.original, contentType: "image/png" },
    { kind: "cutout", image: preview, contentType: "image/webp" },
  ].map(async item => ({ ...item, hash: await digest(item.image.bytes),
    key: `designs/${grant.design_id}/preparation/${id}/${item.kind}` })));
  const cutout = sources.find(item => item.kind === "cutout");
  if (!cutout) throw new Error("Cutout preview is missing.");
  // All persisted bytes have passed screening. Await every write before releasing
  // the request's memory reservation, including when a sibling write fails.
  const stored = await Promise.allSettled([
    env.DESIGN_ARTWORK.put(sourceKey, source, { sha256: sourceHash }),
    ...sources.map(item => env.DESIGN_ARTWORK.put(item.key, item.image.bytes,
      { httpMetadata: { contentType: item.contentType }, sha256: item.hash })),
    env.DESIGN_ARTWORK.put(artworkPreviewKey(grant.design_id, cutout.hash), preview.bytes,
      { httpMetadata: { contentType: "image/webp" }, sha256: cutout.hash }),
  ]);
  if (stored.some(result => result.status === "rejected")) throw new Error("Preview storage failed.");
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO artwork_preparation_jobs
      (id, design_id, source_key, source_bytes, source_sha256, status, next_attempt_at, created_at, updated_at)
      SELECT ?, id, ?, ?, ?, 'pending', ?, ?, ? FROM designs WHERE id = ? AND owner_id = ?
        AND version = ? AND status = 'processing' AND finalized_at IS NULL AND deleted_at IS NULL`)
      .bind(id, sourceKey, source.length, sourceHash, now, now, now, grant.design_id, grant.owner_id, grant.expected_version + 1),
    ...sources.map(item => env.DB.prepare(`
      INSERT INTO design_artwork_sources (design_id, kind, artwork_key, sha256, byte_size, width, height)
      SELECT design_id, ?, ?, ?, ?, ?, ? FROM artwork_preparation_jobs WHERE id = ?
      ON CONFLICT(design_id, kind) DO UPDATE SET artwork_key = excluded.artwork_key,
        sha256 = excluded.sha256, byte_size = excluded.byte_size, width = excluded.width, height = excluded.height`)
      .bind(item.kind, item.key, item.hash, item.image.bytes.length, item.image.width, item.image.height, id)),
    env.DB.prepare(`UPDATE designs SET artwork_job_id = ?, remove_background = 1,
      artwork_key = ?, sha256 = ?, byte_size = ?, artwork_width = ?, artwork_height = ?,
      content_type = 'image/webp', safety_screening_decision = 'allowed', safety_screening_model = ?,
      default_product_color_status = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM artwork_preparation_jobs WHERE id = ?)`)
      .bind(id, cutout.key, cutout.hash, preview.bytes.length, preview.sourceDimensions?.width ?? null, preview.sourceDimensions?.height ?? null, preview.screening.model,
        preview.productColorAnalysis ? "pending" : "fallback", now, grant.design_id, id),
  ]);
  if (results[0]?.meta.changes !== 1) throw new Error("Upload was superseded.");
  return { id, artworkKey: cutout.key, updatedAt: new Date(now).toISOString() };
}

export async function deliverArtworkPreparation(env: ArtworkPreparationEnv, id: string) {
  if (!env.PRINT_ASSET_JOBS) return;
  const now = Date.now();
  const claimed = await env.DB.prepare(`UPDATE artwork_preparation_jobs SET next_attempt_at = ?
    WHERE id = ? AND status IN ('pending', 'processing') AND next_attempt_at <= ?`)
    .bind(now + LEASE_MS, id, now).run();
  if (claimed.meta.changes !== 1) return;
  try { await env.PRINT_ASSET_JOBS.send({ artworkJobId: id }); }
  catch {
    await env.DB.prepare(`UPDATE artwork_preparation_jobs SET next_attempt_at = ?
      WHERE id = ? AND next_attempt_at = ?`).bind(now + 60_000, id, now + LEASE_MS).run();
  }
}

export async function recoverArtworkPreparation(env: ArtworkPreparationEnv) {
  const now = Date.now();
  // Reconcile dead queue invocations even while admissions are paused. This
  // releases expired leases without starting work during a deployment drain.
  await env.DB.prepare(`UPDATE artwork_preparation_jobs SET
    status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
    lease_token = NULL, next_attempt_at = ?, updated_at = ?
    WHERE status = 'processing' AND updated_at <= ?`)
    .bind(MAX_ATTEMPTS, now, now, now - LEASE_MS).run();
  const due = await env.DB.prepare(`SELECT id FROM artwork_preparation_jobs
    WHERE status IN ('pending', 'processing') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50`)
    .bind(now).all<{ id: string }>();
  for (const job of due.results) await deliverArtworkPreparation(env, job.id);
  const expired = await env.DB.prepare(`SELECT id, source_key FROM artwork_preparation_jobs
    WHERE status IN ('complete', 'failed') AND source_deleted_at IS NULL AND updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM designs WHERE artwork_job_id = artwork_preparation_jobs.id
        AND status = 'processing' AND deleted_at IS NULL) LIMIT 50`)
    .bind(now - 24 * 60 * 60_000).all<{ id: string; source_key: string }>();
  for (const job of expired.results) {
    const claimed = await env.DB.prepare(`UPDATE artwork_preparation_jobs SET source_deleted_at = ?
      WHERE id = ? AND status IN ('complete', 'failed') AND source_deleted_at IS NULL AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM designs WHERE artwork_job_id = artwork_preparation_jobs.id
          AND status = 'processing' AND deleted_at IS NULL)`)
      .bind(now, job.id, now - 24 * 60 * 60_000).run();
    if (claimed.meta.changes !== 1) continue;
    try { await env.DESIGN_ARTWORK.delete(job.source_key); }
    catch {
      await env.DB.prepare("UPDATE artwork_preparation_jobs SET source_deleted_at = NULL WHERE id = ? AND source_deleted_at = ?")
        .bind(job.id, now).run();
    }
    // Keep the terminal receipt while the draft references it.
  }
}

export async function executeArtworkPreparation(env: ArtworkPreparationEnv, id: string): Promise<boolean> {
  const controlTable = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'native_video_release_control'").first();
  if (controlTable) {
    const control = await env.DB.prepare("SELECT paused FROM native_video_release_control WHERE singleton = 1").first<{ paused: number }>();
    if (control?.paused !== 0) return false;
  }
  const job = await env.DB.prepare("SELECT * FROM artwork_preparation_jobs WHERE id = ?").bind(id).first<Job>();
  if (!job || job.status === "complete" || job.status === "failed") return true;
  // Reserve before claiming so capacity contention does not consume attempts.
  let release: () => void;
  try { release = printBufferAdmission.reserve(2 * job.source_bytes + 3 * MAX_PREPARED_ARTWORK_BYTES + 3_000_000); }
  catch { return false; }
  const lease = crypto.randomUUID();
  try {
    const now = Date.now();
    if (!(await takeProviderToken(env.DB, "portrait")).allowed) return false;
    if (job.attempts >= MAX_ATTEMPTS && job.status === "processing" && job.updated_at <= now - LEASE_MS) {
      await env.DB.prepare("UPDATE artwork_preparation_jobs SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'processing' AND attempts >= ? AND updated_at <= ?")
        .bind(now, id, MAX_ATTEMPTS, now - LEASE_MS).run();
      return true;
    }
    const claimed = await env.DB.prepare(`UPDATE artwork_preparation_jobs SET status = 'processing',
      attempts = attempts + 1, lease_token = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND (status = 'pending' OR (status = 'processing' AND updated_at <= ?))
        ${controlTable ? "AND EXISTS (SELECT 1 FROM native_video_release_control WHERE singleton = 1 AND paused = 0)" : ""}`)
      .bind(lease, now + LEASE_MS, now, id, now - LEASE_MS).run();
    if (claimed.meta.changes !== 1) return true;
    const active = await env.DB.prepare(`SELECT id FROM designs WHERE id = ? AND artwork_job_id = ?
      AND status = 'processing' AND deleted_at IS NULL`).bind(job.design_id, id).first();
    if (!active) {
      await env.DB.prepare("UPDATE artwork_preparation_jobs SET status = 'complete', updated_at = ? WHERE id = ? AND lease_token = ?")
        .bind(Date.now(), id, lease).run();
      await env.DESIGN_ARTWORK.delete(job.source_key);
      return true;
    }
    const object = await env.DESIGN_ARTWORK.get(job.source_key);
    if (object?.size !== job.source_bytes) throw new Error("Source unavailable.");
    const source = new Uint8Array(await object.arrayBuffer());
    if (await digest(source) !== job.source_sha256) throw new Error("Source checksum changed.");
    const validation = await validateSourceImage(env.IMAGES, source);
    if (!validation.ok) throw new Error("Source validation failed.");
    // Exactly the synchronous print path: full source, white normalization,
    // then foreground segmentation. Display previews never enter this path.
    const original = await prepareStoredArtwork(env.IMAGES, source, false, validation.image);
    if (!original.ok) throw new Error("Original preparation failed.");
    const cutout = await prepareStoredArtwork(env.IMAGES, original.bytes, true, original);
    if (!cutout.ok) throw new Error("Cutout preparation failed.");
    const sources = [];
    // Admission reserves one full-size hash buffer. Hashing both sources at
    // once would exceed that reservation when another request shares the isolate.
    for (const item of [{ kind: "original", image: original }, { kind: "cutout", image: cutout }]) {
      const hash = await digest(item.image.bytes);
      sources.push({ ...item, hash, key: `designs/${job.design_id}/${item.kind === "original" ? "original" : "artwork"}/${hash}` });
    }
    const stored = await Promise.allSettled(sources.map(item =>
      env.DESIGN_ARTWORK.put(item.key, item.image.bytes, { httpMetadata: { contentType: "image/webp" },
        sha256: item.hash, customMetadata: { designId: job.design_id, sha256: item.hash } })));
    if (stored.some(result => result.status === "rejected")) throw new Error("Final artwork storage failed.");
    // One bounded display buffer at a time. Large previews remain reproducible
    // through the authenticated source endpoint and never reduce print quality.
    for (const item of sources) {
      const output = await env.IMAGES.input(byteStream(item.image.bytes))
        .transform({ width: 1600, height: 1600, fit: "scale-down" })
        .output({ format: "image/webp", quality: 90 });
      const response = output.response();
      if (!response.ok || !response.body) throw new Error("Final preview preparation failed.");
      const preview = await readBoundedStream(response.body, 1024 * 1024);
      if (preview) await Effect.runPromise(storeArtworkPreview(env.DESIGN_ARTWORK, job.design_id, item.hash, preview));
    }

    const fence = `EXISTS (SELECT 1 FROM artwork_preparation_jobs j JOIN designs d ON d.id = j.design_id
      WHERE j.id = ? AND j.lease_token = ? AND d.artwork_job_id = j.id AND d.status = 'processing'
        AND d.deleted_at IS NULL)`;
    await env.DB.batch([
      ...sources.map(item => env.DB.prepare(`INSERT INTO design_artwork_sources
        (design_id, kind, artwork_key, sha256, byte_size, width, height)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${fence}
        ON CONFLICT(design_id, kind) DO UPDATE SET artwork_key = excluded.artwork_key,
          sha256 = excluded.sha256, byte_size = excluded.byte_size, width = excluded.width, height = excluded.height`)
        .bind(job.design_id, item.kind, item.key, item.hash, item.image.bytes.length, item.image.width, item.image.height, id, lease)),
      env.DB.prepare(`UPDATE designs SET
        (artwork_key, sha256, byte_size, artwork_width, artwork_height) =
          (SELECT artwork_key, sha256, byte_size, width, height FROM design_artwork_sources
           WHERE design_id = designs.id AND kind = CASE WHEN remove_background = 0 THEN 'original' ELSE 'cutout' END),
        status = 'ready', version = version + 1, updated_at = ? WHERE id = ? AND ${fence}`)
        .bind(Date.now(), job.design_id, id, lease),
      env.DB.prepare("UPDATE artwork_preparation_jobs SET status = 'complete', updated_at = ? WHERE id = ? AND lease_token = ?")
        .bind(Date.now(), id, lease),
    ]);
    await env.DESIGN_ARTWORK.delete(job.source_key);
    console.info("bent.shop print artwork prepared", { jobId: id,
      processingDurationMs: Date.now() - now, queueDelayMs: now - job.created_at,
      sourceBytes: job.source_bytes, artworkBytes: cutout.bytes.length,
      width: cutout.width, height: cutout.height });
    return true;
  } catch (error) {
    console.error("bent.shop artwork preparation failed", { jobId: id, ...safeErrorDetails(error) });
    await env.DB.prepare(`UPDATE artwork_preparation_jobs SET
      status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
      next_attempt_at = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND status = 'processing'`)
      .bind(MAX_ATTEMPTS, Date.now() + 60_000, Date.now(), id, lease).run();
    return false;
  } finally { release(); }
}
