import { CartRejected, DependencyUnavailable, ProductSchema, DesignSchema } from "@forever-tee/contracts";
import { Effect, Either, Schema } from "effect";
import { getProduct } from "./product-programs";
import { getDesign } from "./design-programs";
import { makeProductRepositoryLayer } from "./product-repository";
import { makeDesignRepositoryLayer } from "./design-repository";
import { isAuthenticatedServiceRequest } from "./service-auth";

// Run the existing live repository checks behind one service request. Do not
// replace these with display caches or treat this metadata as a purchase token.
export const resolveCartProductContext = (productId: string) => Effect.gen(function*() {
  const product = yield* getProduct(productId).pipe(
    Effect.flatMap(Schema.decodeUnknown(ProductSchema)),
    Effect.mapError(error => error._tag === "ProductNotFound"
      ? new CartRejected({ message: "This product is unavailable." })
      : new DependencyUnavailable({ message: "Product storage is unavailable." })),
  );
  if (!product.designId) {
    return yield* Effect.fail(new CartRejected({ message: "Create a design before adding this product." }));
  }
  const designId = product.designId;
  // Preserve base-product error precedence even when the design fails first.
  const [baseResult, designResult] = yield* Effect.all([
    getProduct(product.baseProductId).pipe(
      Effect.flatMap(Schema.decodeUnknown(ProductSchema)),
      Effect.mapError(error => error._tag === "ProductNotFound"
        ? new CartRejected({ message: "This product is unavailable." })
        : new DependencyUnavailable({ message: "Product storage is unavailable." })),
      Effect.either,
    ),
    getDesign(designId).pipe(
      Effect.flatMap(Schema.decodeUnknown(DesignSchema)),
      Effect.mapError(error => error._tag === "DesignNotFound"
        ? new CartRejected({ message: "This design is unavailable." })
        : new DependencyUnavailable({ message: "Design storage is unavailable." })),
      Effect.either,
    ),
  ], { concurrency: 2 });
  const base = yield* baseResult;
  if (base.designId || base.id !== product.baseProductId) {
    return yield* Effect.fail(new CartRejected({ message: "This product has an invalid base product." }));
  }
  const design = yield* designResult;
  if (design.status !== "ready" && !product.preparationId) {
    return yield* Effect.fail(new CartRejected({ message: "This design is still preparing its print-ready artwork." }));
  }
  return { productId, designId, baseShopifyHandle: base.shopifyHandle };
});

type CartContextEnv = Parameters<typeof makeDesignRepositoryLayer>[0] & {
  readonly FOREVER_TEE_API_SHARED_SECRET?: string;
};

export async function handleCartProductContextRequest(request: Request, env: CartContextEnv) {
  const path = new URL(request.url).pathname;
  const match = /^\/v2\/internal\/cart-product-context\/([0-9a-f-]{36})$/i.exec(path);
  const productId = match?.[1];
  if (!productId) return undefined;
  const headers = { "Cache-Control": "no-store" };
  if (!(await isAuthenticatedServiceRequest(request, env))) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "Service authentication is required." } }, { status: 401, headers });
  }
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
  const result = await Effect.runPromise(resolveCartProductContext(productId).pipe(
    Effect.provide([makeProductRepositoryLayer(env), makeDesignRepositoryLayer(env)]), Effect.either,
  ));
  if (Either.isLeft(result)) return Response.json({ error: { code: result.left._tag, message: result.left.message } }, {
    status: result.left._tag === "CartRejected" ? 409 : 503, headers,
  });
  return Response.json(result.right, { headers });
}
