import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireAdmin, requireUserId } from "./auth";

const activeCollage = (deletedAt: number | undefined) =>
  deletedAt === undefined;

export const create = mutation({
  args: {
    collageJson: v.string(),
    imageUrl: v.string(),
    renderObjectKey: v.optional(v.string()),
    nsfw: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const counter = await ctx.db
      .query("idCounters")
      .withIndex("by_name", (q) => q.eq("name", "collages"))
      .unique();

    let legacyId: number;
    if (counter) {
      legacyId = counter.nextValue;
      await ctx.db.patch(counter._id, { nextValue: legacyId + 1 });
    } else {
      const latest = await ctx.db
        .query("collages")
        .withIndex("by_legacy_id")
        .order("desc")
        .first();
      legacyId = (latest?.legacyId ?? 0) + 1;
      await ctx.db.insert("idCounters", {
        name: "collages",
        nextValue: legacyId + 1,
      });
    }

    const now = Date.now();
    await ctx.db.insert("collages", {
      legacyId,
      userId,
      createdAt: now,
      updatedAt: now,
      collageJson: args.collageJson,
      imageUrl: args.imageUrl,
      renderObjectKey: args.renderObjectKey,
      public: false,
      nsfw: args.nsfw,
      version: 1,
    });

    return { id: legacyId, userId, imageUrl: args.imageUrl };
  },
});

export const update = mutation({
  args: {
    legacyId: v.number(),
    collageJson: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    renderObjectKey: v.optional(v.string()),
    public: v.optional(v.boolean()),
    nsfw: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const collage = await ctx.db
      .query("collages")
      .withIndex("by_legacy_id", (q) => q.eq("legacyId", args.legacyId))
      .unique();

    if (collage?.userId !== userId || !activeCollage(collage.deletedAt)) {
      throw new Error("Collage not found");
    }

    await ctx.db.patch(collage._id, {
      collageJson: args.collageJson ?? collage.collageJson,
      imageUrl: args.imageUrl ?? collage.imageUrl,
      renderObjectKey: args.renderObjectKey ?? collage.renderObjectKey,
      public: args.public ?? collage.public,
      nsfw: args.nsfw ?? collage.nsfw,
      updatedAt: Date.now(),
      version: collage.version + 1,
    });
  },
});

export const remove = mutation({
  args: { legacyId: v.number() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const collage = await ctx.db
      .query("collages")
      .withIndex("by_legacy_id", (q) => q.eq("legacyId", args.legacyId))
      .unique();

    if (collage?.userId !== userId || !activeCollage(collage.deletedAt)) {
      throw new Error("Collage not found");
    }

    await ctx.db.patch(collage._id, {
      deletedAt: Date.now(),
      updatedAt: Date.now(),
      version: collage.version + 1,
    });
  },
});

export const getByLegacyId = query({
  args: { legacyId: v.number() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const collage = await ctx.db
      .query("collages")
      .withIndex("by_legacy_id", (q) => q.eq("legacyId", args.legacyId))
      .unique();

    if (collage?.userId !== userId || !activeCollage(collage.deletedAt)) {
      return null;
    }
    return collage;
  },
});

export const getLatestPublic = query({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.db
      .query("collages")
      .withIndex("by_public_created_at", (q) => q.eq("public", true))
      .order("desc")
      .take(20);
    return (
      candidates.find((collage) => activeCollage(collage.deletedAt)) ?? null
    );
  },
});

export const getPublicPage = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("collages")
      .withIndex("by_public_legacy_id", (q) => q.eq("public", true))
      .filter((q) => q.eq(q.field("deletedAt"), undefined))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getPublicByLegacyCursor = query({
  args: {
    limit: v.number(),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
      throw new Error("Invalid page limit");
    }
    const collages = await ctx.db
      .query("collages")
      .withIndex("by_public_legacy_id", (q) => {
        const publicCollages = q.eq("public", true);
        return args.cursor === undefined
          ? publicCollages
          : publicCollages.lt("legacyId", args.cursor);
      })
      .filter((q) => q.eq(q.field("deletedAt"), undefined))
      .order("desc")
      .take(args.limit + 1);
    const hasMore = collages.length > args.limit;
    const page = hasMore ? collages.slice(0, args.limit) : collages;
    return {
      items: page,
      nextCursor: hasMore ? page.at(-1)?.legacyId : undefined,
    };
  },
});

export const getByUser = query({
  args: {
    userId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const isOwner = identity?.subject === args.userId;
    const baseQuery = isOwner
      ? ctx.db
          .query("collages")
          .withIndex("by_user_created_at", (q) => q.eq("userId", args.userId))
      : ctx.db
          .query("collages")
          .withIndex("by_user_public_created_at", (q) =>
            q.eq("userId", args.userId).eq("public", true),
          );
    return baseQuery
      .filter((q) => q.eq(q.field("deletedAt"), undefined))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getByUserOffset = query({
  args: {
    userId: v.string(),
    limit: v.number(),
    offset: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 100 ||
      !Number.isInteger(args.offset) ||
      args.offset < 0
    ) {
      throw new Error("Invalid pagination arguments");
    }
    const identity = await ctx.auth.getUserIdentity();
    const isOwner = identity?.subject === args.userId;
    const baseQuery = isOwner
      ? ctx.db
          .query("collages")
          .withIndex("by_user_created_at", (q) => q.eq("userId", args.userId))
      : ctx.db
          .query("collages")
          .withIndex("by_user_public_created_at", (q) =>
            q.eq("userId", args.userId).eq("public", true),
          );
    const collages = await baseQuery
      .filter((q) => q.eq(q.field("deletedAt"), undefined))
      .order("desc")
      .take(args.offset + args.limit);
    return collages.slice(args.offset);
  },
});

export const getAllForAdmin = query({
  args: {
    limit: v.number(),
    offset: v.number(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 100 ||
      !Number.isInteger(args.offset) ||
      args.offset < 0
    ) {
      throw new Error("Invalid pagination arguments");
    }
    const collages = await ctx.db
      .query("collages")
      .withIndex("by_legacy_id")
      .filter((q) => q.eq(q.field("deletedAt"), undefined))
      .order("desc")
      .take(args.offset + args.limit);
    return collages.slice(args.offset);
  },
});
