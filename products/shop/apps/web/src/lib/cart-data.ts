import "server-only";

import { cache } from "react";

import { cartHandlers } from "@/lib/cart-handlers";
import { getStorefrontClient } from "@/lib/storefront";

export const getCartData = cache(async () => {
  const storefrontClient = await getStorefrontClient();
  const { data } = await cartHandlers.get({ storefrontClient });
  return data;
});
