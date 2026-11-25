/**
 * A session that ends while a transaction's statement is running, as when a
 * pooler drops the connection or the server ends it, must reject that
 * transaction and leave the process and the pool working. postgres.js 3.4.9
 * instead threw an uncaught TypeError from its deferred ROLLBACK
 * (https://github.com/porsager/postgres/issues/1248), which ends a Node.js
 * process.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
const url = process.env.FITNESS_TEST_DATABASE_URL ?? "";
const before = "integration:" + crypto.randomUUID();
const after = "integration:" + crypto.randomUUID();
// One connection, so the query after the disconnect reuses the connection
// that was lost rather than another one in the pool.
const options = { max: 1, prepare: false, onnotice: () => undefined };
let admin: ReturnType<typeof postgres> | undefined;

beforeAll(async () => {
  if (!configured) return;
  admin = postgres(url, options);
  await admin.unsafe(
    await Bun.file(new URL("../schema.sql", import.meta.url)).text(),
  );
});
afterAll(async () => {
  if (!admin) return;
  await admin`DELETE FROM fitness_accounts WHERE owner_id IN (${before}, ${after})`;
  await admin.end();
});

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

test.skipIf(!configured)(
  "a session ended mid-transaction rejects the transaction and leaves the process and pool working",
  async () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    const sql = postgres(url, options);
    try {
      let backend: (pid: number) => void = () => undefined;
      const started = new Promise<number>((resolve) => (backend = resolve));
      let laterStatement: unknown = "not attempted";
      const outcome = sql
        .begin(async (tx) => {
          await tx`INSERT INTO fitness_accounts (owner_id) VALUES (${before})`;
          const [row] = await tx<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          backend(row?.pid ?? 0);
          // Careless code that swallows the failure and carries on must not
          // get its next statement run outside the transaction.
          await tx`SELECT pg_sleep(30)`.catch(() => undefined);
          laterStatement = await tx`INSERT INTO fitness_accounts (owner_id) VALUES (${after})`.then(
            () => "ran",
            (error: unknown) => error,
          );
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await terminateWhenSleeping(admin as postgres.Sql, await started);
      const error = await outcome;
      // postgres.js deferred its failing write to the next turn of the event loop.
      await Bun.sleep(200);

      expect(uncaught).toEqual([]);
      expect(error).toBeInstanceOf(Error);
      expect(["57P01", "CONNECTION_CLOSED"]).toContain(
        String((error as { code?: unknown }).code),
      );
      expect(laterStatement).not.toBe("ran");

      const [next] = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(next?.ok).toBe(1);
      const committed = await sql`
        SELECT owner_id FROM fitness_accounts
        WHERE owner_id IN (${before}, ${after})`;
      expect(committed).toHaveLength(0);
    } finally {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
      await sql.end({ timeout: 1 });
    }
  },
  20_000,
);
