import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./auth";

export const getMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return ctx.db
      .query("userPreferences")
      .withIndex("by_user_id", (q) => q.eq("userId", userId))
      .unique();
  },
});

export const upsertMine = mutation({
  args: {
    showNsfw: v.optional(v.boolean()),
    tutorialViewed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const preferences = await ctx.db
      .query("userPreferences")
      .withIndex("by_user_id", (q) => q.eq("userId", userId))
      .unique();
    const now = Date.now();

    if (!preferences) {
      const value = {
        userId,
        createdAt: now,
        updatedAt: now,
        showNsfw: args.showNsfw ?? false,
        tutorialViewed: args.tutorialViewed ?? false,
        version: 1,
      };
      await ctx.db.insert("userPreferences", value);
      return value;
    }

    const value = {
      showNsfw: args.showNsfw ?? preferences.showNsfw,
      tutorialViewed: args.tutorialViewed ?? preferences.tutorialViewed,
      updatedAt: now,
      version: preferences.version + 1,
    };
    await ctx.db.patch(preferences._id, value);
    return { ...preferences, ...value };
  },
});
