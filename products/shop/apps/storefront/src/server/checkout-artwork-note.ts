import "@tanstack/react-start/server-only";

import { CartIntegrityError } from "@/lib/cart-integrity";
import { CART_LINES_VARIANT_UPDATE_QUERY } from "@/lib/cart-query";
import { CHECKOUT_ARTWORK_NOTE } from "@/lib/checkout-artwork-note";
import { getStorefrontClient } from "@/lib/storefront";

interface CheckoutCart {
  readonly id: string;
  readonly checkoutUrl: string;
  readonly lines: {
    readonly nodes: readonly {
      readonly id: string;
      readonly quantity: number;
      readonly merchandise: { readonly id: string };
      readonly attributes: readonly {
        readonly key: string;
        readonly value: string | null;
      }[];
    }[];
  };
}

// Existing carts need the same explanation as newly added items. Call only
// after every line has passed the checkout capability validation.
export async function ensureCheckoutArtworkNote(
  cart: CheckoutCart,
  upgrades: ReadonlyMap<string, string> = new Map(),
) {
  const lines = cart.lines.nodes.flatMap((line) => {
    const notes = line.attributes.filter(
      ({ key }) => key === CHECKOUT_ARTWORK_NOTE.key,
    );
    const upgraded = upgrades.get(line.id);
    if (
      !upgraded &&
      notes.length === 1 &&
      notes[0]?.value === CHECKOUT_ARTWORK_NOTE.value
    ) {
      return [];
    }
    return [
      {
        id: line.id,
        attributes: [
          ...line.attributes.flatMap(({ key, value }) =>
            key === CHECKOUT_ARTWORK_NOTE.key ||
            value === null ||
            (upgraded && key === "_lineCapability")
              ? []
              : [{ key, value }],
          ),
          CHECKOUT_ARTWORK_NOTE,
          ...(upgraded ? [{ key: "_lineCapability", value: upgraded }] : []),
        ],
      },
    ];
  });
  if (lines.length === 0) return cart.checkoutUrl;

  const client = await getStorefrontClient();
  const result = await client.graphql(CART_LINES_VARIANT_UPDATE_QUERY, {
    variables: { cartId: cart.id, lines },
  });
  if (result.errors)
    throw new CartIntegrityError("Checkout artwork note is unavailable.");
  const update = result.data.cartLinesUpdate;
  if (
    update?.cart?.id !== cart.id ||
    update.userErrors.length > 0 ||
    update.warnings.length > 0 ||
    update.cart.lines.nodes.length !== cart.lines.nodes.length ||
    !cart.lines.nodes.every((line) => {
      const returned = update.cart?.lines.nodes.find(
        ({ id }) => id === line.id,
      );
      const expected =
        lines.find(({ id }) => id === line.id)?.attributes ?? line.attributes;
      return (
        returned?.quantity === line.quantity &&
        returned.merchandise.id === line.merchandise.id &&
        returned.attributes.length === expected.length &&
        expected.every((attribute) =>
          returned.attributes.some(
            ({ key, value }) =>
              key === attribute.key && value === attribute.value,
          ),
        )
      );
    })
  ) {
    throw new CartIntegrityError("Checkout artwork note is unavailable.");
  }
  return update.cart.checkoutUrl;
}
