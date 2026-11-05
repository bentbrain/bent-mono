import { protectedConfig } from "../../../../scripts/protected-config.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfiguredProductFamily } from "./effect-product-api";
const mocks = vi.hoisted(() => ({ version: vi.fn(), forget: vi.fn() }));
vi.mock("./effect-design-api", () => ({ designVersion: mocks.version, forgetDesignVersion: mocks.forget }));
const designId = protectedConfig("resource_83abf907850d");
const bases = ["a51b7acf-77e9-4762-83c4-62d96dd8942c", "97b629d7-1d3b-4d2a-a586-537168141e97"];
const products = bases.map((baseProductId, index) => ({
    id: index ? protectedConfig("resource_6fc1415f238d") : "9bbac861-76bf-4818-957d-12770401474a",
    baseProductId, designId, designRevisionId: "a58634b2-02dd-4ac8-b449-1978df422377",
    shopifyHandle: index ? "cotton-tote" : "bent-shirt", createdAt: "2026-08-28T00:00:00.000Z",
}));
const input = { baseProductIds: bases, designId };
beforeEach(() => { vi.clearAllMocks(); mocks.version.mockResolvedValue(3); });
afterEach(() => vi.unstubAllGlobals());
describe("configured product family API", () => {
    it("admits both products with one owner-aware request and preserves their order", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ products }));
        vi.stubGlobal("fetch", fetch);
        const result = await createConfiguredProductFamily(input);
        expect(result.map((product) => product.baseProductId)).toEqual(bases);
        expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/configured-product-families", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...input, expectedVersion: 3 }),
        });
        expect(mocks.forget).toHaveBeenCalledWith(designId);
    });
    it("refreshes once on a stale draft version", async () => {
        mocks.version.mockResolvedValueOnce(3).mockResolvedValueOnce(4);
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 409 }))
            .mockResolvedValueOnce(Response.json({ products }));
        vi.stubGlobal("fetch", fetch);
        await createConfiguredProductFamily(input);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ ...input, expectedVersion: 4 }) });
    });
    for (const status of [404, 422]) {
        it(`rejects the whole family without creating only a tote when admission returns ${String(status)}`, async () => {
            const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status }))
                .mockResolvedValueOnce(new Response(null, { status: 422 }))
                .mockResolvedValueOnce(Response.json(products[1]));
            vi.stubGlobal("fetch", fetch);
            const result = createConfiguredProductFamily(input);
            await expect(result).rejects.toThrow(status === 422 ? "higher-resolution photo" : "could not be created");
            if (status === 422)
                await expect(result).rejects.toMatchObject({ retryable: false });
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(fetch.mock.calls[0]?.[0]).toBe("/api/configured-product-families");
        });
    }
    for (const status of [403, 429, 503]) {
        it(`does not bypass a ${String(status)} failure through the legacy API`, async () => {
            const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status }));
            vi.stubGlobal("fetch", fetch);
            await expect(createConfiguredProductFamily(input)).rejects.toThrow("could not be created");
            expect(fetch).toHaveBeenCalledTimes(1);
        });
    }
    it("rejects an empty successful family response", async () => {
        vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ products: [] })));
        await expect(createConfiguredProductFamily(input)).rejects.toThrow();
    });
});
