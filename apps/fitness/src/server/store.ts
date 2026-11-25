import { createHash } from "node:crypto";
import { database } from "./db";
import {
  mutationSchema,
  recordSchema,
  resultSchema,
  settingsId,
  settingsSchema,
  localDate,
  correctionProblem,
} from "../domain";
import type { Mutation, RecordEntry, SaveResult, Workout } from "../domain";
import { z } from "zod";
import type { PendingQuery, Row, Sql, TransactionSql } from "postgres";
const rowSchema = z.object({
  id: z.string(),
  revision: z.number(),
  data: z.unknown(),
  updated_at: z.coerce.date(),
});
function entry(row: unknown) {
  const r = rowSchema.parse(row);
  return recordSchema.parse({ ...r, updatedAt: r.updated_at.toISOString() });
}
export async function loadRecords(
  owner: string,
  sql: Sql | TransactionSql = database(),
): Promise<RecordEntry[]> {
  const rows =
    await sql`SELECT id, revision, data, updated_at FROM fitness_records WHERE owner_id=${owner} AND deleted=false ORDER BY updated_at DESC`;
  return rows.map(entry);
}
export async function saveRecord(
  owner: string,
  input: Mutation,
): Promise<SaveResult> {
  const request = mutationSchema.parse(input);
  return database().begin(async (sql) => {
    await lockAccount(sql, owner);
    return saveWithin(sql, owner, request);
  });
}
/** A record rule rejected the change. The message is safe to show. */
export class StoreRuleError extends Error {}
export class BatchConflict extends Error {
  constructor(readonly current: RecordEntry | null) {
    super("A record changed before this change could be saved.");
  }
}
export type AccountChange = {
  records(): Promise<RecordEntry[]>;
  /** Saves a change, or throws BatchConflict to roll back the request. */
  save(input: Mutation): Promise<RecordEntry | null>;
};
/**
 * An Apple Health sample and the record it became, or matched when one
 * already existed. `date` and `revision` are the record's when they were
 * linked. Run links keep the Health run's distance and duration.
 */
export type HealthLink = {
  sample: string;
  recordId: string;
  date: string;
  matched: boolean;
  revision: number | null;
  distanceKm: number | null;
  minutes: number | null;
};
export type HealthChange = AccountChange & {
  /** The links stored for these samples, by sample. */
  links(samples: string[]): Promise<Map<string, HealthLink>>;
  /** The links that point to any of these records. */
  linksTo(ids: string[]): Promise<HealthLink[]>;
  link(links: HealthLink[]): Promise<void>;
  /** Points existing sample links at other records. */
  relink(links: HealthLink[]): Promise<void>;
  /**
   * Holds this device key's enrollment row until the import commits, so a
   * disconnect or replacement waits for it. Returns false when the key is
   * no longer its installation's active key.
   */
  holdDeviceKey(key: DeviceKeyClaims): Promise<boolean>;
};
function accountChange(sql: TransactionSql, owner: string): AccountChange {
  return {
    records: () => loadRecords(owner, sql),
    async save(input) {
      const outcome = await saveWithin(sql, owner, mutationSchema.parse(input));
      if (outcome.status === "conflict")
        throw new BatchConflict(outcome.current);
      return outcome.record;
    },
  };
}
const linkRow = z.object({
  sample: z.string(),
  record_id: z.string(),
  record_date: z.string(),
  matched: z.boolean(),
  record_revision: z.number().int().nullable(),
  distance_km: z.number().nullable(),
  minutes: z.number().nullable(),
});
function linkOf(row: unknown): HealthLink {
  const r = linkRow.parse(row);
  return {
    sample: r.sample,
    recordId: r.record_id,
    date: r.record_date,
    matched: r.matched,
    revision: r.record_revision,
    distanceKm: r.distance_km,
    minutes: r.minutes,
  };
}
/** Health import operations within an open transaction. Use `changeHealth` to run an import. */
export function healthChange(sql: TransactionSql, owner: string): HealthChange {
  const columns = sql`sample, record_id, to_char(record_date, 'YYYY-MM-DD') AS record_date, matched, record_revision, distance_km, minutes`;
  return {
    ...accountChange(sql, owner),
    async links(samples) {
      if (!samples.length) return new Map();
      const rows =
        await sql`SELECT ${columns} FROM fitness_health_samples WHERE owner_id=${owner} AND sample IN ${sql(samples)}`;
      return new Map(
        rows.map((row) => {
          const link = linkOf(row);
          return [link.sample, link];
        }),
      );
    },
    async linksTo(ids) {
      if (!ids.length) return [];
      const rows =
        await sql`SELECT ${columns} FROM fitness_health_samples WHERE owner_id=${owner} AND record_id IN ${sql(ids)}`;
      return rows.map(linkOf);
    },
    async link(links) {
      if (!links.length) return;
      const rows = links.map((l) => ({
        owner_id: owner,
        sample: l.sample,
        record_id: l.recordId,
        record_date: l.date,
        matched: l.matched,
        record_revision: l.revision,
        distance_km: l.distanceKm,
        minutes: l.minutes,
      }));
      await sql`INSERT INTO fitness_health_samples ${sql(rows, "owner_id", "sample", "record_id", "record_date", "matched", "record_revision", "distance_km", "minutes")} ON CONFLICT DO NOTHING`;
    },
    async holdDeviceKey(key) {
      const rows =
        await sql`SELECT 1 FROM fitness_device_enrollments WHERE ${activeKeyRow(sql, key)} FOR SHARE`;
      return rows.length === 1;
    },
    async relink(links) {
      for (const l of links)
        await sql`UPDATE fitness_health_samples SET record_id=${l.recordId}, record_date=${l.date}, matched=${l.matched}, record_revision=${l.revision} WHERE owner_id=${owner} AND sample=${l.sample}`;
    },
  };
}
/**
 * Runs an Apple Health import under the account lock in one transaction. An
 * error rolls back every change and link. The links make retries safe.
 */
