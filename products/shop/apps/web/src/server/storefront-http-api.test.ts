import { protectedConfig } from "../../../../scripts/protected-config.mjs";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    assertMappedVariantAvailable: vi.fn(),
    assertSalesIntakeOpen: vi.fn(),
    getContext: vi.fn(),
    graphql: vi.fn(),
    issueCartLineCapability: vi.fn(),
}));
vi.mock("@/env", () => ({
    env: { FOREVER_TEE_API_URL: "https://api.example" },
}));
vi.mock("@/server/cart-product-context", () => ({
    getCartProductContext: mocks.getContext,
}));
vi.mock("@/lib/storefront", () => ({
    createRequestStorefrontClient: () => ({
        storefrontClient: { graphql: mocks.graphql },
    }),
}));
vi.mock("@/server/sales-intake", () => ({
    assertSalesIntakeOpen: mocks.assertSalesIntakeOpen,
    SalesIntakeDependencyError: class SalesIntakeDependencyError extends Error {
    },
}));
vi.mock("@/server/variant-mapping", () => ({
    assertMappedVariantAvailable: mocks.assertMappedVariantAvailable,
    issueCartLineCapability: mocks.issueCartLineCapability,
    VariantMappingDependencyError: class VariantMappingDependencyError extends Error {
    },
    VariantUnavailableError: class VariantUnavailableError extends Error {
    },
}));
import { storefrontApiHandler } from "@/server/storefront-http-api";
const CONFIGURED_PRODUCT_ID = protectedConfig("resource_83abf907850d");
const DESIGN_ID = "3c22bf7e-e698-4a0a-90c4-66c5549f1c45";
const SHOPIFY_PRODUCT_ID = "gid://shopify/Product/base";
const VARIANT_ID = "gid://shopify/ProductVariant/variant";
const STALE_CART_ID = "gid://shopify/Cart/stale-cart";
describe("legacy cart HTTP endpoint", () => {
    beforeEach(() => {
        mocks.assertMappedVariantAvailable.mockReset();
        mocks.assertMappedVariantAvailable.mockResolvedValue(undefined);
        mocks.issueCartLineCapability.mockReset();
        mocks.issueCartLineCapability.mockResolvedValue("signed-line-capability");
        mocks.assertSalesIntakeOpen.mockReset();
        mocks.assertSalesIntakeOpen.mockResolvedValue(undefined);
        mocks.getContext.mockReset();
        mocks.graphql.mockReset();
        mocks.getContext.mockImplementation(() => Effect.succeed({
            productId: CONFIGURED_PRODUCT_ID, designId: DESIGN_ID, baseShopifyHandle: "base-shirt",
        }));
        mocks.graphql.mockImplementation((document: unknown) => {
            if (typeof document !== "string") {
                throw new Error("Expected a GraphQL document string.");
            }
            if (document.includes("ForeverTeeCartVariantIntegrity")) {
                return Promise.resolve({
                    data: {
                        baseProduct: { id: SHOPIFY_PRODUCT_ID },
                        merchandise: {
                            __typename: "ProductVariant",
                            availableForSale: true,
                            id: VARIANT_ID,
                            product: {
                                id: SHOPIFY_PRODUCT_ID,
                                requiresSellingPlan: false,
                            },
                            sellingPlanAllocations: { nodes: [] },
                        },
                    },
                    headers: new Headers(),
                });
            }
            if (document.includes("ForeverTeeCartIntegrity")) {
                return Promise.resolve({
                    data: {
                        cart: {
                            id: STALE_CART_ID,
                            lines: {
                                nodes: [{
                                        attributes: [{
                                                key: "_productId",
                                                value: CONFIGURED_PRODUCT_ID,
                                            }],
                                        id: "gid://shopify/CartLine/stale-line",
                                        merchandise: {
                                            __typename: "ProductVariant",
                                            id: VARIANT_ID,
                                        },
                                        quantity: 0,
                                        sellingPlanAllocation: null,
                                    }],
                            },
                            totalQuantity: 0,
                        },
                    },
                    headers: new Headers(),
                });
            }
            return Promise.resolve({
                data: {
                    cartCreate: {
                        cart: {
                            id: "gid://shopify/Cart/new-cart",
                            lines: {
                                nodes: [{
                                        attributes: [
                                            { key: "_productId", value: CONFIGURED_PRODUCT_ID },
                                            { key: "_designId", value: DESIGN_ID },
                                            {
                                                key: "_artworkUrl",
                                                value: `https://api.example/v1/designs/${DESIGN_ID}/artwork`,
                                            },
                                            { key: "_lineCapability", value: "signed-line-capability" },
                                        ],
                                    }],
                            },
                        },
                        userErrors: [],
                        warnings: [],
                    },
                },
                headers: new Headers(),
            });
        });
    });
    it("validates and purchases a public configured product without owner identity", async () => {
        const response = await storefrontApiHandler(new Request("https://shirt.example/api/v1/cart/product", {
            body: JSON.stringify({
                merchandiseId: VARIANT_ID,
                productId: CONFIGURED_PRODUCT_ID,
                quantity: 1,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            cartId: "gid://shopify/Cart/new-cart",
        });
        expect(response.headers.get("set-cookie")).toContain("cart=new-cart");
        expect(mocks.getContext).toHaveBeenCalledExactlyOnceWith(CONFIGURED_PRODUCT_ID);
        expect(mocks.issueCartLineCapability).toHaveBeenCalledWith(CONFIGURED_PRODUCT_ID, VARIANT_ID, 1);
        expect(mocks.graphql).toHaveBeenCalledTimes(2);
    });
    it("rejects excessive quantities at the Effect HTTP boundary", async () => {
        const response = await storefrontApiHandler(new Request("https://shirt.example/api/v1/cart/product", {
            body: JSON.stringify({
                merchandiseId: VARIANT_ID,
                productId: CONFIGURED_PRODUCT_ID,
                quantity: 11,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }));
        expect(response.status).toBe(400);
        expect(mocks.graphql).not.toHaveBeenCalled();
    });
    it("replaces a stale cart through the legacy Effect HTTP boundary", async () => {
        const response = await storefrontApiHandler(new Request("https://shirt.example/api/v1/cart/product", {
            body: JSON.stringify({
                merchandiseId: VARIANT_ID,
                productId: CONFIGURED_PRODUCT_ID,
                quantity: 1,
            }),
            headers: {
                "content-type": "application/json",
                cookie: "cart=stale-cart",
            },
            method: "POST",
        }));
        expect(response.status).toBe(200);
        expect(mocks.graphql).toHaveBeenCalledTimes(3);
        expect(mocks.graphql.mock.calls.some(([document]) => typeof document === "string" && document.includes("ForeverTeeCartCreate"))).toBe(true);
        expect(mocks.graphql.mock.calls.some(([document]) => typeof document === "string" && document.includes("ForeverTeeCartLinesAdd"))).toBe(false);
        expect(response.headers.get("set-cookie")).toContain("cart=new-cart");
    });
});
