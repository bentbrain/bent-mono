import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@/server/api/trpc";
import { userPreferences } from "@/server/db/schema";
import { clerkClient } from "@clerk/nextjs/server";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/env";
import { authenticatedConvexClient } from "@/server/convex/client";
import { api as convexApi } from "../../../../convex/_generated/api";
import { requireMigrationWritesEnabled } from "@/server/migration/maintenance";

function requireMatchingUser(
  authenticatedUserId: string,
  requestedUserId: string,
) {
  if (authenticatedUserId !== requestedUserId) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

export const userRouter = createTRPCRouter({
  getById: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      if (!input.userId) return null;
      try {
        const clerk = await clerkClient();
        const user = await clerk.users.getUser(input.userId);
        return user
          ? {
              id: user.id,
              firstName: user.firstName,
              lastName: user.lastName,
              imageUrl: user.imageUrl,
            }
          : null;
      } catch (error) {
        console.error("Error getting user information", error);
        return null;
      }
    }),

  getPreferences: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ ctx, input }) => {
      const { userId } = input;
      requireMatchingUser(ctx.userId, userId);
      if (env.DB_READ_SOURCE === "convex") {
        const client = await authenticatedConvexClient(ctx.getConvexToken);
        const preferences = await client.query(
          convexApi.userPreferences.getMine,
          {},
        );
        return preferences
          ? {
              showNsfw: preferences.showNsfw,
              tutorialViewed: preferences.tutorialViewed,
            }
          : null;
      }

      const preferences = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.id, userId),
        columns: {
          showNsfw: true,
          tutorialViewed: true,
        },
      });
      return preferences;
    }),

  createPreferences: protectedProcedure
    .input(
      z.object({
        userId: z.string(),
        showNsfw: z.boolean().optional(),
        tutorialViewed: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireMigrationWritesEnabled();
      const { userId, showNsfw, tutorialViewed } = input;
      requireMatchingUser(ctx.userId, userId);
      if (env.DB_WRITE_SOURCE === "convex") {
        const client = await authenticatedConvexClient(ctx.getConvexToken);
        const preferences = await client.mutation(
          convexApi.userPreferences.upsertMine,
          { showNsfw, tutorialViewed },
        );
        return {
          showNsfw: preferences.showNsfw,
          tutorialViewed: preferences.tutorialViewed,
        };
      }

      const [newPreferences] = await ctx.db
        .insert(userPreferences)
        .values({
          id: userId,
          showNsfw,
          tutorialViewed,
        })
        .returning({
          showNsfw: userPreferences.showNsfw,
          tutorialViewed: userPreferences.tutorialViewed,
        });
      return newPreferences;
    }),

  updatePreferences: protectedProcedure
    .input(
      z.object({
        userId: z.string(),
        showNsfw: z.boolean().optional(),
        tutorialViewed: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireMigrationWritesEnabled();
      const { userId, showNsfw, tutorialViewed } = input;
      requireMatchingUser(ctx.userId, userId);
      if (env.DB_WRITE_SOURCE === "convex") {
        const client = await authenticatedConvexClient(ctx.getConvexToken);
        const preferences = await client.mutation(
          convexApi.userPreferences.upsertMine,
          { showNsfw, tutorialViewed },
        );
        return {
          showNsfw: preferences.showNsfw,
          tutorialViewed: preferences.tutorialViewed,
        };
      }

      const preferences = await ctx.db.query.userPreferences.findFirst({
        where: eq(userPreferences.id, userId),
      });

      if (!preferences) {
        // Create new preferences if they don't exist
        const [newPreferences] = await ctx.db
          .insert(userPreferences)
          .values({
            id: userId,
            showNsfw,
            tutorialViewed,
          })
          .returning({
            showNsfw: userPreferences.showNsfw,
            tutorialViewed: userPreferences.tutorialViewed,
          });
        return newPreferences;
      }

      // Update existing preferences
      const [updatedPreferences] = await ctx.db
        .update(userPreferences)
        .set({
          showNsfw,
          tutorialViewed,
        })
        .where(eq(userPreferences.id, userId))
        .returning({
          showNsfw: userPreferences.showNsfw,
          tutorialViewed: userPreferences.tutorialViewed,
        });
      return updatedPreferences;
    }),
});
