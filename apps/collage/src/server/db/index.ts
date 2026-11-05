import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/env";
import * as schema from "./schema";

function createDatabase() {
  const connection = postgres(env.DATABASE_URI);
  return drizzle(connection, { schema });
}

type Database = ReturnType<typeof createDatabase>;

declare global {
  var mayaCollageDatabase: Database | undefined;
}

let database: Database | undefined;

/** Lazily initialize the database so build-time module evaluation is safe. */
export function getDb() {
  if (database) return database;

  database = globalThis.mayaCollageDatabase ?? createDatabase();
  if (env.NODE_ENV !== "production") {
    globalThis.mayaCollageDatabase = database;
  }

  return database;
}
