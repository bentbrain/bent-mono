import { protectedConfig } from "../../../../scripts/protected-config.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/env", () => ({
    env: {
        FOREVER_TEE_API_SHARED_SECRET: "service-secret",
        FOREVER_TEE_API_URL: "https://api.example",
    },
}));
vi.mock("undici", () => ({ fetch: mocks.fetch }));
import { assertMappedVariantAvailable, issueCartLineCapability, revalidateCartLineCapability, VariantMappingDependencyError, VariantUnavailableError, } from "@/server/variant-mapping";
const VARIANT_ID = "gid://shopify/ProductVariant/101";
describe("variant mapping client", () => {
    beforeEach(() => mocks.fetch.mockReset());
    it("accepts only the exact available Shopify variant", async () => {
        mocks.fetch.mockResolvedValue(Response.json({
            available: true,
            shopifyVariantId: VARIANT_ID,
        }));
        await expect(assertMappedVariantAvailable(VARIANT_ID, "bent-shirt")).resolves.toBeUndefined();
        const expectedUrl = new URL("https://api.example/v2/internal/variant-mapping");
        expectedUrl.searchParams.set("merchandiseId", VARIANT_ID);
        expectedUrl.searchParams.set("baseHandle", "bent-shirt");
        expect(mocks.fetch).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({
            headers: {
                "x-forever-tee-service-secret": "service-secret",
            },
            redirect: "error",
        }));
    });
    it("rejects a mapped variant when effective stock is unavailable", async () => {
        mocks.fetch.mockResolvedValue(Response.json({
            available: false,
            shopifyVariantId: VARIANT_ID,
        }));
        await expect(assertMappedVariantAvailable(VARIANT_ID, "bent-shirt")).rejects.toBeInstanceOf(VariantUnavailableError);
    });
    it("fails closed when the Worker returns a different variant", async () => {
        mocks.fetch.mockResolvedValue(Response.json({
            available: true,
            shopifyVariantId: "gid://shopify/ProductVariant/other",
        }));
        await expect(assertMappedVariantAvailable(VARIANT_ID, "bent-shirt")).rejects.toBeInstanceOf(VariantMappingDependencyError);
    });
    it("requests a quantity-bound capability for the configured product", async () => {
        mocks.fetch.mockResolvedValue(Response.json({ capability: "v1.payload.signature" }));
        await expect(issueCartLineCapability(protectedConfig("resource_83abf907850d"), VARIANT_ID, 2)).resolves.toBe("v1.payload.signature");
        expect(mocks.fetch).toHaveBeenCalledWith(new URL("https://api.example/v2/internal/cart-line-capabilities"), expect.objectContaining({
            body: JSON.stringify({
                allowPending: true,
                configuredProductId: protectedConfig("resource_83abf907850d"),
                merchandiseId: VARIANT_ID,
                quantity: 2,
            }),
            method: "POST",
        }));
    });
    it("reports pending print work without claiming that the variant is unavailable", async () => {
        mocks.fetch.mockResolvedValue(Response.json({ error: { code: "PRINT_ASSETS_PENDING" } }, { status: 409 }));
        const attempt = issueCartLineCapability("new-product", VARIANT_ID, 1);
        await expect(attempt)
            .rejects.toThrow("Your artwork is still being prepared. Please try again shortly.");
        await expect(attempt)
            .rejects.toBeInstanceOf(VariantMappingDependencyError);
    });
    it("upgrades an intent only when the API returns a verified final capability", async () => {
        mocks.fetch.mockResolvedValue(Response.json({ valid: true, capability: "v1.ready.signature" }));
        await expect(revalidateCartLineCapability("i1.pending.signature", "product", VARIANT_ID, 1)).resolves.toBe("v1.ready.signature");
        mocks.fetch.mockResolvedValue(Response.json({ valid: true }));
        await expect(revalidateCartLineCapability("i1.pending.signature", "product", VARIANT_ID, 1)).rejects.toThrow();
        mocks.fetch.mockResolvedValue(Response.json({ error: { code: "PRINT_ASSETS_PENDING" } }, { status: 409 }));
        await expect(revalidateCartLineCapability("i1.pending.signature", "product", VARIANT_ID, 1)).rejects.toThrow("Checkout will be available shortly");
    });
    it("revalidates an existing capability before checkout", async () => {
        mocks.fetch.mockResolvedValue(Response.json({ valid: true }));
        await expect(revalidateCartLineCapability("v1.payload.signature", protectedConfig("resource_83abf907850d"), VARIANT_ID, 2)).resolves.toBeUndefined();
        expect(mocks.fetch).toHaveBeenCalledWith(new URL("https://api.example/v2/internal/cart-line-capabilities"), expect.objectContaining({
            body: JSON.stringify({
                capability: "v1.payload.signature",
                configuredProductId: protectedConfig("resource_83abf907850d"),
                merchandiseId: VARIANT_ID,
                quantity: 2,
            }),
        }));
    });
});
