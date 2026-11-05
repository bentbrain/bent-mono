import "server-only";

import { createCartCookie, getCartId } from "@shopify/hydrogen";
import {
  CartRejected,
  DependencyUnavailable,
  type AddProductToCartRequest,
  UnexpectedServerError,
} from "@forever-tee/contracts";
import { Effect, Schema } from "effect";

import { env } from "@/env";
import { CHECKOUT_ARTWORK_NOTE } from "@/lib/checkout-artwork-note";
import {
  assertAddCapacity,
  cartIdForVerifiedAdd,
} from "@/lib/cart-integrity";
import { CART_CREATE_QUERY, CART_LINES_ADD_QUERY } from "@/lib/cart-query";
import { createRequestStorefrontClient } from "@/lib/storefront";
import {
  CartDependencyError,
  readVerifiedCartForAdd,
  verifyShopifyVariant,
} from "@/server/cart-integrity-storefront";
import {
  issueCartLineCapability,
  VariantMappingDependencyError,
  VariantUnavailableError,
} from "@/server/variant-mapping";
import { getCartProductContext } from "@/server/cart-product-context";
import {
  assertSalesIntakeOpen,
  SalesIntakeDependencyError,
} from "@/server/sales-intake";

const CartPayloadSchema = Schema.Struct({
  cart: Schema.NullOr(Schema.Struct({
    id: Schema.String,
    lines: Schema.Struct({
      nodes: Schema.Array(Schema.Struct({
        attributes: Schema.Array(Schema.Struct({
          key: Schema.String,
          value: Schema.String,
        })),
      })),
    }),
  })),
  userErrors: Schema.Array(Schema.Struct({ message: Schema.String })),
  warnings: Schema.Array(Schema.Struct({ message: Schema.String })),
});

export const resolveVerifiedProductLine = (productId: string) =>
  Effect.gen(function*() {
    const { designId, baseShopifyHandle } = yield* getCartProductContext(productId);

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

export const addProductLine = (request: Request, input: AddProductToCartRequest) =>
  Effect.gen(function*() {
    yield* Effect.tryPromise({
      try: () => assertSalesIntakeOpen(),
      catch: (error) =>
        error instanceof SalesIntakeDependencyError
          ? new DependencyUnavailable({ message: error.message })
          : new CartRejected({
              message: error instanceof Error
                ? error.message
                : "Orders are temporarily paused.",
            }),
    });
    const { attributes, baseShopifyHandle, designId } = yield* resolveVerifiedProductLine(
      input.productId,
    );
    const designApiUrl = env.FOREVER_TEE_API_URL;
    const client = yield* Effect.try({
      try: () => createRequestStorefrontClient(request).storefrontClient,
      catch: () => new DependencyUnavailable({ message: "Shopify is unavailable." }),
    });
    const currentCartId = getCartId(request);
    const currentCart = currentCartId
      ? yield* Effect.tryPromise({
          try: () => readVerifiedCartForAdd(client, currentCartId),
          catch: cartVerificationError,
        })
      : undefined;
    const addCartId = cartIdForVerifiedAdd(currentCartId, currentCart);
    yield* Effect.tryPromise({
      try: async () => {
        assertAddCapacity(addCartId ? currentCart : undefined, {
          lines: [{
            attributes: [],
            merchandiseId: input.merchandiseId,
            quantity: input.quantity,
          }],
        });
        await verifyShopifyVariant(
          client,
          input.merchandiseId,
          baseShopifyHandle,
          undefined,
        );
      },
      catch: cartVerificationError,
    });
    const lineCapability = yield* Effect.tryPromise({
      try: () => issueCartLineCapability(
        input.productId,
        input.merchandiseId,
        input.quantity,
      ),
      catch: cartVerificationError,
    });
    const verifiedAttributes = [
      ...attributes,
      { key: "_lineCapability", value: lineCapability },
    ];
    const rawPayload = addCartId
      ? yield* Effect.tryPromise({
          try: () =>
            client.graphql(CART_LINES_ADD_QUERY, {
              variables: {
                cartId: addCartId,
                lines: [{
                  attributes: verifiedAttributes,
                  merchandiseId: input.merchandiseId,
                  quantity: input.quantity,
                }],
              },
            }),
          catch: () =>
            new DependencyUnavailable({ message: "Shopify is unavailable." }),
        }).pipe(
          Effect.flatMap((response) =>
            response.data
              ? Effect.succeed(response.data.cartLinesAdd)
              : Effect.fail(
                  new CartRejected({ message: "Shopify rejected the cart request." }),
                ),
          ),
        )
      : yield* Effect.tryPromise({
          try: () =>
            client.graphql(CART_CREATE_QUERY, {
              variables: {
                input: {
                  lines: [{
                    attributes: verifiedAttributes,
                    merchandiseId: input.merchandiseId,
                    quantity: input.quantity,
                  }],
                },
              },
            }),
          catch: () =>
            new DependencyUnavailable({ message: "Shopify is unavailable." }),
        }).pipe(
          Effect.flatMap((response) =>
            response.data
              ? Effect.succeed(response.data.cartCreate)
              : Effect.fail(
                  new CartRejected({ message: "Shopify rejected the cart request." }),
                ),
          ),
        );
    const payload = yield* Schema.decodeUnknown(CartPayloadSchema)(rawPayload).pipe(
      Effect.mapError(
        () => new UnexpectedServerError({ message: "Shopify returned invalid cart data." }),
      ),
    );
    if (payload.userErrors.length > 0) {
      return yield* Effect.fail(
        new CartRejected({
          message: payload.userErrors.map(({ message }) => message).join(" "),
        }),
      );
    }
    if (!payload.cart) {
      return yield* Effect.fail(
        new UnexpectedServerError({ message: "Shopify returned no cart." }),
      );
    }
    const persistedAttributes = payload.cart.lines.nodes.flatMap(
      ({ attributes: lineAttributes }) => lineAttributes,
    );
    const designPersisted = persistedAttributes.some(
      ({ key, value }) => key === "_designId" && value === designId,
    );
    const productPersisted = persistedAttributes.some(
      ({ key, value }) => key === "_productId" && value === input.productId,
    );
    const artworkPersisted = persistedAttributes.some(
      ({ key, value }) =>
        key === "_artworkUrl" &&
        value === `${designApiUrl}/v1/designs/${designId}/artwork`,
    );
    const capabilityPersisted = persistedAttributes.some(
      ({ key, value }) => key === "_lineCapability" && value === lineCapability,
    );
    if (
      !productPersisted || !designPersisted || !artworkPersisted ||
      !capabilityPersisted
    ) {
      return yield* Effect.fail(
        new UnexpectedServerError({ message: "Shopify omitted the design attributes." }),
      );
    }
    return {
      cartId: payload.cart.id,
      setCookie: createCartCookie(payload.cart.id),
    };
  }).pipe(
    Effect.withSpan("cart.addProductLine", {
      attributes: { productId: input.productId },
    }),
  );

function cartVerificationError(error: unknown) {
  return error instanceof CartDependencyError ||
      error instanceof VariantMappingDependencyError
    ? new DependencyUnavailable({ message: error.message })
    : new CartRejected({
        message: error instanceof VariantUnavailableError
          ? error.message
          : error instanceof Error
          ? error.message
          : "The cart request could not be verified.",
      });
}
