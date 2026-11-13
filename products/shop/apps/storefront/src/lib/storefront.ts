import "@tanstack/react-start/server-only";
import {
  createShopifyRequestContext,
  createStorefrontClient,
} from "@shopify/hydrogen";
import { getRequest } from "@tanstack/react-start/server";
import { getShopifyConfig, shopifyI18n } from "@/lib/shopify-config";

type StorefrontRequest = Pick<Request, "headers"> &
  Partial<Pick<Request, "method" | "signal" | "url">>;
export function createRequestStorefrontClient(
  request: StorefrontRequest,
  i18n: typeof shopifyI18n = shopifyI18n,
) {
  const config = getShopifyConfig();
  const requestContext = createShopifyRequestContext({ request, i18n });
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
export function getStorefrontClient() {
  return Promise.resolve(
    createRequestStorefrontClient(getRequest()).storefrontClient,
  );
}
