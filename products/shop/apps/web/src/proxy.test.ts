import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routing = vi.hoisted(() => ({
  handleShopifyRoutes: vi.fn(),
  getForwardedRequestHeaders: vi.fn(() => new Headers({ "x-storefront-url": "https://shirt.example/checkout" })),
  applyResponseHeaders: vi.fn((headers: Headers) => { headers.set("server-timing", "fixture"); }),
}));
vi.mock("@shopify/hydrogen", () => ({ handleShopifyRoutes: routing.handleShopifyRoutes }));

vi.mock("@/lib/cart-handlers", () => ({ cartHandlers: {} }));
vi.mock("@/lib/shopify-config", () => ({
  getShopifyConfig: () => ({ storeDomain: "example.myshopify.com" }),
}));
vi.mock("@/lib/storefront", () => ({
  createRequestStorefrontClient: vi.fn(() => ({
    requestContext: {
      getForwardedRequestHeaders: routing.getForwardedRequestHeaders,
      applyResponseHeaders: routing.applyResponseHeaders,
    },
    storefrontClient: {},
  })),
}));

import { proxy } from "@/proxy";
import { createRequestStorefrontClient } from "@/lib/storefront";

const CART_MUTATION_PATHS = [
  "/cart/add.js",
  "/cart/change.js",
  "/cart/clear.js",
  "/cart/update.js",
  "/cart.js",
];

describe("cart boundary proxy", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("leaves checkout to the validated application route and preserves request headers", async () => {
    const response = await proxy(new NextRequest("https://shirt.example/checkout"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-request-x-storefront-url")).toBe("https://shirt.example/checkout");
    expect(response.headers.get("server-timing")).toBe("fixture");
    expect(routing.handleShopifyRoutes).not.toHaveBeenCalled();
  });

  it("still lets Hydrogen own its other registered routes", async () => {
    const handled = Response.json({ cart: null });
    routing.handleShopifyRoutes.mockResolvedValueOnce(handled);
    expect(await proxy(new NextRequest("https://shirt.example/api/cart"))).toBe(handled);
    expect(routing.handleShopifyRoutes).toHaveBeenCalledOnce();
  });
  it("passes the internal product preflight directly to its route", async () => {
    const response = await proxy(
      new NextRequest("https://shirt.example/api/product-availability"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each(CART_MUTATION_PATHS)("rejects the same-origin %s mutation", async (path) => {
    const response = await proxy(new NextRequest(`https://shirt.example${path}`, {
      method: "POST",
    }));

    expect(response.status).toBe(403);
    expect(createRequestStorefrontClient).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "cart_boundary_required",
        message: "Direct browser cart mutations are disabled.",
      },
    });
  });

  it("rejects cart permalinks before Shopify routing", async () => {
    const response = await proxy(
      new NextRequest("https://shirt.example/cart/12345:2"),
    );

    expect(response.status).toBe(403);
  });

  it("rejects browser Storefront GraphQL mutations", async () => {
    const response = await proxy(
      new NextRequest("https://shirt.example/api/2026-07/graphql.json", {
        body: JSON.stringify({
          query: "mutation CartCreate { cartCreate { cart { id } } }",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(403);
  });
});
