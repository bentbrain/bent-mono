/**
 * A Postgres schema of its own for one test run, so suites that prune or
 * count across every owner never touch the shared test database's data.
 */
import postgres from "postgres";

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
  return {
    /** The database URL whose connections use only this schema. */
    url: url?.href ?? "",
    create: () => admin(`CREATE SCHEMA ${schema}`),
    drop: () => admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
  };
}
