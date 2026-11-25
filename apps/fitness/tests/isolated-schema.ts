/**
 * A Postgres schema of its own for one test run, so suites that prune or
 * count across every owner never touch the shared test database's data.
 * The app's database pool points at the schema between `create` and `drop`.
 */
import postgres from "postgres";
import { resetDatabaseForTests, setDatabaseForTests } from "../src/server/db";

export function isolatedSchema(prefix: string) {
  const base = process.env.FITNESS_TEST_DATABASE_URL ?? "";
  const schema = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = base ? new URL(base) : null;
  url?.searchParams.set("search_path", schema);
  const admin = async (statement: string) => {
    const sql = postgres(base, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(statement);
    } finally {
      await sql.end();
    }
  };
  let pool: ReturnType<typeof postgres> | undefined;
  return {
    /** The database URL whose connections use only this schema. */
    url: url?.href ?? "",
    /** The pool the app uses while the schema exists. */
    pool() {
      if (!pool) throw new Error("Create the schema first.");
      return pool;
    },
    async create() {
      await admin(`CREATE SCHEMA ${schema}`);
      pool = postgres(url?.href ?? "", {
        max: 3,
        prepare: false,
        onnotice: () => undefined,
      });
      setDatabaseForTests(pool);
    },
    async drop() {
      resetDatabaseForTests();
      await pool?.end();
      await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    },
  };
}
