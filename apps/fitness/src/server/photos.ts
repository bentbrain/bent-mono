import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PhotoUpload } from "@bent/fitness-contracts";
import { requireOwner } from "./auth";
import { photoList, photoRemove, photoSave } from "./photo-store";

// The Settings screen imports this module, so it holds only server functions.
// Database access stays in photo-store, which the browser bundle never loads.
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
