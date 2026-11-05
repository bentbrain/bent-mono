import { artworkPreviewKey } from "./design-repository";

const DAY_MS = 24 * 60 * 60 * 1_000;
const ABANDONED_DRAFT_RETENTION_MS = 30 * DAY_MS;
const ACCESS_LOG_RETENTION_MS = 730 * DAY_MS;
const DELIVERY_ADDRESS_RETENTION_MS = 45 * DAY_MS;
const EXPIRED_CAPABILITY_RETENTION_MS = 30 * DAY_MS;
const UPLOAD_GRANT_RETENTION_MS = DAY_MS;
const WEBHOOK_AUDIT_RETENTION_MS = 30 * DAY_MS;
const MINIMIZED_PAYLOAD_AUDIT = '{"schema":"orders-paid-audit-v1"}';
const MAX_DRAFTS_PER_RUN = 25;
const MAX_OBJECTS_PER_RUN = 100;

interface PrivacyMaintenanceEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
}

interface AbandonedDraft {
  readonly artwork_key: string;
  readonly id: string;
  readonly sha256: string;
}

interface PendingDeletion {
  readonly id: string;
  readonly storage_key: string;
}

export interface PrivacyMaintenanceReport {
  readonly abandonedDrafts: number;
  readonly accessLogs: number;
  readonly deliveryAddresses: number;
  readonly expiredCapabilities: number;
  readonly failedObjectDeletions: number;
  readonly objectsDeleted: number;
  readonly uploadGrants: number;
  readonly webhookAudits: number;
  readonly webhookBodiesMinimized: number;
}

export async function runScheduledPrivacyMaintenance(
  env: PrivacyMaintenanceEnv,
  now = () => Date.now(),
): Promise<PrivacyMaintenanceReport> {
  const timestamp = now();
  const database = await runDatabaseRetention(env.DB, timestamp);
  const abandonedDrafts = await enqueueAbandonedDrafts(env.DB, timestamp);
  const objects = await deleteQueuedObjects(env, timestamp);
  return {
    abandonedDrafts,
    ...database,
    ...objects,
  };
}

async function runDatabaseRetention(db: D1Database, now: number) {
  const results = await db.batch([
    db.prepare(`
      UPDATE shopify_webhook_inbox
      SET payload_json = ?
      WHERE payload_json != ?
    `).bind(MINIMIZED_PAYLOAD_AUDIT, MINIMIZED_PAYLOAD_AUDIT),
    db.prepare(`
      UPDATE paid_orders
      SET delivery_address_sha256 = NULL, delivery_address_json = NULL,
        personal_data_purged_at = ?
      WHERE delivery_address_json IS NOT NULL
        AND status IN ('cancelled', 'refunded', 'fulfilled')
        AND updated_at <= ?
    `).bind(now, now - DELIVERY_ADDRESS_RETENTION_MS),
    db.prepare(`
      DELETE FROM shopify_webhook_inbox
      WHERE status != 'processing' AND received_at <= ?
    `).bind(now - WEBHOOK_AUDIT_RETENTION_MS),
    db.prepare(`
      DELETE FROM order_management_capabilities
      WHERE expires_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM paid_orders
          WHERE order_management_capability_hash = token_hash
        )
    `).bind(now - EXPIRED_CAPABILITY_RETENTION_MS),
    db.prepare(`
      DELETE FROM design_upload_grants
      WHERE expires_at <= ?
    `).bind(now - UPLOAD_GRANT_RETENTION_MS),
    db.prepare(`
      DELETE FROM personal_data_access_log
      WHERE occurred_at <= ?
    `).bind(now - ACCESS_LOG_RETENTION_MS),
    db.prepare("DELETE FROM order_management_access_log WHERE occurred_at <= ?").bind(now - ACCESS_LOG_RETENTION_MS),
  ]);
  return {
    accessLogs: changes(results[5]) + changes(results[6]),
    deliveryAddresses: changes(results[1]),
    expiredCapabilities: changes(results[3]),
    uploadGrants: changes(results[4]),
    webhookAudits: changes(results[2]),
    webhookBodiesMinimized: changes(results[0]),
  };
}