export async function changeHealth<T>(
  owner: string,
  work: (change: HealthChange) => Promise<T>,
): Promise<T> {
  const result = await database().begin(async (sql) => {
    await lockAccount(sql, owner);
    return { value: await work(healthChange(sql, owner)) };
  });
  return result.value;
}
/**
 * Runs one request under the account lock and stores its result with its
 * changes. Repeating the request ID with the same fingerprint returns the
 * first result; a different fingerprint fails. An error rolls back every
 * change and the receipt together.
 */
export async function changeOnce(
  owner: string,
  receipt: { id: string; fingerprint: string },
  work: (change: AccountChange) => Promise<object>,
): Promise<z.infer<typeof storedResult>> {
  return database().begin(async (sql) => {
    await lockAccount(sql, owner);
    const [previous] =
      await sql`SELECT fingerprint, result FROM fitness_operations WHERE owner_id=${owner} AND id=${receipt.id}`;
    if (previous) {
      if (previous.fingerprint !== receipt.fingerprint)
        throw new StoreRuleError(
          "This request ID was already used for a different change. Use a new request ID.",
        );
      return storedResult.parse(previous.result);
    }
    const result = storedResult.parse(
      JSON.parse(JSON.stringify(await work(accountChange(sql, owner)))),
    );
    await sql`INSERT INTO fitness_operations(owner_id,id,fingerprint,result) VALUES(${owner},${receipt.id},${receipt.fingerprint},${sql.json(result)})`;
    return result;
  });
}
const storedResult = z.record(z.string(), z.json());
/** The account timezone, from its settings. */
export async function accountTimezone(
  sql: Sql | TransactionSql,
  owner: string,
) {
  const [configuration] =
    await sql`SELECT data FROM fitness_records WHERE owner_id=${owner} AND id=${settingsId} AND deleted=false`;
  return configuration
    ? settingsSchema.parse(configuration.data).timezone
    : "UTC";
}
/** Another request holds the owner's device issuance lease. */
export class DeviceLeaseBusy extends Error {}
/** The request no longer holds its lease; another may have taken it over. */
export class DeviceLeaseLost extends Error {}
/** A held device issuance lease. */
export type DeviceLease = {
  owner: string;
  holder: string;
  /** The request's deadline on the monotonic clock, for database waits. */
  deadline?: number;
};
/** Postgres canceled a statement on its timeout, or found a lock taken. */
function lockWaitEnded(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "57014" || code === "55P03";
}
/**
 * Takes the owner's device issuance lease for `holder`, unless another
 * holder has one that has not expired. A lease row works through a
 * transaction-mode connection pooler, unlike a session advisory lock.
 */
