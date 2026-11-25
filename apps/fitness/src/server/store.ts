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
import type { Sql, TransactionSql } from "postgres";
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
/**
 * COMMIT failed or its reply was lost, so the transaction may or may not
 * have committed. Errors before COMMIT always roll back and are thrown as
 * they are.
 */
export class CommitOutcomeUnknown extends Error {
  constructor(readonly reason: unknown) {
    super("The commit's outcome is unknown.");
  }
}
/** Postgres canceled a statement on its timeout, or found a lock taken. */
function lockWaitEnded(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "57014" || code === "55P03";
}
/**
 * How long each statement in an enrollment transaction, and each lock it
 * waits for, may take. An import holds the account for its whole
 * transaction, so this leaves room for one to finish.
 */
const defaultEnrollmentWaitMs = 10_000;
let enrollmentWaitMs = defaultEnrollmentWaitMs;
/** Sets `enrollmentWaitMs`, or restores the default, for tests. */
export function setEnrollmentWait(ms = defaultEnrollmentWaitMs) {
  enrollmentWaitMs = ms;
}
/**
 * Runs one short enrollment transaction for the owner. It locks the
 * owner's account row first, as an import does before it reads its
 * enrollment row, so the two always take locks in the same order and an
 * enrollment waits for an import already running. Each statement and
 * lock wait stops after `enrollmentWaitMs`. An error after the COMMIT was
 * sent throws CommitOutcomeUnknown; any other error means nothing changed.
 */
async function underAccount<T>(
  owner: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let committing = false;
  try {
    const result = await database().begin(async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${String(enrollmentWaitMs)}, true)`;
      await tx`SELECT set_config('lock_timeout', ${String(enrollmentWaitMs)}, true)`;
      await lockAccount(tx, owner);
      const value = await work(tx);
      committing = true;
      return { value };
    });
    return result.value;
  } catch (error) {
    if (committing) throw new CommitOutcomeUnknown(error);
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
/** Why an enrollment attempt was refused before it used the token. */
export type EnrollmentRefusal =
  | { reason: "token_used" }
  | { reason: "device_limit" }
  | { reason: "rate_limited"; retryAfter: number }
  | { reason: "busy" };
/** Rolls back an attempt's transaction with the reason it was refused. */
class Refused extends Error {
  constructor(readonly refusal: EnrollmentRefusal) {
    super(refusal.reason);
  }
}
/**
 * Records an enrollment attempt as pending, in one short transaction
 * before any key changes in Clerk. Recording uses the token and reserves
 * the attempt's place in the hourly limit. The installation's current key
 * keeps importing until its replacement is swapped in.
 *
 * Under the account lock, the transaction refuses the attempt, changing
 * nothing and leaving the token unused, when:
 *
 * - the token was already used, by the ID Clerk verified for it or by the
 *   digest of its raw string, which earlier enrollments recorded alone;
 * - the hourly limit is full, counting this attempt: keys created in the
 *   last hour and attempts that may have created one; or
 * - the owner's other installations with an active key or an attempt
 *   still being issued, within `pendingGraceMinutes`, and this one, are
 *   more than the installation limit.
 *
 * A transaction that waits too long on a lock or statement rolls back too,
 * with reason `busy`. Inactive records older than two days, past the token
 * lifetime, are removed. Returns null once the attempt is recorded. An
 * error after the COMMIT was sent throws CommitOutcomeUnknown, and the
 * token may be used.
 */
export async function recordEnrollment(
  owner: string,
  attempt: {
    tokenId: string;
    digest: string;
    attemptId: string;
    installationId: string;
  },
  limits: { installations: number; perHour: number },
): Promise<EnrollmentRefusal | null> {
  try {
    await underAccount(owner, async (tx) => {
      await tx`DELETE FROM fitness_device_enrollments WHERE NOT active AND created_at < now() - interval '2 days'`;
      const used =
        await tx`SELECT 1 FROM fitness_device_enrollments WHERE token_id=${attempt.tokenId} OR token_digest=${attempt.digest}`;
      if (used.length) throw new Refused({ reason: "token_used" });
      const charges = await hourlyCharges(tx, owner);
      if (charges.length + 1 > limits.perHour) {
        const freed = charges[charges.length - limits.perHour] ?? 1;
        throw new Refused({
          reason: "rate_limited",
          retryAfter: Math.max(1, Math.ceil(freed)),
        });
      }
      // Other installations hold a place while they have an active key or
      // an attempt still being issued, so attempts for new installations
      // that overlap cannot pass the limit together.
      const [others] =
        await tx`SELECT count(DISTINCT installation_id)::int AS installations FROM fitness_device_enrollments WHERE owner_id=${owner} AND installation_id<>${attempt.installationId} AND (active OR (key_state='pending' AND created_at > now() - make_interval(mins => ${pendingGraceMinutes})))`;
      if (Number(others?.installations ?? 0) + 1 > limits.installations)
        throw new Refused({ reason: "device_limit" });
      // Either identity recorded meanwhile means the token was used.
      const inserted =
        await tx`INSERT INTO fitness_device_enrollments(owner_id,token_id,token_digest,attempt_id,installation_id) VALUES(${owner},${attempt.tokenId},${attempt.digest},${attempt.attemptId},${attempt.installationId}) ON CONFLICT DO NOTHING RETURNING 1`;
      if (!inserted.length) throw new Refused({ reason: "token_used" });
    });
    return null;
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    if (lockWaitEnded(error)) return { reason: "busy" };
    throw error;
  }
}
/**
 * Records what became of an attempt whose key was not issued. `createdAt`
 * is when Clerk created its key, if it did; the attempt then keeps
 * counting toward the hourly limit from then, whatever its state.
 */
export async function settleEnrollment(
  owner: string,
  attemptId: string,
  state: "ambiguous" | "failed",
  createdAt: Date | null = null,
) {
  await underAccount(
    owner,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET key_state=${state}, charged_at=coalesce(charged_at, ${createdAt}) WHERE owner_id=${owner} AND attempt_id=${attemptId} AND key_state='pending'`,
  );
}
/**
 * Charges an ambiguous attempt to the hourly limit from when Clerk created
 * its key, once a key with its attempt ID is found.
 */
