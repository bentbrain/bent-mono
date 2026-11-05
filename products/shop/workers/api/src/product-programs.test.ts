import { protectedConfig } from "./protected-config";
import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { DesignSchema, ProductSchema, } from "@forever-tee/contracts";
import { DesignRepository, type DesignRepositoryShape, } from "./design-repository";
import { ProductNotFound } from "./product-errors";
import { ProductRepository, type ProductRepositoryShape, } from "./product-repository";
import { createConfiguredProduct, getProduct, getProductFamily, } from "./product-programs";
const baseProductId = "8f48ee90-08d8-4c6c-b369-0444a20ddd25";
const designId = protectedConfig("resource_83abf907850d");
const design = Schema.decodeSync(DesignSchema)({
    artworkRevision: "a".repeat(64),
    id: designId,
    status: "ready",
    contentType: "image/png",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    settings: {
        cropX: 0.5,
        cropY: 0.5,
        cropZoom: 1,
        placementX: 0.39,
        placementY: 0.43,
        placementWidth: 0.22,
        depth: 5,
    },
    artworkUrl: `/v1/designs/${designId}/artwork`,
});
const configuredProduct = Schema.decodeSync(ProductSchema)({
    id: "59ccdb2a-21d7-4018-9f21-6d369cc69e54",
    baseProductId,
    designId,
    designRevisionId: null,
    shopifyHandle: "bent-shirt",
    createdAt: "2026-08-13T00:01:00.000Z",
});
const revisionLinkedProduct = Schema.decodeSync(ProductSchema)({
    ...configuredProduct,
    designRevisionId: designId,
});
const legacyProductWithoutRevisionField = Schema.decodeSync(ProductSchema)({
    id: "96789e31-4b36-490b-9aec-a9b0ddd95a22",
    baseProductId,
    designId,
    shopifyHandle: "legacy-product",
    createdAt: "2026-08-13T00:00:00.000Z",
});
const designLayer = Layer.succeed(DesignRepository, {
    create: () => Effect.dieMessage("Not used by this test."),
    uploadArtwork: () => Effect.dieMessage("Not used by this test."),
    find: (id) => id === design.id
        ? Effect.succeed(design)
        : Effect.dieMessage("Unexpected design id."),
    artwork: () => Effect.dieMessage("Not used by this test."),
    artworkPreview: () => Effect.dieMessage("Not used by this test."),
    updateSettings: () => Effect.dieMessage("Not used by this test."),
} satisfies DesignRepositoryShape);
const productLayer = (repository: Pick<ProductRepositoryShape, "createConfigured" | "find"> & Partial<Pick<ProductRepositoryShape, "findFamily">>) => Layer.succeed(ProductRepository, {
    ...repository,
    findFamily: repository.findFamily ??
        (() => Effect.dieMessage("Not used by this test.")),
    findActiveRevisionSnapshot: () => Effect.dieMessage("Not used by this test."),
    findHistoricalRevisionSnapshot: () => Effect.dieMessage("Not used by this test."),
    findRevisionArtwork: () => Effect.dieMessage("Not used by this test."),
});
describe("product programs", () => {
    it("decodes both compatibility and revision-linked product contracts", () => {
        expect(configuredProduct.designRevisionId).toBeNull();
        expect(revisionLinkedProduct.designRevisionId).toBe(designId);
        expect(legacyProductWithoutRevisionField.designRevisionId).toBeNull();
        expect(legacyProductWithoutRevisionField.placement).toBeNull();
    });
    it("loads a product by its product UUID", async () => {
        const result = await Effect.runPromise(getProduct(configuredProduct.id).pipe(Effect.provide(productLayer({
            createConfigured: () => Effect.dieMessage("Not used by this test."),
            find: () => Effect.succeed(configuredProduct),
        }))));
        expect(result).toEqual(configuredProduct);
        expect(result.id).not.toBe(result.designId);
    });
    it("loads every configured product that shares a design", async () => {
        const tote = {
            ...configuredProduct,
            id: "2d4047c7-31b1-499c-bcb8-82ccaf393744",
            baseProductId: "97b629d7-1d3b-4d2a-a586-537168141e97",
            shopifyHandle: "cotton-tote",
        };
        const result = await Effect.runPromise(getProductFamily(configuredProduct.id).pipe(Effect.provide(productLayer({
            createConfigured: () => Effect.dieMessage("Not used by this test."),
            find: () => Effect.dieMessage("Not used by this test."),
            findFamily: () => Effect.succeed([configuredProduct, tote]),
        }))));
        expect(result).toEqual([configuredProduct, tote]);
    });
    it("creates a configured product only after resolving its design", async () => {
        const result = await Effect.runPromise(createConfiguredProduct(baseProductId, designId).pipe(Effect.provide(designLayer), Effect.provide(productLayer({
            createConfigured: (input) => Effect.sync(() => {
                expect(input).toEqual({ baseProductId, designId });
                return configuredProduct;
            }),
            find: () => Effect.dieMessage("Not used by this test."),
        }))));
        expect(result).toEqual(configuredProduct);
    });
    it("creates a configured product while print artwork is still processing", async () => {
        const creatingDesignLayer = Layer.succeed(DesignRepository, {
            create: () => Effect.dieMessage("Not used by this test."),
            uploadArtwork: () => Effect.dieMessage("Not used by this test."),
            find: () => Effect.succeed({ ...design, status: "creating" }),
            artwork: () => Effect.dieMessage("Not used by this test."),
            artworkPreview: () => Effect.dieMessage("Not used by this test."),
            updateSettings: () => Effect.dieMessage("Not used by this test."),
        } satisfies DesignRepositoryShape);
        const result = await Effect.runPromise(createConfiguredProduct(baseProductId, designId).pipe(Effect.provide(creatingDesignLayer), Effect.provide(productLayer({
            createConfigured: (input) => Effect.sync(() => {
                expect(input).toEqual({ baseProductId, designId });
                return configuredProduct;
            }),
            find: () => Effect.dieMessage("Not used by this test."),
        }))));
        expect(result).toEqual(configuredProduct);
    });
    it("preserves a missing-product error", async () => {
        const error = await Effect.runPromise(getProduct(baseProductId).pipe(Effect.provide(productLayer({
            createConfigured: () => Effect.dieMessage("Not used by this test."),
            find: (id) => Effect.fail(new ProductNotFound({ id })),
        })), Effect.flip));
        if (error._tag !== "ProductNotFound") {
            throw new Error(`Expected ProductNotFound, received ${error._tag}.`);
        }
        expect(error.id).toBe(baseProductId);
    });
});
