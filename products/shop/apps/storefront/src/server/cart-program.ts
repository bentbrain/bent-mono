import "@tanstack/react-start/server-only";
import { Effect } from "effect";
import { env } from "@/server/runtime-env";
import { CHECKOUT_ARTWORK_NOTE } from "@/lib/checkout-artwork-note";
import { getCartProductContext } from "@/server/cart-product-context";

export const resolveVerifiedProductLine = (productId: string) =>
  Effect.gen(function* () {
    const { designId, baseShopifyHandle } =
      yield* getCartProductContext(productId);

    const designApiUrl = env.FOREVER_TEE_API_URL;
    return {
      attributes: [
        CHECKOUT_ARTWORK_NOTE,
        { key: "_productId", value: productId },
        { key: "_designId", value: designId },
        {
          key: "_artworkUrl",
          value: `${designApiUrl}/v1/designs/${designId}/artwork`,
        },
      ],
      baseShopifyHandle,
      designId,
    };
  }).pipe(
    Effect.withSpan("cart.resolveVerifiedProductLine", {
      attributes: { productId },
    }),
  );
