import { createHash } from "node:crypto";
import { database } from "./db";
import {
  mutationSchema,
  recordSchema,
  resultSchema,
  settingsId,
} from "../domain";
import type { Mutation, RecordEntry, SaveResult } from "../domain";
import { z } from "zod";
const rowSchema = z.object({
  id: z.string(),
  revision: z.number(),
  data: z.unknown(),
  updated_at: z.coerce.date(),
});
function entry(row: unknown) {
  const r = rowSchema.parse(row);
  return recordSchema.parse({ ...r, updatedAt: r.updated_at.toISOString() });
}
export async function loadRecords(owner: string): Promise<RecordEntry[]> {
  const rows =
    await database()`SELECT id, revision, data, updated_at FROM fitness_records WHERE owner_id=${owner} AND deleted=false ORDER BY updated_at DESC`;
  return rows.map(entry);
}
export async function saveRecord(
  owner: string,
  input: Mutation,
): Promise<SaveResult> {
  const request = mutationSchema.parse(input);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  return database().begin(async (sql) => {
    await sql`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
    // All account writes share this lock. Receipts and record updates commit together.
    await sql`SELECT owner_id FROM fitness_accounts WHERE owner_id=${owner} FOR UPDATE`;
    const [receipt] =
      await sql`SELECT fingerprint, result FROM fitness_operations WHERE owner_id=${owner} AND id=${request.operationId}`;
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new Error(
          "This save request ID was already used. Reload before retrying.",
        );
      return resultSchema.parse(receipt.result);
    }
    const [row] =
      await sql`SELECT id,revision,data,updated_at,deleted FROM fitness_records WHERE owner_id=${owner} AND id=${request.id}`;
    const current = row && !row.deleted ? entry(row) : null;
    const revision = row ? z.number().int().parse(row.revision) : 0;
    if (revision !== request.revision) return { status: "conflict", current };
    if (request.data?.kind === "weight") {
      const [sameDay] =
        await sql`SELECT id,revision,data,updated_at FROM fitness_records WHERE owner_id=${owner} AND deleted=false AND data->>'kind'='weight' AND data->>'date'=${request.data.date} AND id<>${request.id}`;
      if (sameDay) return { status: "conflict", current: entry(sameDay) };
    }
    if (request.data?.kind === "workout" && !request.data.finishedAt) {
      const [active] =
        await sql`SELECT id,revision,data,updated_at FROM fitness_records WHERE owner_id=${owner} AND deleted=false AND data->>'kind'='workout' AND data->>'finishedAt' IS NULL AND id<>${request.id}`;
      if (active) return { status: "conflict", current: entry(active) };
    }
    if (request.data?.kind === "settings" && request.id !== settingsId)
      throw new Error("Invalid settings record.");
    if (request.id === settingsId && request.data?.kind !== "settings")
      throw new Error("Settings must remain available.");
    if (current && request.data && current.data.kind !== request.data.kind)
      throw new Error("Record type cannot change.");
    if (
      current?.data.kind === "workout" &&
      current.data.finishedAt &&
      request.data
    )
      throw new Error("Completed workouts keep their original results.");
    const nextRevision = revision + 1;
    const data = request.data;
    const [saved] =
      await sql`INSERT INTO fitness_records(owner_id,id,revision,data,deleted) VALUES(${owner},${request.id},${nextRevision},${sql.json(data)},${data === null}) ON CONFLICT(owner_id,id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,deleted=EXCLUDED.deleted,updated_at=now() RETURNING id,revision,data,updated_at`;
    const result: SaveResult = {
      status: "saved",
      record: data ? entry(saved) : null,
    };
    await sql`INSERT INTO fitness_operations(owner_id,id,fingerprint,result) VALUES(${owner},${request.operationId},${fingerprint},${sql.json(result)})`;
    return result;
  });
}
