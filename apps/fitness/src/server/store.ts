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
 * Runs device key changes for an owner one at a time, under a per-owner
 * advisory lock held on one connection. Statements on that connection
 * commit as they run, so an enrollment attempt is recorded before Clerk is
 * called and stays recorded if the call fails.
 */
export async function withDeviceLock<T>(
  owner: string,
  work: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = await database().reserve();
  const key = "fitness-devices:" + owner;
  try {
    await sql`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
    try {
      return await work(sql);
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
    }
  } finally {
    sql.release();
  }
}
export async function enrollmentTokenUsed(sql: Sql, digest: string) {
  const rows =
    await sql`SELECT 1 FROM fitness_device_enrollments WHERE token_digest=${digest}`;
  return rows.length > 0;
}
/**
 * Records an enrollment attempt as pending, which also marks its token as
 * used. Returns false when the token was already used. Records older than
 * two days, past the token lifetime, are removed.
 */
export async function recordEnrollment(
  sql: Sql,
  attempt: {
    owner: string;
    digest: string;
    attemptId: string;
    installationId: string;
  },
) {
  await sql`INSERT INTO fitness_accounts(owner_id) VALUES(${attempt.owner}) ON CONFLICT DO NOTHING`;
  await sql`DELETE FROM fitness_device_enrollments WHERE created_at < now() - interval '2 days'`;
  const rows =
    await sql`INSERT INTO fitness_device_enrollments(owner_id,token_digest,attempt_id,installation_id) VALUES(${attempt.owner},${attempt.digest},${attempt.attemptId},${attempt.installationId}) ON CONFLICT (token_digest) DO NOTHING RETURNING token_digest`;
  return rows.length === 1;
}
const pendingRow = z.object({
  attempt_id: z.string(),
  installation_id: z.string(),
  age: z.coerce.number(),
});
/** The owner's enrollment attempts whose key Fitness has not confirmed, with their age in seconds. */
export async function pendingEnrollments(sql: Sql, owner: string) {
  const rows =
    await sql`SELECT attempt_id, installation_id, extract(epoch FROM now() - created_at) AS age FROM fitness_device_enrollments WHERE owner_id=${owner} AND key_state='pending'`;
  return rows.map((row) => {
    const r = pendingRow.parse(row);
    return {
      attemptId: r.attempt_id,
      installationId: r.installation_id,
      ageSeconds: r.age,
    };
  });
}
export async function settleEnrollment(
  sql: Sql,
  attemptId: string,
  state: "issued" | "failed",
) {
  await sql`UPDATE fitness_device_enrollments SET key_state=${state} WHERE attempt_id=${attemptId} AND key_state='pending'`;
}
/**
 * Whether the device enrollment table, with its attempt columns, is in the
 * connection's schema.
 */
export async function enrollmentTableExists(sql: Sql = database()) {
  const [row] =
    await sql`SELECT count(*)::int AS columns FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='fitness_device_enrollments' AND column_name IN ('attempt_id','key_state')`;
  return row?.columns === 2;
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
