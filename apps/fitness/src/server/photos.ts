import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PhotoUpload } from "@bent/fitness-contracts";
import type { PhotoSummary } from "@bent/fitness-contracts";
import { requireOwner } from "./auth";
import { database } from "./db";
const photoRow = z.object({
  id: z.string(),
  name: z.string(),
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
});
const maxPhotos = 20;
/** A photo upload the store refused. The message is safe to show. */
export class PhotoRuleError extends Error {}

/** The owner's equipment photos, oldest first. */
export async function photoList(owner: string): Promise<PhotoSummary[]> {
  const rows =
    await database()`SELECT id,name,content_type FROM fitness_photos WHERE owner_id=${owner} ORDER BY created_at`;
  return rows.map((r) => {
    const row = photoRow.parse(r);
    return { id: row.id, name: row.name, type: row.content_type };
  });
}

/**
 * Saves a photo whose bytes match its declared type and fit in 2 MB. An ID
 * already saved is left as it is, so a retried upload saves once.
 */
export async function photoSave(owner: string, input: PhotoUpload) {
  const data = PhotoUpload.parse(input);
  const bytes = Buffer.from(data.base64, "base64");
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp =
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP";
  if (
    bytes.length > 2 * 1024 * 1024 ||
    !(data.type === "image/jpeg"
      ? jpeg
      : data.type === "image/png"
        ? png
        : webp)
  )
    throw new PhotoRuleError("Choose a JPEG, PNG or WebP photo under 2 MB.");
  await database().begin(async (sql) => {
    await sql`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
    await sql`SELECT owner_id FROM fitness_accounts WHERE owner_id=${owner} FOR UPDATE`;
    const [existing] =
      await sql`SELECT id FROM fitness_photos WHERE owner_id=${owner} AND id=${data.id}`;
    if (existing) return;
    const [count] =
      await sql`SELECT count(*)::integer AS total FROM fitness_photos WHERE owner_id=${owner}`;
    if (!count || z.number().parse(count.total) >= maxPhotos)
      throw new PhotoRuleError(
        "Keep up to 20 equipment photos. Remove a photo before adding another.",
      );
    await sql`INSERT INTO fitness_photos(owner_id,id,name,content_type,bytes) VALUES(${owner},${data.id},${data.name},${data.type},${bytes})`;
  });
  return { saved: true as const };
}

export async function photoRemove(owner: string, id: string) {
  await database()`DELETE FROM fitness_photos WHERE owner_id=${owner} AND id=${z.uuid().parse(id)}`;
  return { deleted: true as const };
}

/** A photo's bytes as a response that never renders as a document. */
export async function photoResponse(owner: string, id: string) {
  const [row] =
    await database()`SELECT content_type,bytes FROM fitness_photos WHERE owner_id=${owner} AND id=${id}`;
  if (!row)
    return new Response("Photo not found.", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  return new Response(Buffer.from(z.instanceof(Uint8Array).parse(row.bytes)), {
    headers: {
      "Content-Type": photoRow.shape.content_type.parse(row.content_type),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export const listPhotos = createServerFn({ method: "GET" }).handler(async () =>
  (await photoList(await requireOwner())).map(({ id, name, type }) => ({
    id,
    name,
    content_type: type,
  })),
);
export const uploadPhoto = createServerFn({ method: "POST" })
  .validator(PhotoUpload)
  .handler(async ({ data }) => photoSave(await requireOwner(), data));
export const deletePhoto = createServerFn({ method: "POST" })
  .validator(z.string().uuid())
  .handler(async ({ data }) => photoRemove(await requireOwner(), data));
