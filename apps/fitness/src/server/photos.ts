import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOwner } from "./auth";
import { database } from "./db";
const photoInput = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    base64: z
      .string()
      .max(2796204)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
const photoRow = z.object({
  id: z.string(),
  name: z.string(),
  content_type: z.string(),
});
export const listPhotos = createServerFn({ method: "GET" }).handler(
  async () => {
    const owner = await requireOwner();
    const rows =
      await database()`SELECT id,name,content_type FROM fitness_photos WHERE owner_id=${owner} ORDER BY created_at`;
    return rows.map((r) => photoRow.parse(r));
  },
);
export const uploadPhoto = createServerFn({ method: "POST" })
  .validator(photoInput)
  .handler(async ({ data }) => {
    const owner = await requireOwner();
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
      throw new Error("Choose a JPEG, PNG or WebP photo under 2 MB.");
    await database().begin(async (sql) => {
      await sql`INSERT INTO fitness_accounts(owner_id) VALUES(${owner}) ON CONFLICT DO NOTHING`;
      await sql`SELECT owner_id FROM fitness_accounts WHERE owner_id=${owner} FOR UPDATE`;
      const [existing] =
        await sql`SELECT id FROM fitness_photos WHERE owner_id=${owner} AND id=${data.id}`;
      if (existing) return;
      const [count] =
        await sql`SELECT count(*)::integer AS total FROM fitness_photos WHERE owner_id=${owner}`;
      if (!count || z.number().parse(count.total) >= 20)
        throw new Error(
          "Keep up to 20 equipment photos. Remove a photo before adding another.",
        );
      await sql`INSERT INTO fitness_photos(owner_id,id,name,content_type,bytes) VALUES(${owner},${data.id},${data.name},${data.type},${bytes})`;
    });
    return { saved: true };
  });
export const deletePhoto = createServerFn({ method: "POST" })
  .validator(z.string().uuid())
  .handler(async ({ data }) => {
    const owner = await requireOwner();
    await database()`DELETE FROM fitness_photos WHERE owner_id=${owner} AND id=${data}`;
    return { deleted: true };
  });