export async function acquireDeviceLease(
  sql: Sql,
  owner: string,
  holder: string,
  seconds: number,
) {
  // A live lease is found without a lock, so a request never waits behind
  // the holder's own writes to learn the lease is busy.
  const [live] =
    await sql`SELECT 1 FROM fitness_device_issuance_leases WHERE owner_id=${owner} AND expires_at > clock_timestamp()`;
  if (live) return false;
  try {
    return await sql.begin(async (tx) => {
      // Taking over an expired lease that a write still holds would wait;
      // that counts as busy instead.
      await tx`SELECT set_config('lock_timeout', '100ms', true)`;
      const rows =
        await tx`INSERT INTO fitness_device_issuance_leases(owner_id, holder, expires_at) VALUES(${owner}, ${holder}, clock_timestamp() + make_interval(secs => ${seconds})) ON CONFLICT (owner_id) DO UPDATE SET holder=EXCLUDED.holder, expires_at=EXCLUDED.expires_at WHERE fitness_device_issuance_leases.expires_at < clock_timestamp() RETURNING holder`;
      return rows.length === 1;
    });
  } catch (error) {
    if (lockWaitEnded(error)) return false;
    throw error;
  }
}
export async function releaseDeviceLease(
  sql: Sql,
  owner: string,
  holder: string,
) {
  await sql`DELETE FROM fitness_device_issuance_leases WHERE owner_id=${owner} AND holder=${holder}`;
}
/**
 * Runs device key changes for an owner one at a time under its issuance
 * lease. The lease is not waited for: when another request holds it, this
 * throws DeviceLeaseBusy. Each write the work makes is fenced by the lease,
 * so once the lease expires or passes to another request, the next write
 * throws DeviceLeaseLost instead of changing anything. The lease is
 * released when the work ends, whether it succeeds or fails.
 */
export async function withDeviceLease<T>(
  owner: string,
  seconds: number,
  work: (sql: Sql, lease: DeviceLease) => Promise<T>,
  deadline?: number,
): Promise<T> {
  const sql = database();
  const lease = { owner, holder: crypto.randomUUID(), deadline };
  if (!(await acquireDeviceLease(sql, owner, lease.holder, seconds)))
    throw new DeviceLeaseBusy();
  try {
    return await work(sql, lease);
  } finally {
    await releaseDeviceLease(sql, owner, lease.holder);
  }
}
/** Rows a fenced write changes, or none, as a condition on the enrollment table. */
type Target = ((tx: TransactionSql) => PendingQuery<Row[]>) | null;
/**
 * Runs one write only while the lease is held, in one short transaction,
 * and returns the rows it changed. Throws DeviceLeaseLost when the lease is
 * not held. The locks come in one order: the lease row, then the account
 * row, then the enrollment rows the write changes. An import takes the
 * account row and then its enrollment row, and never the lease, so the two
 * cannot deadlock. Only once all three are held is the lease's expiry
 * compared with clock_timestamp(), so a write that waited on any of them
 * past the expiry changes nothing. Holding the lease row FOR SHARE until commit keeps
 * another request from taking the lease over in the meantime.
 */
