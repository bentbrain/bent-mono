import { protectedConfig } from "../../../../scripts/protected-config.mjs";
import { describe, expect, it } from "vitest";
import { assertAddCapacity, assertCartIdMatches, attributesForNewLine, cartIdForVerifiedAdd, cartLineForUpdate, decodeCartLinesMutation, MAX_CART_TOTAL_QUANTITY, persistedProductId, rebuildLineAttributes, requireCookieCartId, validateVariantCandidate, type CartSnapshot, type VariantCandidate, } from "./cart-integrity";
const CART_ID = "gid://shopify/Cart/cart-one";
const LINE_ID = "gid://shopify/CartLine/line-one";
const PRODUCT_ID = "gid://shopify/Product/base-product";
const VARIANT_ID = "gid://shopify/ProductVariant/variant-one";
const PRODUCT_RECORD_ID = protectedConfig("resource_83abf907850d");
const VERIFIED_ATTRIBUTES = [
    { key: "Artwork", value: "Your saved design will be printed. Checkout images show the blank product." },
    { key: "_productId", value: PRODUCT_RECORD_ID },
    { key: "_designId", value: "cd05902b-68af-46bb-a8cd-f61e87f24c1d" },
    { key: "_artworkUrl", value: "https://api.example.com/artwork" },
];
const VALID_VARIANT: VariantCandidate = {
    availableForSale: true,
    baseProductId: PRODUCT_ID,
    productId: PRODUCT_ID,
    requiresSellingPlan: false,
    sellingPlanIds: [],
    typeName: "ProductVariant",
};
const CART: CartSnapshot = {
    id: CART_ID,
    lines: [{
            attributes: [
                { key: "Gift note", value: "Keep this" },
                ...VERIFIED_ATTRIBUTES,
            ],
            id: LINE_ID,
            merchandiseId: VARIANT_ID,
            quantity: 1,
        }],
    totalQuantity: 1,
};
describe("variant integrity", () => {
    it("rejects merchandise that is not a product variant", () => {
        expect(() => {
            validateVariantCandidate({ ...VALID_VARIANT, typeName: "Product" }, undefined);
        }).toThrow("not a product variant");
    });
    it("rejects a cheaper variant from an unrelated Shopify product", () => {
        expect(() => {
            validateVariantCandidate({ ...VALID_VARIANT, productId: "gid://shopify/Product/cheaper-product" }, undefined);
        }).toThrow("does not belong");
    });
    it("rejects an unavailable variant", () => {
        expect(() => {
            validateVariantCandidate({ ...VALID_VARIANT, availableForSale: false }, undefined);
        }).toThrow("unavailable");
    });
    it("requires and validates a selling plan allocation", () => {
        const subscriptionVariant = {
            ...VALID_VARIANT,
            requiresSellingPlan: true,
            sellingPlanIds: ["gid://shopify/SellingPlan/allowed"],
        };
        expect(() => {
            validateVariantCandidate(subscriptionVariant, undefined);
        })
            .toThrow("Choose an available purchase plan");
        expect(() => {
            validateVariantCandidate(subscriptionVariant, "gid://shopify/SellingPlan/forged");
        }).toThrow("purchase plan is unavailable");
        expect(() => {
            validateVariantCandidate(subscriptionVariant, "gid://shopify/SellingPlan/allowed");
        }).not.toThrow();
    });
});
describe("cart and line ownership", () => {
    it("rejects a client cart ID that differs from the cookie cart", () => {
        expect(() => {
            assertCartIdMatches("gid://shopify/Cart/other", CART_ID);
        }).toThrow("does not match");
        expect(() => requireCookieCartId(CART_ID, undefined)).toThrow("No cart exists");
    });
    it("rejects a line that is not in the cookie cart", () => {
        expect(() => cartLineForUpdate(CART, "gid://shopify/CartLine/other"))
            .toThrow("does not exist");
    });
    it("returns the persisted line for a valid update", () => {
        expect(cartLineForUpdate(CART, LINE_ID).merchandiseId).toBe(VARIANT_ID);
    });
    it("replaces a Shopify cart that retained invalid zero-quantity lines", () => {
        const line = CART.lines[0];
        if (!line)
            throw new Error("Expected a cart line fixture.");
        expect(cartIdForVerifiedAdd(CART_ID, CART)).toBe(CART_ID);
        expect(cartIdForVerifiedAdd(CART_ID, {
            ...CART,
            lines: [{ ...line, quantity: 0 }],
            totalQuantity: 0,
        })).toBeUndefined();
        expect(cartIdForVerifiedAdd(CART_ID, {
            ...CART,
            lines: [],
            totalQuantity: 0,
        })).toBe(CART_ID);
    });
    it("rejects ambiguous persisted product attributes", () => {
        expect(() => {
            persistedProductId([
                { key: "_productId", value: PRODUCT_RECORD_ID },
                { key: "Artwork", value: "Forged artwork explanation" },
                { key: "_productId", value: "forged-product" },
            ]);
        }).toThrow("missing its verified product");
    });
});
describe("cart request boundaries", () => {
    it("decodes a valid add and enforces line quantity limits", () => {
        const mutation = decodeCartLinesMutation({
            lines: [{
                    attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
                    merchandiseId: VARIANT_ID,
                    quantity: 1,
                }],
        });
        expect(mutation?.kind).toBe("add");
        if (mutation?.kind !== "add") {
            throw new Error("Expected an add mutation.");
        }
        expect(() => {
            assertAddCapacity(undefined, mutation.request);
        }).not.toThrow();
        expect(() => {
            decodeCartLinesMutation({
                lines: [{
                        attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
                        merchandiseId: VARIANT_ID,
                        quantity: 11,
                    }],
            });
        }).toThrow("invalid");
    });
    it("enforces the cumulative cart quantity cap", () => {
        const mutation = decodeCartLinesMutation({
            lines: [{
                    attributes: [{ key: "_productId", value: PRODUCT_RECORD_ID }],
                    merchandiseId: VARIANT_ID,
                    quantity: 2,
                }],
        });
        if (mutation?.kind !== "add") {
            throw new Error("Expected an add mutation.");
        }
        expect(() => {
            assertAddCapacity({ ...CART, totalQuantity: MAX_CART_TOTAL_QUANTITY - 1 }, mutation.request);
        }).toThrow("quantity limit");
    });
    it("decodes mixed removals and quantity updates", () => {
        expect(decodeCartLinesMutation({
            lines: [
                { id: LINE_ID, quantity: 0 },
                { id: "gid://shopify/CartLine/line-two", quantity: 2 },
            ],
        })).toEqual({
            kind: "update",
            request: {
                lines: [
                    { attributes: [], id: LINE_ID, quantity: 0 },
                    {
                        attributes: [],
                        id: "gid://shopify/CartLine/line-two",
                        quantity: 2,
                    },
                ],
            },
        });
    });
});
describe("reserved attributes", () => {
    it("discards forged reserved attributes on add", () => {
        expect(attributesForNewLine([
            { key: "Artwork", value: "Forged artwork explanation" },
            { key: "_productId", value: "forged-product" },
            { key: "_designId", value: "forged-design" },
            { key: "_lineCapability", value: "forged-capability" },
            { key: "Gift note", value: "Keep this" },
        ], VERIFIED_ATTRIBUTES)).toEqual([
            { key: "Gift note", value: "Keep this" },
            ...VERIFIED_ATTRIBUTES,
        ]);
    });
    it("rebuilds updates from persisted attributes, not client attributes", () => {
        expect(rebuildLineAttributes(CART.lines[0]?.attributes ?? [], VERIFIED_ATTRIBUTES)).toEqual([
            { key: "Gift note", value: "Keep this" },
            ...VERIFIED_ATTRIBUTES,
        ]);
    });
});
