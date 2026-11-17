import postgres from "postgres";
let connection: ReturnType<typeof postgres> | undefined;
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