async function fenced(
  sql: Sql,
  lease: DeviceLease,
  target: Target,
  write: (
    tx: TransactionSql,
    budget: () => Promise<void>,
  ) => Promise<readonly unknown[]>,
) {
  try {
    return await sql.begin(async (tx) => {
      // Before each statement that can wait, its timeout is what remains
      // of the request's deadline, so the waits together never pass it.
      const budget = async () => {
        if (lease.deadline === undefined) return;
        const ms = Math.floor(lease.deadline - performance.now());
        if (ms <= 0) throw new DeviceLeaseLost();
        await tx`SELECT set_config('statement_timeout', ${String(ms)}, true)`;
      };
      const stillHeld = async () => {
        const [valid] =
          await tx`SELECT expires_at > clock_timestamp() AS valid FROM fitness_device_issuance_leases WHERE owner_id=${lease.owner} AND holder=${lease.holder}`;
        if (valid?.valid !== true) throw new DeviceLeaseLost();
      };
      await budget();
      const [held] =
        await tx`SELECT 1 FROM fitness_device_issuance_leases WHERE owner_id=${lease.owner} AND holder=${lease.holder} FOR SHARE`;
      if (!held) throw new DeviceLeaseLost();
      // The account row next, as an import takes it before its enrollment
      // row, so the two never take the same rows in opposite orders. Writes
      // to enrollment rows then find the account already held.
      await budget();
      await tx`INSERT INTO fitness_accounts(owner_id) VALUES(${lease.owner}) ON CONFLICT DO NOTHING`;
      await budget();
      await tx`SELECT owner_id FROM fitness_accounts WHERE owner_id=${lease.owner} FOR UPDATE`;
      if (target) {
        await budget();
        await tx`SELECT 1 FROM fitness_device_enrollments WHERE ${target(tx)} FOR UPDATE`;
      }
      await stillHeld();
      await budget();
      const changed = (await write(tx, budget)).length;
      // A write can still wait, so the lease and the deadline are checked
      // again last; either one passed rolls everything back. COMMIT itself
      // can still stall after this check. That is safe: the lease row stays
      // locked FOR SHARE until the commit ends, so no other request can take
      // the lease over meanwhile, and a commit that lands late is the
      // lost-reply case enrollment already handles. The app may never see
      // the reply, and its next enrollment replaces that key.
      await stillHeld();
      if (lease.deadline !== undefined && performance.now() >= lease.deadline)
        throw new DeviceLeaseLost();
      return changed;
    });
  } catch (error) {
    if (lockWaitEnded(error)) throw new DeviceLeaseLost();
    throw error;
  }
}
/** The minute this server last found the shared attempt window full. */
let fullMinute: number | null = null;
/** Forgets that the current attempt window was full, for tests. */
export function forgetFullAttemptWindow() {
  fullMinute = null;
}
/**
 * Counts one enrollment attempt in the current one-minute window, across
 * every server, unless the window already holds `cap`. Returns whether the
 * attempt fits and the seconds until the next window.
 *
 * A request that arrives once the window is full never waits on its row:
 * this server remembers a full window until it rolls over, and otherwise
 * reads the count without a lock before trying to add to it. The upsert
 * still adds only while the count is under the cap, for requests that
 * arrive together. The first attempt in a window removes windows older
 * than an hour.
 */
export async function countEnrollmentAttempt(
  cap: number,
  sql: Sql = database(),
) {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const wait = Math.max(1, 60 - Math.floor((now / 1000) % 60));
  const full = () => {
    fullMinute = minute;
    return { allowed: false, wait };
  };
  if (cap < 1 || fullMinute === minute) return { allowed: false, wait };
  const [current] =
    await sql`SELECT attempts FROM fitness_device_attempt_windows WHERE window_start = date_trunc('minute', now())`;
  if (current && Number(current.attempts) >= cap) return full();
  const rows =
    await sql`INSERT INTO fitness_device_attempt_windows(window_start, attempts) VALUES(date_trunc('minute', now()), 1) ON CONFLICT (window_start) DO UPDATE SET attempts = fitness_device_attempt_windows.attempts + 1 WHERE fitness_device_attempt_windows.attempts < ${cap} RETURNING attempts`;
  const [row] = rows;
  if (!row) return full();
  if (row.attempts === 1)
    await sql`DELETE FROM fitness_device_attempt_windows WHERE window_start < now() - interval '1 hour'`;
  return { allowed: true, wait };
}
/**
 * Whether a token was already used: by the ID Clerk verified for it, or by
 * the digest of its raw string, which earlier enrollments recorded alone.
 */
