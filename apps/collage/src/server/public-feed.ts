import "server-only";

import { getClerkBackendClient } from "@/server/clerk-backend";
import { env } from "@/env";
import { publicConvexClient } from "@/server/convex/client";
import { convexCollageSummary } from "@/server/convex/collage-mapper";
import { getDb } from "@/server/db";
import { collages } from "@/server/db/schema";
import { and, eq, lt } from "@payloadcms/db-postgres/drizzle";
import { cacheLife, cacheTag, revalidateTag } from "next/cache";
import { api as convexApi } from "../../convex/_generated/api";

const PUBLIC_FEED_CACHE_TAG = "public-collage-feed";

type PublicFeedPageInput = {
  limit: number;
  cursor?: number;
};

export async function getCachedPublicFeedPage({
  limit,
  cursor,
}: PublicFeedPageInput) {
  "use cache";

  cacheLife({
    stale: 60,
    revalidate: 300,
    expire: 3600,
  });
  cacheTag(PUBLIC_FEED_CACHE_TAG);

  let nextCursor: number | undefined;
  let collagesArray;
  if (env.DB_READ_SOURCE === "convex") {
    const page = await publicConvexClient().query(
      convexApi.collages.getPublicByLegacyCursor,
      { limit, cursor },
    );
    collagesArray = page.items.map(convexCollageSummary);
    nextCursor = page.nextCursor;
  } else {
    collagesArray = await getDb().query.collages.findMany({
      where: cursor
        ? and(eq(collages.public, true), lt(collages.id, cursor))
        : eq(collages.public, true),
      orderBy: (collages, { desc }) => [desc(collages.id)],
      columns: {
        id: true,
        userId: true,
        imageUrl: true,
        createdAt: true,
        nsfw: true,
        public: true,
      },
      limit: limit + 1,
    });
    if (collagesArray.length > limit) {
      const nextItem = collagesArray.pop();
      nextCursor = nextItem?.id;
    }
  }

  const userIds = [
    ...new Set(
      collagesArray.flatMap((collage) =>
        collage.userId ? [collage.userId] : [],
      ),
    ),
  ];

  let usersById = new Map<
    string,
    {
      id: string;
      firstName: string | null;
      lastName: string | null;
      imageUrl: string;
    }
  >();

  if (userIds.length > 0) {
    try {
      const clerk = getClerkBackendClient();
      const users = await clerk.users.getUserList({
        userId: userIds,
        limit: userIds.length,
      });
      usersById = new Map(
        users.data.map((user) => [
          user.id,
          {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            imageUrl: user.imageUrl,
          },
        ]),
      );
    } catch (error) {
      console.error("Error getting collage user information", error);
    }
  }

  return {
    items: collagesArray.map((collage) => ({
      ...collage,
      user: collage.userId ? (usersById.get(collage.userId) ?? null) : null,
    })),
    nextCursor,
  };
}

export function invalidatePublicFeedCache() {
  revalidateTag(PUBLIC_FEED_CACHE_TAG, { expire: 0 });
}
