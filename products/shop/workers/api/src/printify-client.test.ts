import { describe, expect, it, vi } from "vitest";
import { makePrintifyClient, PrintifyContractError, PrintifyRateLimitError, } from "./printify-client";
const CONFIG = {
    PRINTIFY_API_TOKEN: "printify-token",
    PRINTIFY_SHOP_ID: "123",
};
describe("Printify catalogue client", () => {
    it("selects only exact Black and White front-print variants", async () => {
        const fetcher = catalogueFetcher({ availableIds: [101, 103] });
        const client = makePrintifyClient(CONFIG, fetcher, () => new Date("2026-08-23T00:00:00.000Z"));
        const catalogue = await client.loadStapleTeeCatalogue();
        expect(client.shopId).toBe("123");
        expect(catalogue).toMatchObject({
            blueprint: {
                brand: "AS Colour",
                id: 440,
                model: "5001",
            },
            blueprintId: 440,
            printProvider: { id: 34, title: "The Print Bar" },
            printProviderId: 34,
            retrievedAt: "2026-08-23T00:00:00.000Z",
            shop: {
                id: 123,
                salesChannel: "custom_integration",
                title: "bent.shop",
            },
            variants: [
                {
                    available: false,
                    color: "Black",
                    decorationMethod: "dtg",
                    id: 102,
                    printHeight: 4200,
                    printWidth: 3600,
                    size: "M",
                    standardShippingToAustralia: {
                        additionalItems: { amount: 139, currency: "USD" },
                        firstItem: { amount: 639, currency: "USD" },
                        handlingDaysFrom: 3,
                        handlingDaysTo: 6,
                    },
                },
                {
                    available: true,
                    color: "Black",
                    id: 101,
                    size: "S",
                },
                {
                    available: false,
                    color: "White",
                    id: 106,
                    size: "M",
                },
                {
                    available: true,
                    color: "White",
                    id: 103,
                    size: "S",
                },
            ],
        });
        expect(catalogue.variants.some(({ id }) => id === 104)).toBe(false);
        expect(catalogue.variants.some(({ id }) => id === 105)).toBe(false);
        expect(fetcher).toHaveBeenCalledTimes(6);
        for (const call of fetcher.mock.calls) {
            expect(call[1]?.headers).toEqual({
                Accept: "application/json",
                Authorization: "Bearer printify-token",
                "User-Agent": "bent.shop",
            });
            expect(call[1]?.redirect).toBe("manual");
        }
    });
    it("rejects a provider identity mismatch", async () => {
        const fetcher = catalogueFetcher({ providerTitle: "Another Provider" });
        await expect(makePrintifyClient(CONFIG, fetcher).loadStapleTeeCatalogue())
            .rejects.toThrow("provider 34 is not The Print Bar");
    });
    it("rejects a configured shop that is not available to the token", async () => {
        const fetcher = catalogueFetcher({ shopId: 456 });
        await expect(makePrintifyClient(CONFIG, fetcher).loadStapleTeeCatalogue())
            .rejects.toThrow("configured Printify shop is not available");
    });
    it("rejects duplicate colour and size mappings", async () => {
        const duplicate = variant(106, "Black", "S");
        const fetcher = catalogueFetcher({ extraVariants: [duplicate] });
        await expect(makePrintifyClient(CONFIG, fetcher).loadStapleTeeCatalogue())
            .rejects.toBeInstanceOf(PrintifyContractError);
    });
    it("loads the exact Cotton Tote colours, one-size shape, and DTG geometry", async () => {
        const catalogues = await makePrintifyClient(CONFIG, catalogueFetcher(), () => new Date("2026-08-23T00:00:00.000Z")).loadLaunchCatalogues();
        expect(catalogues).toHaveLength(2);
        expect(catalogues[1]).toMatchObject({
            baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97",
            baseProductSlug: "cotton-tote",
            blueprint: { brand: "AS Colour", id: 553, model: "1001" },
            blueprintId: 553,
            printProviderId: 34,
            variants: [
                {
                    color: "Black",
                    decorationMethod: "dtg",
                    id: 70603,
                    printHeight: 3425,
                    printWidth: 2835,
                    size: "One size",
                },
                {
                    color: "Cream",
                    decorationMethod: "dtg",
                    id: 70646,
                    printHeight: 3425,
                    printWidth: 2835,
                    size: "One size",
                },
            ],
        });
    });
    it("preserves size-dependent shirt print geometry", async () => {
        const catalogue = await makePrintifyClient(CONFIG, catalogueFetcher({ shirtSizeGeometry: true })).loadStapleTeeCatalogue();
        expect(catalogue.variants.map(({ color, printHeight, printWidth, size }) => ({
            color,
            printHeight,
            printWidth,
            size,
        }))).toEqual([
            { color: "Black", printHeight: 4690, printWidth: 4150, size: "M" },
            { color: "Black", printHeight: 4089, printWidth: 3619, size: "S" },
            { color: "White", printHeight: 4690, printWidth: 4150, size: "M" },
            { color: "White", printHeight: 4089, printWidth: 3619, size: "S" },
        ]);
        expect(catalogue.printGeometries).toEqual([
            {
                decorationMethod: "dtg",
                printHeight: 4089,
                printWidth: 3619,
                sizes: ["S"],
            },
            {
                decorationMethod: "dtg",
                printHeight: 4690,
                printWidth: 4150,
                sizes: ["M"],
            },
        ]);
    });
    it("rejects conflicting front-print geometry for the same size", async () => {
        await expect(makePrintifyClient(CONFIG, catalogueFetcher({ toteGeometryMismatch: true })).loadLaunchCatalogues()).rejects.toThrow("conflicting front-DTG geometry for cotton-tote / One size");
    });
    it("keeps Printify rate limiting distinct from invalid responses", async () => {
        const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, {
            headers: { "retry-after": "17" },
            status: 429,
        })));
        const pending = makePrintifyClient(CONFIG, fetcher).loadStapleTeeCatalogue();
        await expect(pending).rejects.toMatchObject({
            retryAfterSeconds: 17,
        });
        await expect(pending).rejects.toBeInstanceOf(PrintifyRateLimitError);
    });
});
function catalogueFetcher(options: {
    availableIds?: readonly number[];
    extraVariants?: readonly Record<string, unknown>[];
    providerTitle?: string;
    shirtSizeGeometry?: boolean;
    shopId?: number;
    toteGeometryMismatch?: boolean;
} = {}) {
    const allVariants = [
        variantWithGeometry(101, "Black", "S", options.shirtSizeGeometry ? 3619 : 3600, options.shirtSizeGeometry ? 4089 : 4200),
        variantWithGeometry(102, "Black", "M", options.shirtSizeGeometry ? 4150 : 3600, options.shirtSizeGeometry ? 4690 : 4200),
        variant(103, "White", "S", "front_dtf", options.shirtSizeGeometry),
        variant(104, "Navy", "S"),
        variant(105, "White", "M", "back"),
        variant(106, "White", "M", "front", options.shirtSizeGeometry),
        ...(options.extraVariants ?? []),
    ];
    const toteVariants = [
        variantWithGeometry(70603, "Black", "One size", 2835, 3425),
        variantWithGeometry(70646, "Cream", "One size", options.toteGeometryMismatch ? 2834 : 2835, 3425),
    ];
    const availableIds = new Set(options.availableIds ?? [101, 102, 103, 70603, 70646]);
    return vi.fn<typeof fetch>((input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const tote = url.pathname.includes("/blueprints/553");
        const productVariants = tote ? toteVariants : allVariants;
        if (url.pathname.endsWith("/shops.json")) {
            return Promise.resolve(Response.json([{
                    id: options.shopId ?? 123,
                    sales_channel: "custom_integration",
                    title: "bent.shop",
                }]));
        }
        if (url.pathname.endsWith("/blueprints/440.json") ||
            url.pathname.endsWith("/blueprints/553.json")) {
            return Promise.resolve(Response.json({
                brand: "AS Colour",
                id: tote ? 553 : 440,
                model: tote ? "1001" : "5001",
                title: tote ? "Cotton Tote" : "Adult Staple Tee",
            }));
        }
        if (url.pathname.endsWith("/print_providers.json")) {
            return Promise.resolve(Response.json([{
                    id: 34,
                    title: options.providerTitle ?? "The Print Bar",
                }]));
        }
        if (url.pathname.endsWith("/variants.json")) {
            const payload = url.searchParams.get("show-out-of-stock") === "1"
                ? productVariants
                : productVariants.filter((item) => typeof item["id"] === "number" && availableIds.has(item["id"]));
            return Promise.resolve(Response.json({
                id: 34,
                title: "The Print Bar",
                variants: payload,
            }));
        }
        if (url.pathname.endsWith("/shipping/standard.json")) {
            return Promise.resolve(Response.json({
                data: productVariants.flatMap((item) => {
                    const id = item["id"];
                    return typeof id === "number" ? [shippingEntry(id), shippingEntry(id)] : [];
                }),
            }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
    });
}
function shippingEntry(variantId: number): Record<string, unknown> {
    return {
        attributes: {
            country: { code: "AU" },
            handlingTime: { from: 3, to: 6 },
            shippingCost: {
                additionalItems: { amount: 139, currency: "USD" },
                firstItem: { amount: 639, currency: "USD" },
            },
            shippingType: "standard",
            variantId,
        },
        id: String(variantId),
        type: "variant_shipping_standard_au",
    };
}
function variant(id: number, color: string, size: string, position = "front", sizeGeometry = false): Record<string, unknown> {
    const small = size === "S";
    return {
        id,
        options: { color, size },
        placeholders: [{
                decoration_method: "dtg",
                height: sizeGeometry ? (small ? 4089 : 4690) : 4200,
                position,
                width: sizeGeometry ? (small ? 3619 : 4150) : 3600,
            }],
        title: `${color} / ${size}`,
    };
}
function variantWithGeometry(id: number, color: string, size: string, width: number, height: number): Record<string, unknown> {
    return {
        id,
        options: { color, size },
        placeholders: [{
                decoration_method: "dtg",
                height,
                position: "front",
                width,
            }],
        title: `${color} / ${size}`,
    };
}