export async function chargeAmbiguousEnrollment(
  owner: string,
  attemptId: string,
  createdAt: Date,
) {
  await underAccount(
    owner,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET charged_at=${createdAt} WHERE owner_id=${owner} AND attempt_id=${attemptId} AND key_state='ambiguous' AND charged_at IS NULL`,
  );
}
/** Hours an ambiguous attempt without a found key counts toward the hourly limit. */
const ambiguousChargeHours = 2;
/**
 * Seconds until each of the owner's attempts stops counting toward the
 * hourly limit, soonest first. A created key counts for an hour from its
 * creation. An attempt whose creation is unconfirmed, pending or
 * ambiguous, counts from when it was recorded, for `ambiguousChargeHours`.
 */
async function hourlyCharges(sql: Sql | TransactionSql, owner: string) {
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
export async function activeDevices(owner: string) {
  const rows =
    await database()`SELECT attempt_id, installation_id, key_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND active`;
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
export async function unchargedAmbiguous(owner: string) {
  const rows =
    await database()`SELECT attempt_id FROM fitness_device_enrollments WHERE owner_id=${owner} AND key_state='ambiguous' AND charged_at IS NULL`;
  return rows.map((row) => z.string().parse(row.attempt_id));
}
/**
 * Minutes an attempt may stay pending while its request is still working
 * on it. A request ends long before this, so an older pending attempt was
 * abandoned.
 */
const pendingGraceMinutes = 10;
/**
 * Which of these keys no current enrollment needs, in one short
 * transaction under the account lock. First, attempts still pending after
 * `pendingGraceMinutes` were abandoned: they become ambiguous, which can
 * never be activated, and one whose key is listed is charged from that
 * key's creation. Then the needed keys are an active row's key and one an
 * attempt still pending within the grace may yet swap in; every other key
 * is returned, for the caller to revoke.
 */
export async function unneededKeys(
  owner: string,
  keys: { id: string; enrollment: string | null; createdAt: number }[],
) {
  const attempts = [
    ...new Set(keys.flatMap((k) => (k.enrollment ? [k.enrollment] : []))),
  ];
  const rows = await underAccount(owner, async (tx) => {
    const expired =
      await tx`UPDATE fitness_device_enrollments SET key_state='ambiguous' WHERE owner_id=${owner} AND key_state='pending' AND created_at <= now() - make_interval(mins => ${pendingGraceMinutes}) RETURNING attempt_id`;
    for (const row of expired) {
      const key = keys.find((k) => k.enrollment === String(row.attempt_id));
      if (key)
        await tx`UPDATE fitness_device_enrollments SET charged_at=coalesce(charged_at, ${new Date(key.createdAt)}) WHERE owner_id=${owner} AND attempt_id=${row.attempt_id}`;
    }
    return attempts.length
      ? tx`SELECT attempt_id, active, key_id, key_state = 'pending' AS working FROM fitness_device_enrollments WHERE owner_id=${owner} AND attempt_id::text IN ${tx(attempts)}`
      : [];
  });
  const byAttempt = new Map(rows.map((row) => [String(row.attempt_id), row]));
  return keys
    .filter((key) => {
      const row = key.enrollment ? byAttempt.get(key.enrollment) : undefined;
      if (!row) return true;
      if (row.working === true) return false;
      return !(row.active === true && row.key_id === key.id);
    })
    .map((key) => key.id);
}
/** Stops these keys importing. */
export async function deactivateKeys(owner: string, keyIds: string[]) {
  if (!keyIds.length) return;
  await underAccount(
    owner,
    (tx) =>
      tx`UPDATE fitness_device_enrollments SET active=false WHERE owner_id=${owner} AND active AND key_id IN ${tx(keyIds)}`,
  );
}
/** The swap would not activate this attempt; nothing changes. */
class NotActivated extends Error {
  constructor(readonly reason: "not_pending" | "device_limit") {
    super(reason);
  }
}
/**
 * Swaps the created key in as the installation's active key, in one short
 * transaction under the account lock: the installation's rows are locked,
 * its current row stops being active and this attempt's row records the
 * key, becomes active and is charged from the key's creation. The installation therefore
 * always has at most one active key and never goes without one before its
 * replacement exists. Nothing changes, and `reason` says why, if this
 * attempt is no longer pending, or if activating it would give more
 * installations active keys than the limit. Returns whether this attempt
 * became active, and the keys it replaced, which the caller revokes after
 * the commit. An error after the COMMIT was sent throws
 * CommitOutcomeUnknown.
 */
export async function swapEnrollment(
  owner: string,
  attempt: {
    attemptId: string;
    installationId: string;
    keyId: string;
    /** When Clerk created the key, which the attempt is charged from. */
    createdAt?: Date;
  },
  limits: { installations: number },
) {
  try {
    return await underAccount(owner, async (tx) => {
      await tx`SELECT 1 FROM fitness_device_enrollments WHERE owner_id=${owner} AND ((installation_id=${attempt.installationId} AND active) OR attempt_id=${attempt.attemptId}) FOR UPDATE`;
      const old =
        await tx`UPDATE fitness_device_enrollments SET active=false WHERE owner_id=${owner} AND installation_id=${attempt.installationId} AND active AND attempt_id<>${attempt.attemptId} RETURNING key_id`;
      const activated =
        await tx`UPDATE fitness_device_enrollments SET key_state='issued', key_id=${attempt.keyId}, active=true, charged_at=coalesce(charged_at, ${attempt.createdAt ?? null}, greatest(created_at, now())) WHERE owner_id=${owner} AND attempt_id=${attempt.attemptId} AND key_state='pending' RETURNING 1`;
      if (!activated.length) throw new NotActivated("not_pending");
      const [others] =
        await tx`SELECT count(DISTINCT installation_id)::int AS installations FROM fitness_device_enrollments WHERE owner_id=${owner} AND active AND installation_id<>${attempt.installationId}`;
      if (Number(others?.installations ?? 0) + 1 > limits.installations)
        throw new NotActivated("device_limit");
      return {
        activated: true,
        replaced: old.map((row) => z.string().parse(row.key_id)),
        reason: null,
      };
    });
  } catch (error) {
    if (error instanceof NotActivated)
      return {
        activated: false,
        replaced: [] as string[],
        reason: error.reason,
      };
    throw error;
  }
}
/**
 * What became of a swap whose commit reply was lost, read on a connection
 * of its own. The attempt's row and the installation's previous rows are
 * read FOR SHARE, so the read waits for a swap that is still committing,
 * for up to five seconds.
 *
 * - `committed`: the attempt's row is issued, active and holds this key.
 *   `replaced` lists the keys that same commit deactivated: the
 *   installation's inactive rows whose last change, their `xmin`, is the
 *   attempt row's. A row a later transaction changed again is left out,
 *   for a later cleanup.
 * - `undone`: the attempt's row is not active, and the previous key, if
 *   there was one, still is.
 * - `unknown`: anything else. A lock timeout or other error is thrown.
 */
export async function swapOutcome(attempt: {
  owner: string;
  attemptId: string;
  installationId: string;
  keyId: string;
  previousKeyIds: string[];
}) {
  return database().begin(async (tx) => {
    await tx`SELECT set_config('lock_timeout', '5s', true)`;
    await tx`SELECT set_config('statement_timeout', '5s', true)`;
    const [row] =
      await tx`SELECT key_state, active, key_id FROM fitness_device_enrollments WHERE attempt_id=${attempt.attemptId} FOR SHARE`;
    const previous = attempt.previousKeyIds.length
      ? await tx`SELECT key_id FROM fitness_device_enrollments WHERE owner_id=${attempt.owner} AND installation_id=${attempt.installationId} AND active AND key_id IN ${tx(attempt.previousKeyIds)} FOR SHARE`
      : [];
    if (
      row?.key_state === "issued" &&
      row.active === true &&
      row.key_id === attempt.keyId
    ) {
      const replaced =
        await tx`SELECT key_id FROM fitness_device_enrollments WHERE owner_id=${attempt.owner} AND installation_id=${attempt.installationId} AND NOT active AND key_id IS NOT NULL AND attempt_id<>${attempt.attemptId} AND xmin = (SELECT xmin FROM fitness_device_enrollments WHERE attempt_id=${attempt.attemptId})`;
      return {
        outcome: "committed" as const,
        replaced: replaced.map((r) => z.string().parse(r.key_id)),
      };
    }
    if (
      row &&
      row.active !== true &&
      previous.length === attempt.previousKeyIds.length
    )
      return { outcome: "undone" as const, replaced: [] as string[] };
    return { outcome: "unknown" as const, replaced: [] as string[] };
  });
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
 * Deactivates this key's attempt when it is the installation's active key,
 * in one short transaction under the account lock, so a disconnect waits
 * for an import already running with this key. Returns whether it was
 * active.
 */
export async function deactivateDeviceKey(key: DeviceKeyClaims) {
  return underAccount(key.owner, async (tx) => {
    await tx`SELECT 1 FROM fitness_device_enrollments WHERE ${activeKeyRow(tx, key)} FOR UPDATE`;
    const changed =
      await tx`UPDATE fitness_device_enrollments SET active=false WHERE ${activeKeyRow(tx, key)} RETURNING 1`;
    return changed.length === 1;
  });
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
const windowColumns = ["window_start", "attempts"];
/**
 * Whether enrollment can use its tables, in one query: each table and its
 * columns are in the connection's schema, and the database user may read,
 * add, change and remove their rows, and add and lock accounts (SELECT ...
 * FOR UPDATE needs UPDATE). Nothing is written.
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
          OR (table_name = 'fitness_device_attempt_windows' AND column_name IN ${sql(windowColumns)}))) AS columns,
      CASE
        WHEN to_regclass('fitness_device_enrollments') IS NULL
          OR to_regclass('fitness_device_attempt_windows') IS NULL
          OR to_regclass('fitness_accounts') IS NULL THEN false
        ELSE ${grants("fitness_device_enrollments")}
          AND ${grants("fitness_device_attempt_windows")}
          AND has_table_privilege(current_user, 'fitness_accounts', 'SELECT')
          AND has_table_privilege(current_user, 'fitness_accounts', 'INSERT')
          AND has_table_privilege(current_user, 'fitness_accounts', 'UPDATE')
      END AS granted`;
  return (
    row?.columns === enrollmentColumns.length + windowColumns.length &&
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
