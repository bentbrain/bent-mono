import "server-only";

import { jsonValueSchema } from "@/types/json";
import type { Doc } from "../../../convex/_generated/dataModel";

export function convexCollageSummary(collage: Doc<"collages">) {
  return {
    id: collage.legacyId,
    userId: collage.userId ?? null,
    imageUrl: collage.imageUrl,
    createdAt: new Date(collage.createdAt),
    nsfw: collage.nsfw,
    public: collage.public,
  };
}

export function convexCollage(collage: Doc<"collages">) {
  return {
    ...convexCollageSummary(collage),
    updatedAt:
      collage.updatedAt === undefined ? null : new Date(collage.updatedAt),
    collageJson: jsonValueSchema.parse(JSON.parse(collage.collageJson)),
  };
}
