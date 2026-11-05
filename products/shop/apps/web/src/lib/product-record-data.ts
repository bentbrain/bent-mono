import "server-only";

import type { ProductDto } from "@forever-tee/contracts";
import { Effect, Either } from "effect";
import { cacheLife, cacheTag } from "next/cache";

import {
  getProductFamilyFromApi,
  getProductFromApi,
} from "@/server/product-api-client";

export async function getCachedProductRecord(
  id: string,
): Promise<ProductDto | undefined> {
  "use cache: remote";
  cacheLife({
    stale: 86_400,
    revalidate: 604_800,
    expire: 2_592_000,
  });
  cacheTag("product-records", `product-record:${id}`);

  const result = await Effect.runPromise(Effect.either(getProductFromApi(id)));
  if (Either.isRight(result)) return result.right;
  if (result.left._tag === "ProductNotFound") return undefined;
  throw result.left;
}

export async function getCachedProductFamilyRecords(
  id: string,
): Promise<readonly ProductDto[] | undefined> {
  "use cache: remote";
  cacheLife({
    stale: 86_400,
    revalidate: 604_800,
    expire: 2_592_000,
  });
  cacheTag("product-records", `product-family:${id}`);

  const result = await Effect.runPromise(
    Effect.either(getProductFamilyFromApi(id)),
  );
  if (Either.isRight(result)) return result.right;
  if (result.left._tag === "ProductNotFound") return undefined;
  throw result.left;
}
