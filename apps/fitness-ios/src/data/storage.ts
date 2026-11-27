import { openDatabaseSync } from "expo-sqlite";
import type { SQLiteDatabase } from "expo-sqlite";
import { z } from "zod";
import { recordSchema } from "@bent/fitness-contracts/domain";
import { pendingSchema } from "./sync-engine";
import type { Pending, SyncStorage } from "./sync-engine";

/**
 * The app's SQLite database. It keeps each account's last loaded records,
 * its queued changes and small per-device drafts, such as typed workout
 * values. Signing out deletes the account's rows.
 */
let db: SQLiteDatabase | undefined;
function database() {
  if (db) return db;
  db = openDatabaseSync("fitness.db");
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
  `);
  return db;
}

const rowSchema = z.object({ item: z.string() });

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
};

/** Small values kept on this iPhone for one account, such as typed workout fields. */
export const drafts = {
  get(owner: string, key: string): string | null {
    return database().getFirstSync<{ value: string }>("SELECT value FROM drafts WHERE owner = ? AND key = ?", owner, key)?.value ?? null;
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
