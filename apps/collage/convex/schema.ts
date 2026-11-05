import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  collages: defineTable({
    legacyId: v.number(),
    userId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    collageJson: v.string(),
    imageUrl: v.string(),
    renderObjectKey: v.optional(v.string()),
    public: v.boolean(),
    nsfw: v.boolean(),
    version: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index("by_legacy_id", ["legacyId"])
    .index("by_user_created_at", ["userId", "createdAt"])
    .index("by_user_public_created_at", ["userId", "public", "createdAt"])
    .index("by_public_legacy_id", ["public", "legacyId"])
    .index("by_public_created_at", ["public", "createdAt"]),

  userPreferences: defineTable({
    userId: v.string(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    showNsfw: v.boolean(),
    tutorialViewed: v.boolean(),
    version: v.number(),
  }).index("by_user_id", ["userId"]),

  idCounters: defineTable({
    name: v.string(),
    nextValue: v.number(),
  }).index("by_name", ["name"]),

  migrationObjects: defineTable({
    sourceProvider: v.literal("uploadthing"),
    sourceKey: v.string(),
    sourceUrl: v.optional(v.string()),
    destinationKey: v.string(),
    destinationUrl: v.string(),
    category: v.union(
      v.literal("collage"),
      v.literal("payload"),
      v.literal("unknown"),
    ),
    size: v.number(),
    contentType: v.optional(v.string()),
    sha256: v.string(),
    copiedAt: v.number(),
    verifiedAt: v.number(),
  })
    .index("by_source_key", ["sourceKey"])
    .index("by_destination_key", ["destinationKey"]),
});
