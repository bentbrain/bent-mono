import "server-only";

import { io } from "next/cache";
import { cache } from "react";
import { fetch } from "undici";
import { parseFeaturedProducts } from "@forever-tee/contracts";

import { env } from "@/env";

export const featuredProductsForRequest = cache(async () => {
  await io();
  const response = await fetch(new URL("/v2/internal/featured-products", env.FOREVER_TEE_API_URL), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET },
  });
  const payload: unknown = response.ok ? await response.json() : undefined;
  const products = typeof payload === "object" && payload !== null && "products" in payload
    ? parseFeaturedProducts(payload.products) : undefined;
  if (!products) throw new Error("Featured products are unavailable.");
  return products;
});
