/**
 * The Fitness app API under `/api/app`, used by the bent Fitness iPhone app
 * with OAuth access tokens issued to its own client.
 */
import { z } from "zod";
import { recordSchema } from "./domain";

export const photoTypes = ["image/jpeg", "image/png", "image/webp"] as const;

/** `POST /api/app/photos`: a JPEG, PNG or WebP photo of up to 2 MB. */
export const PhotoUpload = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(160),
    type: z.enum(photoTypes),
    base64: z
      .string()
      .max(2796204)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
export type PhotoUpload = z.infer<typeof PhotoUpload>;

export const PhotoSummary = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(photoTypes),
});
export type PhotoSummary = z.infer<typeof PhotoSummary>;

/** `GET /api/app/photos`. */
export const PhotoList = z.object({ photos: z.array(PhotoSummary) });

/** `GET /api/app/records`: every record the account holds. */
export const AppRecords = z.object({
  owner: z.string(),
  records: z.array(recordSchema),
});
export type AppRecords = z.infer<typeof AppRecords>;
