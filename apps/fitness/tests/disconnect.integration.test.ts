/**
 * A session that ends while a transaction's statement is running, as when a
 * pooler drops the connection or the server ends it, must reject that
 * transaction and leave the process and the pool working. postgres.js 3.4.9
 * instead threw an uncaught TypeError from its deferred ROLLBACK
 * (https://github.com/porsager/postgres/issues/1248), which ends a Node.js
 * process.
 *
 * The test runs in a schema of its own with one fixture table, and drops it
 * afterwards, so it never changes the shared test database's tables.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
const url = process.env.FITNESS_TEST_DATABASE_URL ?? "";
const schema = `fitness_disconnect_${crypto.randomUUID().replaceAll("-", "")}`;
// One connection each, so the query after the disconnect reuses the
// connection that was lost rather than another one in the pool.
const options = {
  max: 1,
  prepare: false,
  onnotice: () => undefined,
  connection: { search_path: schema },
};
let admin: postgres.Sql | undefined;

beforeAll(async () => {
  if (!configured) return;
  admin = postgres(url, options);
  await admin`CREATE SCHEMA ${admin(schema)}`;
  await admin`CREATE TABLE accounts (owner_id text PRIMARY KEY)`;
});
afterAll(async () => {
  if (!admin) return;
  try {
    await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
  } finally {
    await admin.end();
  }
});

function code(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function terminateWhenSleeping(sql: postgres.Sql, pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await sql<{ running: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid = ${pid} AND state = 'active' AND query LIKE '%pg_sleep%'
      ) AS running`;
    if (row?.running) {
      await sql`SELECT pg_terminate_backend(${pid})`;
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("The transaction's statement never started.");
}

type LateWrite = { ran: true } | { ran: false; error: unknown };

test.skipIf(!configured)(
  "a session ended mid-transaction rejects the transaction and leaves the process and pool working",
  async () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    const sql = postgres(url, options);
    try {
      let started: (pid: number) => void = () => undefined;
      const backend = new Promise<number>((resolve) => (started = resolve));
      let attempted: (outcome: LateWrite) => void = () => undefined;
      const lateWrite = new Promise<LateWrite>(
        (resolve) => (attempted = resolve),
      );
      const outcome = sql
        .begin(async (tx) => {
          await tx`INSERT INTO accounts (owner_id) VALUES ('before')`;
          const [row] = await tx<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          started(row?.pid ?? 0);
          // Careless code that swallows the failure and carries on must not
          // get its next statement run outside the transaction.
          await tx`SELECT pg_sleep(30)`.catch(() => undefined);
          const result =
            await tx`INSERT INTO accounts (owner_id) VALUES ('after')`.then(
              (): LateWrite => ({ ran: true }),
              (error: unknown): LateWrite => ({ ran: false, error }),
            );
          attempted(result);
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await terminateWhenSleeping(admin as postgres.Sql, await backend);

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(["57P01", "CONNECTION_CLOSED"]).toContain(code(error) ?? "");

      const late = await lateWrite;
      expect(late.ran).toBe(false);
      expect(late.ran ? undefined : late.error).toBeInstanceOf(Error);

      const [next] = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(next?.ok).toBe(1);
      expect(await sql`SELECT owner_id FROM accounts`).toHaveLength(0);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
      await sql.end({ timeout: 1 });
    }
  },
  20_000,
);
