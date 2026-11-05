import { protectedConfig } from "../../../../scripts/protected-config.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesign, forgetDesignVersion } from "./effect-design-api";
import { createConfiguredProduct } from "./effect-product-api";
const DESIGN_ID = protectedConfig("resource_83abf907850d");
const BASE_PRODUCT_ID = "a51b7acf-77e9-4762-83c4-62d96dd8942c";
const PRODUCT_ID = protectedConfig("resource_6fc1415f238d");
afterEach(() => vi.unstubAllGlobals());
describe("configured product browser API", () => {
    it("uses the owner-aware BFF with the current draft version", async () => {
        const calls: {
            body: BodyInit | null | undefined;
            url: string;
        }[] = [];
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string"
                ? input
                : input instanceof URL ? input.toString() : input.url;
            calls.push({ body: init?.body, url });
            if (url === "/api/design-drafts") {
                return Promise.resolve(Response.json({ id: DESIGN_ID, version: 3 }, { status: 201 }));
            }
            return Promise.resolve(Response.json({
                id: PRODUCT_ID,
                baseProductId: BASE_PRODUCT_ID,
                designId: DESIGN_ID,
                designRevisionId: PRODUCT_ID,
                shopifyHandle: "bent-shirt",
                createdAt: "2026-08-16T00:00:00.000Z",
            }, { status: 201 }));
        });
        await createDesign("challenge-token");
        await createConfiguredProduct({ baseProductId: BASE_PRODUCT_ID, designId: DESIGN_ID });
        expect(calls.map(({ url }) => url)).toEqual([
            "/api/design-drafts",
            "/api/configured-products",
        ]);
        const body = calls[1]?.body;
        expect(typeof body === "string" ? JSON.parse(body) : undefined).toEqual({
            baseProductId: BASE_PRODUCT_ID,
            designId: DESIGN_ID,
            expectedVersion: 3,
        });
    });
    it("refreshes the draft version when the first product finalizes the design", async () => {
        forgetDesignVersion(DESIGN_ID);
        const configuredBodies: unknown[] = [];
        let configurationAttempt = 0;
        vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string"
                ? input
                : input instanceof URL ? input.toString() : input.url;
            if (url === `/api/design-drafts/${DESIGN_ID}`) {
                return Promise.resolve(Response.json({
                    artworkRevision: "a".repeat(64),
                    artworkUrl: `/v1/designs/${DESIGN_ID}/artwork`,
                    contentType: "image/png",
                    createdAt: "2026-08-16T00:00:00.000Z",
                    finalized: true,
                    id: DESIGN_ID,
                    settings: {
                        cropX: 0.5,
                        cropY: 0.5,
                        cropZoom: 1,
                        depth: 5,
                        placementWidth: 0.22,
                        placementX: 0.39,
                        placementY: 0.43,
                    },
                    status: "ready",
                    updatedAt: "2026-08-16T00:00:00.000Z",
                    version: configurationAttempt === 0 ? 3 : 4,
                }));
            }
            if (url === "/api/configured-products") {
                configuredBodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
                configurationAttempt += 1;
                if (configurationAttempt === 1) {
                    return Promise.resolve(Response.json({}, { status: 409 }));
                }
                return Promise.resolve(Response.json({
                    baseProductId: BASE_PRODUCT_ID,
                    createdAt: "2026-08-16T00:00:00.000Z",
                    designId: DESIGN_ID,
                    designRevisionId: PRODUCT_ID,
                    id: PRODUCT_ID,
                    projectionVersion: "safe-margin-v1",
                    shopifyHandle: "bent-shirt",
                }, { status: 201 }));
            }
            throw new Error(`Unexpected request ${url}`);
        });
        await createConfiguredProduct({
            baseProductId: BASE_PRODUCT_ID,
            designId: DESIGN_ID,
        });
        expect(configuredBodies).toEqual([
            { baseProductId: BASE_PRODUCT_ID, designId: DESIGN_ID, expectedVersion: 3 },
            { baseProductId: BASE_PRODUCT_ID, designId: DESIGN_ID, expectedVersion: 4 },
        ]);
    });
});
