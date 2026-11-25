import postgres from "postgres";
let connection: ReturnType<typeof postgres> | undefined;
/** The process's one pool for DATABASE_URL, created on first use. */
export function database() {
  if (connection) return connection;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Database configuration is required.");
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  connection = postgres(url, {
    ssl: local ? false : "verify-full",
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return connection;
}

let replaced: { previous: typeof connection } | undefined;
function requireTests() {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Only tests can replace the database.");
}
/**
 * Uses this pool in place of the process's own, for tests that run in a
 * schema of their own. Outside tests it throws, so the database cannot
 * change at runtime.
 */
export function setDatabaseForTests(sql: ReturnType<typeof postgres>) {
  requireTests();
  replaced ??= { previous: connection };
  connection = sql;
}
/** Restores the pool a test replaced. The test closes its own pool. */
export function resetDatabaseForTests() {
  requireTests();
  connection = replaced?.previous;
  replaced = undefined;
}
