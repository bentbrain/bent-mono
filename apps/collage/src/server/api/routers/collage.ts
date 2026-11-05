import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@/server/api/trpc";
import { collages } from "@/server/db/schema";
import {
  getCachedPublicFeedPage,
  invalidatePublicFeedCache,
} from "@/server/public-feed";
import { checkRole } from "@/utils/roles";
import { jsonValueSchema } from "@/types/json";
import { env } from "@/env";
import {
  createCollageRenderUpload,
  verifyCollageRenderUpload,
} from "@/server/storage/r2";
import {
  authenticatedConvexClient,
  publicConvexClient,
} from "@/server/convex/client";
import {
  convexCollage,
  convexCollageSummary,
} from "@/server/convex/collage-mapper";
import { api as convexApi } from "../../../../convex/_generated/api";
import { requireMigrationWritesEnabled } from "@/server/migration/maintenance";
import { getBuilderAssets } from "@/server/builder-assets";
import { and, eq } from "@payloadcms/db-postgres/drizzle";
import { revalidatePath } from "next/cache";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

function requireMatchingUser(
  authenticatedUserId: string,
  requestedUserId: string,
) {
  if (authenticatedUserId !== requestedUserId) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
}

function uploadthingTarget(): { provider: "uploadthing" } {
  return { provider: "uploadthing" };
}

