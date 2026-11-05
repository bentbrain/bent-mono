import postgres from "postgres";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const legacyColumns = [
  "id",
  "alt",
  "is_nsfw",
  "prefix",
  "updated_at",
  "created_at",
  "url",
  "thumbnail_u_r_l",
  "filename",
  "mime_type",
  "filesize",
  "width",
  "height",
  "focal_x",
  "focal_y",
];
const columnSchema = z.object({
  column_name: z.string(),
  data_type: z.string(),
  is_nullable: z.string(),
  character_maximum_length: z.number().nullable(),
  column_default: z.string().nullable(),
});
const statsSchema = z.object({ count: z.string(), digest: z.string() });

export class PayloadStorageSchemaError extends Error {}

export function migrationMode(args: string[]): "check" | "apply" {
  if (args.length === 0 || (args.length === 1 && args[0] === "--check"))
    return "check";
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new PayloadStorageSchemaError("Use only --check or --apply.");
}

export function requireProductionR2(environment: {
  vercelEnvironment: string | undefined;
  storageSource: string | undefined;
}) {
  if (
    environment.vercelEnvironment !== "production" ||
    environment.storageSource !== "r2"
  ) {
    throw new PayloadStorageSchemaError(
      "This helper requires VERCEL_ENV=production and PAYLOAD_STORAGE_SOURCE=r2.",
    );
  }
}

async function inspectSchema(sql: postgres.ISql) {
  const tables = z.array(z.object({ relkind: z.string() })).parse(
    await sql`
    SELECT c.relkind FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'media'
  `,
  );
  if (tables.length !== 1 || tables[0]?.relkind !== "r") {
    throw new PayloadStorageSchemaError(
      "Expected the existing public.media table.",
    );
  }
  const columns = z.array(columnSchema).parse(
    await sql`
    SELECT column_name, data_type, is_nullable, character_maximum_length, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media'
  `,
  );
  const missing = legacyColumns.filter(
    (name) => !columns.some((column) => column.column_name === name),
  );
  if (missing.length > 0) {
    throw new PayloadStorageSchemaError(
      `Legacy media schema is missing required columns: ${missing.join(", ")}.`,
    );
  }
  const objectKey = columns.find(
    (column) => column.column_name === "_objectkey",
  );
  if (
    objectKey &&
    (objectKey.data_type !== "character varying" ||
      objectKey.is_nullable !== "YES" ||
      objectKey.character_maximum_length !== null ||
      objectKey.column_default !== null)
  ) {
    throw new PayloadStorageSchemaError(
      "Existing media._objectkey must be nullable, unbounded varchar with no default.",
    );
  }
  return objectKey ? "ready" : "missing";
}

async function mediaStats(sql: postgres.ISql, includeObjectKey: boolean) {
  const rows = z.array(statsSchema).parse(
    await sql`
    SELECT count(*)::text AS count,
      coalesce(md5(string_agg((CASE WHEN ${includeObjectKey} THEN to_jsonb(media)
        ELSE to_jsonb(media) - '_objectkey' END)::text, E'\n' ORDER BY id)), '') AS digest
    FROM public.media
  `,
  );
  const stats = rows[0];
  if (!stats)
    throw new PayloadStorageSchemaError(
      "Could not verify existing media rows.",
    );
  return stats;
}

export async function checkPayloadStorageSchema(sql: postgres.Sql) {
  return sql.begin("read only", async (transaction) => {
    await transaction`SET LOCAL statement_timeout = '30s'`;
    const status = await inspectSchema(transaction);
    const rows = await mediaStats(transaction, status === "ready");
    return { status, rowCount: rows.count };
  });
}

export async function applyPayloadStorageSchema(sql: postgres.Sql) {
  return sql.begin(async (transaction) => {
    await transaction`SET LOCAL lock_timeout = '5s'`;
    await transaction`SET LOCAL statement_timeout = '30s'`;
    await inspectSchema(transaction);
    await transaction`LOCK TABLE public.media IN ACCESS EXCLUSIVE MODE`;
    // Recheck after the lock so a concurrent schema change cannot bypass validation.
    const beforeStatus = await inspectSchema(transaction);
    const before = await mediaStats(transaction, beforeStatus === "ready");
    await transaction`ALTER TABLE public.media ADD COLUMN IF NOT EXISTS "_objectkey" varchar`;
    const status = await inspectSchema(transaction);
    const after = await mediaStats(transaction, beforeStatus === "ready");
    if (
      status !== "ready" ||
      before.count !== after.count ||
      before.digest !== after.digest
    ) {
      throw new PayloadStorageSchemaError(
        "Storage schema verification failed; transaction will roll back.",
      );
    }
    return {
      status,
      addedColumn: beforeStatus === "missing",
      rowCount: after.count,
      legacyRowsPreserved: true,
    };
  });
}

async function main() {
  const mode = migrationMode(process.argv.slice(2));
  requireProductionR2({
    vercelEnvironment: process.env.VERCEL_ENV,
    storageSource: process.env.PAYLOAD_STORAGE_SOURCE,
  });
  const uri = process.env.DATABASE_URI;
  if (!uri) throw new PayloadStorageSchemaError("DATABASE_URI is required.");
  // Explicit verification overrides permissive sslmode values in connection URLs.
  const sql = postgres(uri, {
    ssl: { rejectUnauthorized: true },
    max: 1,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  try {
    const result =
      mode === "apply"
        ? await applyPayloadStorageSchema(sql)
        : await checkPayloadStorageSchema(sql);
    console.log(JSON.stringify({ mode, ...result }));
    if (result.status === "missing") process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        error:
          error instanceof PayloadStorageSchemaError
            ? error.message
            : "Database operation failed.",
        ...(error instanceof postgres.PostgresError
          ? { code: error.code }
          : {}),
      }),
    );
    process.exitCode = 1;
  });
}