export async function enrollmentTokenUsed(
  sql: Sql,
  token: { id: string; digest: string },
) {
  const rows =
    await sql`SELECT 1 FROM fitness_device_enrollments WHERE token_id=${token.id} OR token_digest=${token.digest}`;
  return rows.length > 0;
}
/**
 * Records an enrollment attempt as pending and stops the installation's
 * current key from importing, together in one fenced transaction, before
 * any key changes in Clerk. Recording marks the token as used and reserves
 * the attempt's place in the hourly limit. If the lease or the deadline
 * runs out first, nothing changes: the token stays unused and the current
 * key stays active. Returns false, changing nothing, when the token was
 * already used. Inactive records older than two days, past the token
 * lifetime, are removed.
 */
export async function recordEnrollment(
  sql: Sql,
  lease: DeviceLease,
  attempt: {
    tokenId: string;
    digest: string;
    attemptId: string;
    installationId: string;
  },
) {
  const owner = lease.owner;
  const stale = (tx: TransactionSql) =>
    tx`NOT active AND created_at < now() - interval '2 days'`;
  const current = (tx: TransactionSql) =>
    tx`owner_id=${owner} AND installation_id=${attempt.installationId} AND active`;
  const inserted = await fenced(
    sql,
    lease,
    (tx) => tx`(${stale(tx)}) OR (${current(tx)})`,
    async (tx, budget) => {
      await tx`DELETE FROM fitness_device_enrollments WHERE ${stale(tx)}`;
      await budget();
      // Either identity already recorded means the token was used.
      const rows =
        await tx`INSERT INTO fitness_device_enrollments(owner_id,token_id,token_digest,attempt_id,installation_id) VALUES(${owner},${attempt.tokenId},${attempt.digest},${attempt.attemptId},${attempt.installationId}) ON CONFLICT DO NOTHING RETURNING 1`;
      if (!rows.length) return rows;
      await budget();
      await tx`UPDATE fitness_device_enrollments SET active=false WHERE ${current(tx)}`;
      return rows;
    },
  );
  return inserted === 1;
}
/**
 * Marks the owner's pending attempts ambiguous. Under the lease no other
 * attempt is running, so a pending one ended without recording whether
 * Clerk created its key. A key it created cannot import.
 */
export async function settlePendingEnrollments(sql: Sql, lease: DeviceLease) {
  await fenced(
    sql,
    lease,
    (tx) => tx`owner_id=${lease.owner} AND key_state='pending'`,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET key_state='ambiguous' WHERE owner_id=${lease.owner} AND key_state='pending' RETURNING 1`,
  );
}
/** Records what became of this request's attempt when its key was not issued. */
export async function settleEnrollment(
  sql: Sql,
  lease: DeviceLease,
  attemptId: string,
  state: "ambiguous" | "failed",
) {
  await fenced(
    sql,
    lease,
    (tx) => tx`attempt_id=${attemptId} AND key_state='pending'`,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET key_state=${state} WHERE attempt_id=${attemptId} AND key_state='pending' RETURNING 1`,
  );
}
/**
 * Charges an ambiguous attempt to the hourly limit from when Clerk created
 * its key, once a key with its attempt ID is found.
 */
