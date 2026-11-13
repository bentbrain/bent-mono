import "@tanstack/react-start/server-only";
import { cartHandlers } from "@/lib/cart-handlers";
import { getStorefrontClient } from "@/lib/storefront";
export async function getCartData() {
  const { data } = await cartHandlers.get({
    storefrontClient: await getStorefrontClient(),
  });
  const cart = data.cart;
  return {
    ...("errors" in data ? { errors: data.errors } : {}),
    cart: cart
      ? {
          id: cart.id,
          checkoutUrl: cart.checkoutUrl,
          totalQuantity: cart.totalQuantity,
          note: cart.note,
          cost: cart.cost,
          attributes: cart.attributes,
          lines: { nodes: cart.lines.nodes },
          discountCodes: cart.discountCodes,
        }
      : null,
  };
}
