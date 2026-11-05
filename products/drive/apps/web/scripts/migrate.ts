import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as PgClient from "@effect/sql-pg/PgClient";
import { Data, Effect } from "effect";

import { runApp } from "../src/lib/runtime";

class MigrationFileError extends Data.TaggedError("MigrationFileError")<{
  path: string;
  message: string;
}> {}

const schemaPath = join(process.cwd(), "db", "schema.sql");
const program = Effect.gen(function* () {
  const schema = yield* Effect.tryPromise({
    try: () => readFile(schemaPath, "utf8"),
    catch: (error) =>
      new MigrationFileError({
        path: schemaPath,
        message: error instanceof Error ? error.message : "Could not read the migration file.",
      }),
  });
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const sql = yield* PgClient.PgClient;
  yield* sql.withTransaction(
    Effect.forEach(statements, (statement) => sql.unsafe<Record<string, unknown>>(statement), {
      discard: true,
    })
  );
  yield* Effect.logInfo("database.migration.complete").pipe(
    Effect.annotateLogs({ statementCount: statements.length })
  );
}).pipe(Effect.withSpan("database.migrate"));

void runApp(program).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
