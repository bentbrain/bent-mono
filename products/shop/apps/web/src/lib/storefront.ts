import "server-only";

import {
  createShopifyRequestContext,
  createStorefrontClient,
} from "@shopify/hydrogen";
import { headers } from "next/headers";
import { cache } from "react";

import { env } from "@/env";
import { getShopifyConfig, shopifyI18n } from "@/lib/shopify-config";

type StorefrontRequest = Pick<Request, "headers"> &
  Partial<Pick<Request, "method" | "signal" | "url">>;

export function createRequestStorefrontClient(
  request: StorefrontRequest,
  i18n: typeof shopifyI18n = shopifyI18n,
) {
  const config = getShopifyConfig();
  const requestContext = createShopifyRequestContext({
    request,
    i18n,
  });
  const storefrontClient = createStorefrontClient({
    type: "public",
    requestContext,
    config: {
      storeDomain: config.storeDomain,
      publicStorefrontToken: config.publicStorefrontToken,
    },
  });

  return { requestContext, storefrontClient };
}

export const getStorefrontClient = cache(async () => {
  const requestHeaders = await headers();
  return createRequestStorefrontClient({ headers: requestHeaders }).storefrontClient;
});

export function getBuyerIp(requestHeaders: Pick<Headers, "get">) {
  return (
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    requestHeaders.get("x-real-ip")?.trim()
  );
}

export function createPrivateStorefrontClient(
  request: StorefrontRequest,
  buyerIp: string,
) {
  const config = getShopifyConfig();
  const requestContext = createShopifyRequestContext({
    request,
    i18n: shopifyI18n,
    buyerIp,
  });
  return createStorefrontClient({
    type: "private",
    requestContext,
    config: {
      storeDomain: config.storeDomain,
      privateStorefrontToken: env.PRIVATE_STOREFRONT_API_TOKEN,
      buyerIp,
    },
  });
}
