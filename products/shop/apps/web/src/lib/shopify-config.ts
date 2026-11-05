import "server-only";

import { env } from "@/env";

export function getShopifyConfig() {
  return {
    publicStorefrontToken: env.PUBLIC_STOREFRONT_API_TOKEN,
    shopId: env.SHOP_ID ?? "0",
    storeDomain: env.PUBLIC_STORE_DOMAIN,
    storefrontId: env.PUBLIC_STOREFRONT_ID ?? "0",
  };
}

export const shopifyI18n = {
  country: "AU",
  language: "EN",
} as const;
