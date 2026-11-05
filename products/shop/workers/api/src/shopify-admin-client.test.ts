import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BASE_PRODUCT_QUERY,
  FULFILMENT_CREATE_MUTATION,
  FULFILMENT_ORDERS_QUERY,
  makeShopifyAdminClient,
  resetShopifyAdminAccessTokenCache,
  ShopifyAdminContractError,
} from "./shopify-admin-client";

const CONFIG = {
  SHOPIFY_ADMIN_STORE_DOMAIN: "bent-shirt.myshopify.com",
  SHOPIFY_CLIENT_ID: "client-id",
  SHOPIFY_CLIENT_SECRET: "client-secret",
};

describe("Shopify Admin base-product client", () => {
  beforeEach(() => {
    resetShopifyAdminAccessTokenCache();
  });

  it("accepts write_orders for payment reads and reuses the same token", async () => {
    const orderId = "gid://shopify/Order/1001";
    const paidAt = Date.parse("2026-09-06T11:08:56Z");
    const fetcher = vi.fn<typeof fetch>((input) => Promise.resolve(
      requestUrl(input).endsWith("/admin/oauth/access_token")
        ? Response.json({access_token: "admin-token", expires_in: 86_399,
            scope: "read_products,write_merchant_managed_fulfillment_orders,write_orders"})
        : Response.json({data: {order: {id: orderId, displayFinancialStatus: "PAID",
            currentTotalPriceSet: {presentmentMoney: {amount: "125.0", currencyCode: "AUD"}},
            transactions: [{kind: "SALE", status: "SUCCESS", createdAt: new Date(paidAt).toISOString(),
              amountSet: {presentmentMoney: {amount: "125.0", currencyCode: "AUD"}}}]}}}),
    ));
    const client = makeShopifyAdminClient(CONFIG, fetcher);
    await expect(client.loadPaidOrderDeadline(orderId, paidAt + 10_000)).resolves.toBe(paidAt + 3_600_000);
    await expect(client.loadPaidOrderDeadline(orderId, paidAt + 20_000)).resolves.toBe(paidAt + 3_600_000);
    expect(fetcher.mock.calls.filter(([input]) => requestUrl(input).endsWith("/admin/oauth/access_token"))).toHaveLength(1);
  });

  it("does not treat read_orders as permission to cancel an order", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({
      access_token: "admin-token", expires_in: 86_399, scope: "read_orders",
    })));
    await expect(makeShopifyAdminClient(CONFIG, fetcher).cancelAndRefundOrder("gid://shopify/Order/1001"))
      .rejects.toThrow("Shopify did not grant write_orders access.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("loads exact Black and White variants from the configured product", async () => {
    const fetcher = shopifyFetcher(product([
      variant("black-s", "Black", "S", true),
      variant("white-s", "White", "S", false),
    ]));

    const result = await makeShopifyAdminClient(CONFIG, fetcher)
      .loadBaseProduct();

    expect(result).toMatchObject({
      handle: "bent-shirt",
      id: "gid://shopify/Product/base",
      variants: [
        { availableForSale: true, color: "Black", size: "S" },
        { availableForSale: false, color: "White", size: "S" },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const tokenRequest = fetcher.mock.calls[0];
    expect(tokenRequest?.[0]).toBe(
      "https://bent-shirt.myshopify.com/admin/oauth/access_token",
    );
    const tokenBody = tokenRequest?.[1]?.body;
    expect(tokenBody instanceof URLSearchParams ? tokenBody.toString() : null).toBe(
      "client_id=client-id&client_secret=client-secret&grant_type=client_credentials",
    );
    const request = fetcher.mock.calls[1];
    expect(request?.[0]).toBe(
      "https://bent-shirt.myshopify.com/admin/api/2026-07/graphql.json",
    );
    expect(request?.[1]?.redirect).toBe("manual");
    expect(request?.[1]?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": "admin-token",
    });
    expect(request?.[1]?.body).toBe(JSON.stringify({
      query: BASE_PRODUCT_QUERY,
      variables: { identifier: { handle: "bent-shirt" } },
    }));
  });

  it("rejects duplicate colour and size combinations", async () => {
    const fetcher = shopifyFetcher(product([
      variant("black-s-one", "Black", "S", true),
      variant("black-s-two", "Black", "S", true),
    ]));
    await expect(makeShopifyAdminClient(CONFIG, fetcher).loadBaseProduct())
      .rejects.toBeInstanceOf(ShopifyAdminContractError);
  });

  it("rejects unexpected colours or product options", async () => {
    const unexpected = variant("navy-s", "Navy", "S", true);
    const fetcher = shopifyFetcher(product([unexpected]));
    await expect(makeShopifyAdminClient(CONFIG, fetcher).loadBaseProduct())
      .rejects.toBeInstanceOf(ShopifyAdminContractError);
  });

  it("loads a separate Black and Cream one-size Cotton Tote product", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => Promise.resolve(
      requestUrl(input).endsWith("/admin/oauth/access_token")
        ? Response.json({
            access_token: "admin-token",
            expires_in: 86_399,
            scope: "read_products",
          })
        : Response.json({ data: { product:
            requestBody(init).includes("cotton-tote")
              ? product([
                  variant("tote-black", "Black", "One size", true),
                  variant("tote-cream", "Cream", "One size", true),
                ], "cotton-tote")
              : product([
                  variant("black-s", "Black", "S", true),
                  variant("white-s", "White", "S", true),
                ]) } }),
    ));

    const products = await makeShopifyAdminClient(CONFIG, fetcher)
      .loadLaunchBaseProducts();

    expect(products).toMatchObject([
      { baseProductSlug: "staple-tee", handle: "bent-shirt" },
      {
        baseProductSlug: "cotton-tote",
        handle: "cotton-tote",
        variants: [
          { color: "Black", size: "One size" },
          { color: "Cream", size: "One size" },
        ],
      },
    ]);
  });

  it.each(["AUSTRALIA_POST", "Australia Post"])("fulfils exact quantities and maps %s to direct carrier tracking", async (carrier) => {
    const orderId = "gid://shopify/Order/1001";
    const lineItemId = "gid://shopify/LineItem/2001";
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/admin/oauth/access_token")) {
        return Promise.resolve(Response.json({
          access_token: "admin-token",
          expires_in: 86_399,
          scope: "write_merchant_managed_fulfillment_orders",
        }));
      }
      const body = requestBody(init);
      if (body.includes("BentShirtFulfilmentOrders")) {
        if (body.includes("assignedLocation")) {
          return Promise.resolve(Response.json({
            errors: [{ message: "Access denied for location field.",
              extensions: { code: "ACCESS_DENIED", requiredAccess: "read_locations" } }],
          }));
        }
        return Promise.resolve(Response.json({
          data: {
            order: {
              fulfillmentOrders: {
                nodes: [{
                  id: "gid://shopify/FulfillmentOrder/4001",
                  lineItems: {
                    nodes: [{
                      id: "gid://shopify/FulfillmentOrderLineItem/5001",
                      lineItem: { id: lineItemId },
                      remainingQuantity: 2,
                    }],
                    pageInfo: { hasNextPage: false },
                  },
                  status: "OPEN",
                }],
                pageInfo: { hasNextPage: false },
              },
              id: orderId,
            },
          },
        }));
      }
      return Promise.resolve(Response.json({
        data: {
          fulfillmentCreate: {
            fulfillment: { id: "gid://shopify/Fulfillment/6001" },
            userErrors: [],
          },
        },
      }));
    });

    const result = await makeShopifyAdminClient(CONFIG, fetcher)
      .createFulfilment(orderId, {
        carrier,
        lines: [{ quantity: 1, shopifyLineItemId: lineItemId }],
        trackingNumber: "ABC123",
        trackingUrl: "https://easyordertracking.aftership.com/ABC123",
      });

    expect(result).toEqual({ id: "gid://shopify/Fulfillment/6001" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({
      query: FULFILMENT_ORDERS_QUERY,
      variables: { id: orderId },
    }));
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({
      query: FULFILMENT_CREATE_MUTATION,
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{
            fulfillmentOrderId: "gid://shopify/FulfillmentOrder/4001",
            fulfillmentOrderLineItems: [{
              id: "gid://shopify/FulfillmentOrderLineItem/5001",
              quantity: 1,
            }],
          }],
          notifyCustomer: true,
          trackingInfo: {
            company: "Australia Post",
            number: "ABC123",
            url: "https://auspost.com.au/track/ABC123",
          },
        },
      },
    }));
  });
});

function shopifyFetcher(baseProduct: Record<string, unknown>) {
  return vi.fn<typeof fetch>((input) => Promise.resolve(
    requestUrl(input).endsWith("/admin/oauth/access_token")
      ? Response.json({
          access_token: "admin-token",
          expires_in: 86_399,
          scope: "read_products",
        })
      : Response.json({ data: { product: baseProduct } }),
  ));
}

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string" || input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function requestBody(init: RequestInit | undefined) {
  return typeof init?.body === "string" ? init.body : "";
}

function product(
  variants: readonly Record<string, unknown>[],
  handle = "bent-shirt",
) {
  return {
    handle,
    id: "gid://shopify/Product/base",
    title: "bent.shop",
    variants: {
      nodes: variants,
      pageInfo: { hasNextPage: false },
    },
  };
}

function variant(
  id: string,
  color: string,
  size: string,
  availableForSale: boolean,
): Record<string, unknown> {
  return {
    availableForSale,
    id: `gid://shopify/ProductVariant/${id}`,
    selectedOptions: [
      { name: "Color", value: color },
      { name: "Size", value: size },
    ],
    sku: `BENT-${color}-${size}`,
    title: `${color} / ${size}`,
  };
}