export async function chargeAmbiguousEnrollment(
  sql: Sql,
  lease: DeviceLease,
  attemptId: string,
  createdAt: Date,
) {
  await fenced(
    sql,
    lease,
    (tx) =>
      tx`owner_id=${lease.owner} AND attempt_id=${attemptId} AND key_state='ambiguous' AND charged_at IS NULL`,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET charged_at=${createdAt} WHERE owner_id=${lease.owner} AND attempt_id=${attemptId} AND key_state='ambiguous' AND charged_at IS NULL RETURNING 1`,
  );
}
/** Hours an ambiguous attempt without a found key counts toward the hourly limit. */
const ambiguousChargeHours = 2;
/**
 * Seconds until each of the owner's attempts stops counting toward the
 * hourly limit, soonest first. A created key counts for an hour from its
 * creation. An attempt whose creation is unconfirmed counts from when it
 * was recorded, for `ambiguousChargeHours`.
 */
export async function hourlyCharges(sql: Sql, owner: string) {
  const rows =
    await sql`SELECT extract(epoch FROM (CASE WHEN charged_at IS NOT NULL THEN charged_at + interval '1 hour' ELSE created_at + make_interval(hours => ${ambiguousChargeHours}) END) - now())::float8 AS remaining FROM fitness_device_enrollments WHERE owner_id=${owner} AND ((charged_at IS NOT NULL AND charged_at > now() - interval '1 hour') OR (charged_at IS NULL AND key_state IN ('pending','ambiguous') AND created_at > now() - make_interval(hours => ${ambiguousChargeHours}))) ORDER BY remaining`;
  return rows.map((row) => z.number().parse(row.remaining));
}
const activeRow = z.object({
  attempt_id: z.string(),
  installation_id: z.string(),
  key_id: z.string(),
});
/** The owner's active device keys, one per installation. */
export async function activeDevices(sql: Sql, owner: string) {
  const rows =
    await sql`SELECT attempt_id, installation_id, key_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND active`;
  return rows.map((row) => {
    const r = activeRow.parse(row);
    return {
      attemptId: r.attempt_id,
      installationId: r.installation_id,
      keyId: r.key_id,
    };
  });
}
/** The owner's ambiguous attempts that have no charge from a found key yet. */
export async function unchargedAmbiguous(sql: Sql, owner: string) {
  const rows =
    await sql`SELECT attempt_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND key_state='ambiguous' AND charged_at IS NULL`;
  return rows.map((row) => z.string().parse(row.attempt_id));
}
/** Stops these keys importing. */
export async function deactivateKeys(
  sql: Sql,
  lease: DeviceLease,
  keyIds: string[],
) {
  if (!keyIds.length) return;
  await fenced(
    sql,
    lease,
    (tx) => tx`owner_id=${lease.owner} AND active AND key_id IN ${tx(keyIds)}`,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET active=false WHERE owner_id=${lease.owner} AND active AND key_id IN ${tx(keyIds)} RETURNING 1`,
  );
}
/** Stops an installation's active key from importing. */
export async function deactivateInstallation(
  sql: Sql,
  lease: DeviceLease,
  installationId: string,
) {
  await fenced(
    sql,
    lease,
    (tx) =>
      tx`owner_id=${lease.owner} AND installation_id=${installationId} AND active`,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET active=false WHERE owner_id=${lease.owner} AND installation_id=${installationId} AND active RETURNING 1`,
  );
}
/**
 * Records the created key, which makes it the installation's active key and
 * charges the hourly limit from now, when Clerk has returned it. Returns
 * whether exactly this attempt changed.
 */
export async function issueEnrollment(
  sql: Sql,
  lease: DeviceLease,
  attemptId: string,
  keyId: string,
) {
  const changed = await fenced(
    sql,
    lease,
    (tx) => tx`attempt_id=${attemptId} AND key_state='pending'`,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET key_state='issued', key_id=${keyId}, active=true, charged_at=greatest(created_at, now()) WHERE attempt_id=${attemptId} AND key_state='pending' RETURNING 1`,
  );
  return changed === 1;
}
/** A device key's claims and the ID Clerk verified. */
export type DeviceKeyClaims = {
  owner: string;
  keyId: string;
  enrollment: string;
  installationId: string;
};
function activeKeyRow(sql: Sql | TransactionSql, key: DeviceKeyClaims) {
  return sql`attempt_id=${key.enrollment} AND owner_id=${key.owner} AND installation_id=${key.installationId} AND key_state='issued' AND active AND key_id=${key.keyId}`;
}
/**
 * Whether this key is its installation's active key: the attempt it names
 * belongs to the owner and installation, is issued and active, and
 * recorded this key ID.
 */
