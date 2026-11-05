import "server-only";

import payloadConfig from "@/payload.config";
import { type Background, type Category } from "@/payload-types";
import { cacheLife, cacheTag } from "next/cache";
import { getPayload } from "payload";

const BUILDER_ASSETS_CACHE_TAG = "builder-assets";

function resolveCategory(category: number | Category): Category {
  if (typeof category === "number") {
    throw new Error("Builder category relationships were not populated.");
  }

  if (category.name?.toLowerCase() !== "letters") {
    return category;
  }

  return {
    ...category,
    images: category.images ? [...category.images].reverse() : undefined,
  };
}

export async function getBuilderAssets() {
  "use cache";

  cacheLife({
    stale: 300,
    revalidate: 300,
    expire: 3600,
  });
  cacheTag(BUILDER_ASSETS_CACHE_TAG);

  const payload = await getPayload({ config: payloadConfig });
  const [backgrounds, orderedCategories] = await Promise.all([
    payload.findGlobal({
      slug: "backgrounds",
      depth: 1,
    }),
    payload.findGlobal({
      slug: "ordered-categories",
      depth: 2,
    }),
  ]);

  return {
    backgrounds: backgrounds satisfies Background,
    categories: orderedCategories.categories.map(resolveCategory),
  };
}
