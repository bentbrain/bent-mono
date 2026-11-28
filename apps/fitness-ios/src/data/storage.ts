import { defaultDatabaseDirectory, openDatabaseSync } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { z } from "zod";
import { FitnessHealth } from "../../modules/fitness-health";
import { recordSchema } from "@bent/fitness-contracts/domain";
import { pendingSchema } from "./sync-engine";
import type { Pending, SyncStorage } from "./sync-engine";

/**
 * The app's SQLite database. It keeps each account's last loaded records,
 * its queued changes and small per-device drafts, such as typed workout
 * values, and this iPhone's own settings, such as workout reminders. Its
 * directory is excluded from iCloud and computer backups. Signing out
 * deletes the account's rows and keeps the iPhone's settings.
 */
let db: SQLiteDatabase | undefined;
function database() {
  if (db) return db;
  db = openDatabaseSync("fitness.db");
  // Excluding is checked natively; a failure keeps the app usable and is tried again on the next launch.
  try {
    if (typeof defaultDatabaseDirectory === "string") FitnessHealth.excludeFromBackup(defaultDatabaseDirectory);
  } catch {
    // The data still works; only its backup status is unchanged.
  }
  db.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS snapshots (owner TEXT PRIMARY KEY NOT NULL, records TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pending (
      operation_id TEXT PRIMARY KEY NOT NULL,
      owner TEXT NOT NULL,
      at INTEGER NOT NULL,
      item TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pending_owner ON pending (owner, at);
    CREATE TABLE IF NOT EXISTS drafts (owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner, key));
    CREATE TABLE IF NOT EXISTS device (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  `);
  return db;
}

const rowSchema = z.object({ item: z.string() });
const draftRow = z.object({ key: z.string(), value: z.string() });

export const sqliteStorage: SyncStorage = {
  readSnapshot(owner) {
    const row = database().getFirstSync<{ records: string }>("SELECT records FROM snapshots WHERE owner = ?", owner);
    return row ? z.array(recordSchema).parse(JSON.parse(row.records)) : null;
  },
  writeSnapshot(owner, records) {
    database().runSync(
      "INSERT INTO snapshots (owner, records) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET records = excluded.records",
      owner,
      JSON.stringify(records),
    );
  },
  readPending(owner) {
    return database()
      .getAllSync("SELECT item FROM pending WHERE owner = ? ORDER BY at, operation_id", owner)
      .map((row): Pending => pendingSchema.parse(JSON.parse(rowSchema.parse(row).item)));
  },
  addPending(owner, item) {
    database().runSync(
      "INSERT INTO pending (operation_id, owner, at, item) VALUES (?, ?, ?, ?)",
      item.request.operationId,
      owner,
      item.at,
      JSON.stringify(item),
    );
  },
  removePending(owner, operationId) {
    database().runSync("DELETE FROM pending WHERE owner = ? AND operation_id = ?", owner, operationId);
  },
  acknowledge(owner, operationId, records) {
    const sql = database();
    sql.withTransactionSync(() => {
      sql.runSync("DELETE FROM pending WHERE owner = ? AND operation_id = ?", owner, operationId);
      sql.runSync(
        "INSERT INTO snapshots (owner, records) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET records = excluded.records",
        owner,
        JSON.stringify(records),
      );
    });
  },
};

/** Small values kept on this iPhone for one account, such as typed workout fields. */
export const drafts = {
  get(owner: string, key: string): string | null {
    return (
      database().getFirstSync<{ value: string }>("SELECT value FROM drafts WHERE owner = ? AND key = ?", owner, key)
        ?.value ?? null
    );
  },
  set(owner: string, key: string, value: string) {
    database().runSync(
      "INSERT INTO drafts (owner, key, value) VALUES (?, ?, ?) ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value",
      owner,
      key,
      value,
    );
  },
  remove(owner: string, key: string) {
    database().runSync("DELETE FROM drafts WHERE owner = ? AND key = ?", owner, key);
  },
  /** Every draft the account keeps on this iPhone, by key. */
  all(owner: string): Record<string, string> {
    const rows = database().getAllSync("SELECT key, value FROM drafts WHERE owner = ? ORDER BY key", owner);
    return Object.fromEntries(
      rows.map((row) => {
        const parsed = draftRow.parse(row);
        return [parsed.key, parsed.value];
      }),
    );
  },
};

/** Settings for this iPhone, whichever account is signed in. */
export const deviceValues = {
  get(key: string): string | null {
    return database().getFirstSync<{ value: string }>("SELECT value FROM device WHERE key = ?", key)?.value ?? null;
  },
  set(key: string, value: string) {
    database().runSync(
      "INSERT INTO device (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  },
};

/** Deletes everything this iPhone keeps for the account. */
export function forgetAccount(owner: string) {
  const sql = database();
  sql.withTransactionSync(() => {
    sql.runSync("DELETE FROM snapshots WHERE owner = ?", owner);
    sql.runSync("DELETE FROM pending WHERE owner = ?", owner);
    sql.runSync("DELETE FROM drafts WHERE owner = ?", owner);
  });
}
