import { createFileRoute } from "@tanstack/react-router";
import { createBff } from "../server/bff";
import { recordCreationTrace } from "../server/creation-trace";
import { runtimeEnv } from "../server/runtime-env";
import { createRequestStorefrontClient } from "@/lib/storefront";
import { cartHandlers } from "@/lib/cart-handlers";
import { handleShopifyRoutes } from "@shopify/hydrogen";
import { getForeverTeeProduct } from "@/lib/product-data";
import { BASE_PRODUCT_ID } from "@/lib/products";
import { ProductSchema } from "@forever-tee/contracts";
import { Schema } from "effect";
import { cartBypassRejection } from "../../../web/src/lib/cart-bypass";

async function handler({ request }: { request: Request }) {
  if (
    new URL(request.url).pathname === "/api/creation-trace" &&
    request.method === "POST"
  )
    return recordCreationTrace(request);
  const rejection = await cartBypassRejection(request);
  if (rejection) return Response.json({ error: rejection }, { status: 403 });
  if (new URL(request.url).pathname === "/api/product-availability") {
    try {
      const env = runtimeEnv();
      const response = await fetch(
        new URL(`/v1/products/${BASE_PRODUCT_ID}`, env.FOREVER_TEE_API_URL),
        { redirect: "manual" },
      );
      if (!response.ok) throw new Error("Catalogue unavailable");
      const record = Schema.decodeUnknownSync(ProductSchema)(
        await response.json(),
      );
      const product =
        record.designId === null && record.id === record.baseProductId
          ? await getForeverTeeProduct({}, record.shopifyHandle)
          : null;
      return Response.json(
        {
          available:
            product?.adjacentVariants.some(
              (variant) => variant.availableForSale,
            ) === true,
        },
        { headers: { "cache-control": "private, no-store" } },
      );
    } catch {
      return Response.json(
        { available: false },
        { status: 503, headers: { "cache-control": "private, no-store" } },
      );
    }
  }
  if (new URL(request.url).pathname === "/api/cart") {
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return new Response(null, { status: 403 });
    const { requestContext, storefrontClient } =
      createRequestStorefrontClient(request);
    const items = new Map<string, unknown>();
    return (
      (await handleShopifyRoutes({
        request,
        requestContext,
        storefrontClient,
        handlers: [cartHandlers],
        sessionManager: {
          getSessionOrigin: () => new URL(request.url).origin,
          getSessionItem: (key) => items.get(key),
          setSessionItem: (key, value) => {
            items.set(key, value);
          },
          removeSessionItem: (key) => {
            items.delete(key);
          },
        },
      })) ?? new Response(null, { status: 404 })
    );
  }
  const env = runtimeEnv();
  return createBff({
    apiOrigin: env.FOREVER_TEE_API_URL,
    sharedSecret: env.FOREVER_TEE_API_SHARED_SECRET,
    turnstileSecret: env.TURNSTILE_SECRET,
    fetcher: (input, init) => fetch(input, init),
  })(request);
}
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: handler,
      HEAD: handler,
      POST: handler,
      PUT: handler,
      PATCH: handler,
      DELETE: handler,
    },
  },
});