async function enqueueAbandonedDrafts(db: D1Database, now: number) {
  const cutoff = now - ABANDONED_DRAFT_RETENTION_MS;
  const candidates = await db.prepare(`
    SELECT id, artwork_key, sha256
    FROM designs
    WHERE finalized_at IS NULL AND deleted_at IS NULL AND updated_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM design_revisions WHERE design_id = designs.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM products WHERE design_id = designs.id
      )
    ORDER BY updated_at, id
    LIMIT ?
  `).bind(cutoff, MAX_DRAFTS_PER_RUN).all<AbandonedDraft>();
  let deleted = 0;
  for (const draft of candidates.results) {
    const previewKey = artworkPreviewKey(draft.id, draft.sha256);
    const results = await db.batch([
      enqueueObject(db, draft, draft.artwork_key, cutoff, now),
      enqueueObject(db, draft, previewKey, cutoff, now),
      db.prepare(`
        DELETE FROM design_upload_grants
        WHERE design_id = ? AND EXISTS (
          SELECT 1 FROM designs
          WHERE id = ? AND finalized_at IS NULL AND deleted_at IS NULL
            AND updated_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM design_revisions WHERE design_id = designs.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM products WHERE design_id = designs.id
            )
        )
      `).bind(draft.id, draft.id, cutoff),
      db.prepare(`
        UPDATE designs
        SET owner_id = NULL, status = 'deleted', deleted_at = ?, updated_at = ?
        WHERE id = ? AND finalized_at IS NULL AND deleted_at IS NULL
          AND updated_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM design_revisions WHERE design_id = designs.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM products WHERE design_id = designs.id
          )
      `).bind(now, now, draft.id, cutoff),
    ]);
    deleted += changes(results[3]);
  }
  return deleted;
}

function enqueueObject(
  db: D1Database,
  draft: AbandonedDraft,
  storageKey: string,
  cutoff: number,
  now: number,
) {
  return db.prepare(`
    INSERT INTO privacy_object_deletions (
      id, bucket, storage_key, reason, source_record_id, enqueued_at
    )
    SELECT ?, 'design-artwork', ?, 'abandoned-draft', ?, ?
    FROM designs
    WHERE id = ? AND finalized_at IS NULL AND deleted_at IS NULL
      AND updated_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM design_revisions WHERE design_id = designs.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM products WHERE design_id = designs.id
      )
    ON CONFLICT (bucket, storage_key) DO NOTHING
  `).bind(
    crypto.randomUUID(),
    storageKey,
    draft.id,
    now,
    draft.id,
    cutoff,
  );
}

async function deleteQueuedObjects(env: PrivacyMaintenanceEnv, now: number) {
  const pending = await env.DB.prepare(`
    SELECT id, storage_key
    FROM privacy_object_deletions
    WHERE deleted_at IS NULL
    ORDER BY enqueued_at, id
    LIMIT ?
  `).bind(MAX_OBJECTS_PER_RUN).all<PendingDeletion>();
  let failedObjectDeletions = 0;
  let objectsDeleted = 0;
  for (const object of pending.results) {
    try {
      await env.DESIGN_ARTWORK.delete(object.storage_key);
      const result = await env.DB.prepare(`
        UPDATE privacy_object_deletions
        SET deleted_at = ?, attempt_count = attempt_count + 1,
          last_error = NULL
        WHERE id = ? AND deleted_at IS NULL
      `).bind(now, object.id).run();
      objectsDeleted += changes(result);
    } catch {
      failedObjectDeletions += 1;
      await env.DB.prepare(`
        UPDATE privacy_object_deletions
        SET attempt_count = attempt_count + 1,
          last_error = 'Object deletion failed.'
        WHERE id = ? AND deleted_at IS NULL
      `).bind(object.id).run();
    }
  }
  return { failedObjectDeletions, objectsDeleted };
}

function changes(result: D1Result | undefined) {
  return result?.meta.changes ?? 0;
}