export const collageRouter = createTRPCRouter({
  getBuilderAssets: protectedProcedure.query(() => getBuilderAssets()),

  prepareRenderUpload: protectedProcedure.mutation(async () => {
    requireMigrationWritesEnabled();
    if (env.STORAGE_WRITE_SOURCE === "uploadthing") {
      return uploadthingTarget();
    }
    return createCollageRenderUpload();
  }),

  create: protectedProcedure
    .input(
      z.object({
        userId: z.string(),
        collageJson: jsonValueSchema,
        imageUrl: z.string().url(),
        nsfw: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireMigrationWritesEnabled();
      requireMatchingUser(ctx.userId, input.userId);
      if (env.STORAGE_WRITE_SOURCE === "r2") {
        await verifyCollageRenderUpload(input.imageUrl);
      }
      if (env.DB_WRITE_SOURCE === "convex") {
        const client = await authenticatedConvexClient(ctx.getConvexToken);
        const collage = await client.mutation(convexApi.collages.create, {
          collageJson: JSON.stringify(input.collageJson),
          imageUrl: input.imageUrl,
          nsfw: input.nsfw ?? false,
        });
        invalidatePublicFeedCache();
        revalidatePath(`/${input.userId}`);
        return collage;
      }

      const [collage] = await ctx.db
        .insert(collages)
        .values({
          userId: input.userId,
          collageJson: input.collageJson,
          imageUrl: input.imageUrl,
          nsfw: input.nsfw,
        })
        .returning({
          id: collages.id,
          userId: collages.userId,
          imageUrl: collages.imageUrl,
        });

      if (!collage) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The collage could not be created.",
        });
      }

      invalidatePublicFeedCache();
      revalidatePath(`/${input.userId}`);

      return collage;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        userId: z.string(),
        collageJson: jsonValueSchema.optional(),
        imageUrl: z.string().url().optional(),
        public: z.boolean().optional(),
        nsfw: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireMigrationWritesEnabled();
      requireMatchingUser(ctx.userId, input.userId);
      if (env.STORAGE_WRITE_SOURCE === "r2" && input.imageUrl) {
        await verifyCollageRenderUpload(input.imageUrl);
      }
      if (env.DB_WRITE_SOURCE === "convex") {
        const client = await authenticatedConvexClient(ctx.getConvexToken);
        await client.mutation(convexApi.collages.update, {
          legacyId: input.id,
          collageJson:
            input.collageJson === undefined
              ? undefined
              : JSON.stringify(input.collageJson),
          imageUrl: input.imageUrl,
          public: input.public,
          nsfw: input.nsfw,
        });
        invalidatePublicFeedCache();
        revalidatePath(`/${input.userId}`);
        revalidatePath(`/${input.userId}/collage/${input.id}`);
        return;
      }

      await ctx.db
        .update(collages)
        .set({
          collageJson: input.collageJson,
          imageUrl: input.imageUrl,
          public: input.public,
          nsfw: input.nsfw,
        })
        .where(
          and(eq(collages.id, input.id), eq(collages.userId, input.userId)),
        );

      invalidatePublicFeedCache();
      revalidatePath(`/${input.userId}`);
      revalidatePath(`/${input.userId}/collage/${input.id}`);
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      requireMigrationWritesEnabled();
      requireMatchingUser(ctx.userId, input.userId);
      if (env.DB_WRITE_SOURCE === "convex") {
        const client = await authenticatedConvexClient(ctx.getConvexToken);
        await client.mutation(convexApi.collages.remove, {
          legacyId: input.id,
        });
        invalidatePublicFeedCache();
        revalidatePath(`/${input.userId}`);
        return;
      }

      await ctx.db
        .delete(collages)
        .where(
          and(eq(collages.id, input.id), eq(collages.userId, input.userId)),
        );

      invalidatePublicFeedCache();
      revalidatePath(`/${input.userId}`);
    }),

  getLatest: publicProcedure.query(async ({ ctx }) => {
    if (env.DB_READ_SOURCE === "convex") {
      const collage = await publicConvexClient().query(
        convexApi.collages.getLatestPublic,
        {},
      );
      return collage ? convexCollage(collage) : null;
    }
    const collage = await ctx.db.query.collages.findFirst({
      where: eq(collages.public, true),
      orderBy: (collages, { desc }) => [desc(collages.createdAt)],
    });

    return collage ?? null;
  }),

  getAllPublic: publicProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).optional().default(10),
        cursor: z.number().optional(), // ID of the last item
      }),
    )
    .query(({ input }) => getCachedPublicFeedPage(input)),

  getAll: protectedProcedure
    .input(
      z.object({ limit: z.number().optional(), offset: z.number().optional() }),
    )
    .query(async ({ ctx, input }) => {
      if (!(await checkRole("admin"))) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const { limit = 30, offset = 0 } = input;
      if (env.DB_READ_SOURCE === "convex") {
        const client = await authenticatedConvexClient(ctx.getConvexToken);
        const convexCollages = await client.query(
          convexApi.collages.getAllForAdmin,
          { limit, offset },
        );
        return convexCollages.map(convexCollageSummary);
      }
      const collagesArray = await ctx.db.query.collages.findMany({
        orderBy: (collages, { desc }) => [desc(collages.createdAt)],
        columns: {
          id: true,
          userId: true,
          imageUrl: true,
          createdAt: true,
          nsfw: true,
          public: true,
        },
        limit,
        offset,
      });
      return collagesArray;
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      if (env.DB_READ_SOURCE === "convex") {
        const client = await authenticatedConvexClient(ctx.getConvexToken);
        const collage = await client.query(convexApi.collages.getByLegacyId, {
          legacyId: input.id,
        });
        return collage ? convexCollage(collage) : null;
      }
      const collage = await ctx.db.query.collages.findFirst({
        where: eq(collages.id, input.id),
      });

      if (!collage) {
        return null;
      }

      requireMatchingUser(ctx.userId, collage.userId ?? "");

      return collage;
    }),

  getAllByUserId: publicProcedure
    .input(
      z.object({
        userId: z.string(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { limit = 30, offset = 0 } = input;
      if (env.DB_READ_SOURCE === "convex") {
        const client = ctx.userId
          ? await authenticatedConvexClient(ctx.getConvexToken)
          : publicConvexClient();
        const convexCollages = await client.query(
          convexApi.collages.getByUserOffset,
          { userId: input.userId, limit, offset },
        );
        return convexCollages.map(convexCollageSummary);
      }
      const collageArray = await ctx.db.query.collages.findMany({
        where:
          ctx.userId === input.userId
            ? eq(collages.userId, input.userId)
            : and(eq(collages.userId, input.userId), eq(collages.public, true)),
        orderBy: (collages, { desc }) => [desc(collages.createdAt)],
        columns: {
          id: true,
          userId: true,
          imageUrl: true,
          createdAt: true,
          nsfw: true,
          public: true,
        },
        limit,
        offset,
      });
      return collageArray;
    }),
});