export async function deviceKeyActive(
  key: DeviceKeyClaims,
  sql: Sql = database(),
) {
  const rows =
    await sql`SELECT 1 FROM fitness_device_enrollments WHERE ${activeKeyRow(sql, key)}`;
  return rows.length === 1;
}
/**
 * Deactivates this key's attempt when it is the installation's active key.
 * Returns whether it was.
 */
export async function deactivateDeviceKey(
  sql: Sql,
  lease: DeviceLease,
  key: DeviceKeyClaims,
) {
  const changed = await fenced(
    sql,
    lease,
    (tx) => tx`${activeKeyRow(tx, key)}`,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET active=false WHERE ${activeKeyRow(tx, key)} RETURNING 1`,
  );
  return changed === 1;
}
const enrollmentColumns = [
  "owner_id",
  "token_id",
  "token_digest",
  "attempt_id",
  "installation_id",
  "key_state",
  "key_id",
  "active",
  "charged_at",
  "created_at",
];
const leaseColumns = ["owner_id", "holder", "expires_at"];
const windowColumns = ["window_start", "attempts"];
/**
 * Whether enrollment can use its tables, in one query: each table and its
 * columns are in the connection's schema, and the database user may read,
 * add, change and remove their rows and add accounts. Nothing is written.
 * has_table_privilege is true when any listed privilege is held, so each
 * one is checked on its own, and only for tables that exist.
 */
export async function enrollmentTableReady(sql: Sql = database()) {
  const grants = (table: string) =>
    sql`has_table_privilege(current_user, ${table}, 'SELECT') AND has_table_privilege(current_user, ${table}, 'INSERT') AND has_table_privilege(current_user, ${table}, 'UPDATE') AND has_table_privilege(current_user, ${table}, 'DELETE')`;
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = current_schema() AND (
          (table_name = 'fitness_device_enrollments' AND column_name IN ${sql(enrollmentColumns)})
          OR (table_name = 'fitness_device_issuance_leases' AND column_name IN ${sql(leaseColumns)})
          OR (table_name = 'fitness_device_attempt_windows' AND column_name IN ${sql(windowColumns)}))) AS columns,
      CASE
        WHEN to_regclass('fitness_device_enrollments') IS NULL
          OR to_regclass('fitness_device_issuance_leases') IS NULL
          OR to_regclass('fitness_device_attempt_windows') IS NULL
          OR to_regclass('fitness_accounts') IS NULL THEN false
        ELSE ${grants("fitness_device_enrollments")}
          AND ${grants("fitness_device_issuance_leases")}
          AND ${grants("fitness_device_attempt_windows")}
          AND has_table_privilege(current_user, 'fitness_accounts', 'INSERT')
      END AS granted`;
  return (
    row?.columns ===
      enrollmentColumns.length + leaseColumns.length + windowColumns.length &&
    row.granted === true
  );
}
async function lockAccount(sql: TransactionSql, owner: string) {
  await sql`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
  // All account writes share this lock. Receipts and record updates commit together.
  await sql`SELECT owner_id FROM fitness_accounts WHERE owner_id=${owner} FOR UPDATE`;
}
async function saveWithin(
  sql: TransactionSql,
  owner: string,
  request: Mutation,
): Promise<SaveResult> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  const [receipt] =
    await sql`SELECT fingerprint, result FROM fitness_operations WHERE owner_id=${owner} AND id=${request.operationId}`;
  if (receipt) {
    if (receipt.fingerprint !== fingerprint)
      throw new StoreRuleError(
        "This save request ID was already used. Reload before retrying.",
      );
    return resultSchema.parse(receipt.result);
  }
  const [row] =
    await sql`SELECT id,revision,data,updated_at,deleted FROM fitness_records WHERE owner_id=${owner} AND id=${request.id}`;
  const current = row && !row.deleted ? entry(row) : null;
  const revision = row ? z.number().int().parse(row.revision) : 0;
  if (revision !== request.revision) return { status: "conflict", current };
  if (request.data?.kind === "weight") {
    const [sameDay] =
      await sql`SELECT id,revision,data,updated_at FROM fitness_records WHERE owner_id=${owner} AND deleted=false AND data->>'kind'='weight' AND data->>'date'=${request.data.date} AND id<>${request.id}`;
    if (sameDay) return { status: "conflict", current: entry(sameDay) };
  }
  if (request.data?.kind === "workout" && !request.data.finishedAt) {
    const [active] =
      await sql`SELECT id,revision,data,updated_at FROM fitness_records WHERE owner_id=${owner} AND deleted=false AND data->>'kind'='workout' AND data->>'finishedAt' IS NULL AND id<>${request.id}`;
    if (active) return { status: "conflict", current: entry(active) };
  }
  if (request.data?.kind === "settings" && request.id !== settingsId)
    throw new StoreRuleError("Invalid settings record.");
  if (request.id === settingsId && request.data?.kind !== "settings")
    throw new StoreRuleError("Settings must remain available.");
  if (current && request.data && current.data.kind !== request.data.kind)
    throw new StoreRuleError("Record type cannot change.");
  if (current?.data.kind === "workout" && current.data.finishedAt)
    throw new StoreRuleError("Completed workouts keep their original results.");
  let original: Workout | null = null;
  if (request.data?.kind === "workoutCorrection") {
    const correction = request.data;
    if (
      current?.data.kind === "workoutCorrection" &&
      current.data.workoutId !== correction.workoutId
    )
      throw new StoreRuleError(
        "A correction stays linked to its original workout.",
      );
    const [originalRow] =
      await sql`SELECT id,revision,data,updated_at FROM fitness_records WHERE owner_id=${owner} AND id=${correction.workoutId} AND deleted=false`;
    const target = originalRow ? entry(originalRow).data : null;
    if (target?.kind !== "workout" || !target.finishedAt)
      throw new StoreRuleError(
        "Choose one of your completed workouts to correct.",
      );
    original = target;
    const problem = correction.replacement
      ? correctionProblem(target, correction.replacement)
      : null;
    if (problem) throw new StoreRuleError(problem);
    const [other] =
      await sql`SELECT id,revision,data,updated_at FROM fitness_records WHERE owner_id=${owner} AND deleted=false AND data->>'kind'='workoutCorrection' AND data->>'workoutId'=${correction.workoutId} AND id<>${request.id}`;
    if (other) return { status: "conflict", current: entry(other) };
  }
  // Completed activity cannot be dated after the owner's current day.
  // Records keep a date they already had, so existing drafts stay editable.
  const activity =
    request.data?.kind === "workoutCorrection"
      ? request.data.replacement
      : request.data?.kind === "workout" || request.data?.kind === "run"
        ? request.data
        : null;
  const previousDate =
    original?.date ??
    (current?.data.kind === "workout" || current?.data.kind === "run"
      ? current.data.date
      : null);
  if (activity && activity.date !== previousDate) {
    const [configuration] =
      await sql`SELECT data FROM fitness_records WHERE owner_id=${owner} AND id=${settingsId} AND deleted=false`;
    const timezone = configuration
      ? settingsSchema.parse(configuration.data).timezone
      : "UTC";
    if (activity.date > localDate(timezone))
      throw new StoreRuleError(
        "Record training on today or an earlier date. Future plans are for previewing.",
      );
  }
  const nextRevision = revision + 1;
  const data = request.data;
  const [saved] =
    await sql`INSERT INTO fitness_records(owner_id,id,revision,data,deleted) VALUES(${owner},${request.id},${nextRevision},${sql.json(data)},${data === null}) ON CONFLICT(owner_id,id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,deleted=EXCLUDED.deleted,updated_at=now() RETURNING id,revision,data,updated_at`;
  const result: SaveResult = {
    status: "saved",
    record: data ? entry(saved) : null,
  };
  await sql`INSERT INTO fitness_operations(owner_id,id,fingerprint,result) VALUES(${owner},${request.operationId},${fingerprint},${sql.json(result)})`;
  return result;
}
