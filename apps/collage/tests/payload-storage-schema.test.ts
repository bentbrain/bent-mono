import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { z } from "zod";
import { getTableColumns } from "@payloadcms/db-postgres/drizzle";
import { PgTable } from "@payloadcms/db-postgres/drizzle/pg-core";
import { getPayload } from "payload";
import {
  applyPayloadStorageSchema,
  checkPayloadStorageSchema,
  migrationMode,
  requireProductionR2,
  PayloadStorageSchemaError,
} from "../scripts/migration/payload-storage-schema";

await test("CLI defaults to read-only and rejects unintended targets/flags", () => {
  assert.equal(migrationMode([]), "check");
  assert.equal(migrationMode(["--check"]), "check");
  assert.equal(migrationMode(["--apply"]), "apply");
  assert.throws(
    () => migrationMode(["--apply", "--check"]),
    PayloadStorageSchemaError,
  );
  assert.throws(() => migrationMode(["--drop"]), PayloadStorageSchemaError);
  for (const vercelEnvironment of [undefined, "preview", "development"]) {
    assert.throws(
      () => requireProductionR2({ vercelEnvironment, storageSource: "r2" }),
      PayloadStorageSchemaError,
    );
  }
  assert.throws(
    () =>
      requireProductionR2({
        vercelEnvironment: "production",
        storageSource: "uploadthing",
      }),
    PayloadStorageSchemaError,
  );
  requireProductionR2({ vercelEnvironment: "production", storageSource: "r2" });
});

await test("real PostgreSQL migration restores current Payload reads without changing legacy rows", async () => {
  const uri = process.env.PAYLOAD_MIGRATION_TEST_DATABASE_URI;
  assert.ok(uri, "The isolated PostgreSQL test database is required.");
  const target = new URL(uri);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
  assert.equal(target.pathname, "/payload_migration_test");
  const sql = postgres(uri, { ssl: false, max: 1, onnotice: () => undefined });
  try {
    await sql`CREATE TABLE public.media (
      id serial PRIMARY KEY, alt varchar NOT NULL, is_nsfw boolean DEFAULT false,
      prefix varchar DEFAULT 'payload/media', updated_at timestamptz, created_at timestamptz,
      url varchar, thumbnail_u_r_l varchar, filename varchar UNIQUE, mime_type varchar,
      filesize numeric, width numeric, height numeric, focal_x numeric, focal_y numeric
    )`;
    await sql`INSERT INTO public.media (alt, prefix, filename, url, mime_type) VALUES
      ('legacy sticker', 'payload/media', 'sticker.png', 'https://media.example/payload/media/sticker.png', 'image/png'),
      ('legacy background', 'payload/media', 'background.jpg', 'https://media.example/payload/media/background.jpg', 'image/jpeg')`;
    const before = await sql`SELECT * FROM public.media ORDER BY id`;
    assert.deepEqual(await checkPayloadStorageSchema(sql), {
      status: "missing",
      rowCount: "2",
    });

    // Build the real installed SDK's media schema without connecting Payload to a database.
    // R2 fixture values come from the dedicated CI step, never a production environment file.
    const { default: sourceConfig } = await import("../src/payload.config");
    const config = await sourceConfig;
    const payload = await getPayload({
      config: {
        ...config,
        typescript: { ...config.typescript, autoGenerate: false },
      },
      disableDBConnect: true,
      disableOnInit: true,
    });
    try {
      const media: unknown = payload.db.tables.media;
      assert.ok(media instanceof PgTable);
      const columns = Object.values(
        z.record(z.string(), z.object({ name: z.string() })).parse(getTableColumns(media)),
      );
      assert.ok(columns.some((column) => column.name === "_objectkey"));
      const names = columns.map((column) => column.name);
      await assert.rejects(
        sql`SELECT ${sql(names)} FROM public.media ORDER BY id`,
        (error: unknown) =>
          error instanceof postgres.PostgresError && error.code === "42703",
      );
      // A database-side DDL side effect must abort both the column addition and row changes.
      await sql`CREATE FUNCTION migration_test_side_effect() RETURNS event_trigger
        LANGUAGE plpgsql AS $$ BEGIN
          UPDATE public.media SET url = 'https://unexpected.example/changed' WHERE id = 1;
        END; $$`;
      await sql`CREATE EVENT TRIGGER migration_test_side_effect ON ddl_command_end
        WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION migration_test_side_effect()`;
      await assert.rejects(
        applyPayloadStorageSchema(sql),
        PayloadStorageSchemaError,
      );
      assert.deepEqual(await checkPayloadStorageSchema(sql), {
        status: "missing",
        rowCount: "2",
      });
      assert.deepEqual(
        [...(await sql`SELECT * FROM public.media ORDER BY id`)],
        [...before],
      );
      await sql`DROP EVENT TRIGGER migration_test_side_effect`;
      await sql`DROP FUNCTION migration_test_side_effect()`;
      assert.deepEqual(await applyPayloadStorageSchema(sql), {
        status: "ready",
        addedColumn: true,
        rowCount: "2",
        legacyRowsPreserved: true,
      });
      assert.deepEqual(await applyPayloadStorageSchema(sql), {
        status: "ready",
        addedColumn: false,
        rowCount: "2",
        legacyRowsPreserved: true,
      });
      assert.deepEqual(await checkPayloadStorageSchema(sql), {
        status: "ready",
        rowCount: "2",
      });
      const currentRows =
        await sql`SELECT ${sql(names)} FROM public.media ORDER BY id`;
      assert.equal(currentRows.length, 2);
      assert.ok(currentRows.every((row) => row._objectkey === null));
      const after =
        await sql`SELECT ${sql(Object.keys(before[0] ?? {}))} FROM public.media ORDER BY id`;
      assert.deepEqual([...after], [...before]);

      // Invalid existing column definitions fail closed and do not get silently replaced.
      await sql`ALTER TABLE public.media ALTER COLUMN _objectkey SET DEFAULT 'unexpected'`;
      await assert.rejects(
        applyPayloadStorageSchema(sql),
        PayloadStorageSchemaError,
      );
      assert.equal(
        (await sql`SELECT count(*)::text AS count FROM public.media`)[0]?.count,
        "2",
      );
    } finally {
      await payload.destroy();
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
});
