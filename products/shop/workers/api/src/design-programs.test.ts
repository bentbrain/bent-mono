import { protectedConfig } from "./protected-config";
import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { DesignSchema, type EditorSettingsDto, } from "@forever-tee/contracts";
import { DatabaseFailure, DesignNotFound } from "./design-errors";
import { artworkPreviewKey, DesignRepository, type DesignRepositoryShape, } from "./design-repository";
import { getDesign, uploadDesignArtwork } from "./design-programs";
const design = Schema.decodeSync(DesignSchema)({
    artworkRevision: "a".repeat(64),
    id: protectedConfig("resource_83abf907850d"),
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
    artworkUrl: "/v1/designs/" + protectedConfig("resource_83abf907850d") + "/artwork",
});
const repositoryLayer = (find: DesignRepositoryShape["find"]) => Layer.succeed(DesignRepository, {
    create: () => Effect.dieMessage("Not used by this test."),
    uploadArtwork: () => Effect.dieMessage("Not used by this test."),
    find,
    artwork: () => Effect.dieMessage("Not used by this test."),
    artworkPreview: () => Effect.dieMessage("Not used by this test."),
    updateSettings: () => Effect.dieMessage("Not used by this test."),
});
describe("getDesign", () => {
    it("returns a stored design", async () => {
        const result = await Effect.runPromise(getDesign(design.id).pipe(Effect.provide(repositoryLayer(() => Effect.succeed(design)))));
        expect(result).toEqual(design);
    });
    it("preserves a missing-design error", async () => {
        const error = await Effect.runPromise(getDesign(design.id).pipe(Effect.provide(repositoryLayer((id) => Effect.fail(new DesignNotFound({ id })))), Effect.flip));
        if (error._tag !== "DesignNotFound") {
            throw new Error(`Expected DesignNotFound, received ${error._tag}.`);
        }
        expect(error.id).toBe(design.id);
    });
    it("preserves a storage-unavailable error", async () => {
        const error = await Effect.runPromise(getDesign(design.id).pipe(Effect.provide(repositoryLayer(() => Effect.fail(new DatabaseFailure({
            operation: "read design",
            cause: new Error("D1 unavailable"),
        })))), Effect.flip));
        if (error._tag !== "DatabaseFailure") {
            throw new Error(`Expected DatabaseFailure, received ${error._tag}.`);
        }
        expect(error.operation).toBe("read design");
    });
});
describe("uploadDesignArtwork", () => {
    it("stores generated artwork without overwriting the latest editor settings", async () => {
        let receivedSettings: EditorSettingsDto | undefined = design.settings;
        const artwork = new Uint8Array([1, 2, 3]);
        const layer = Layer.succeed(DesignRepository, {
            create: () => Effect.dieMessage("Not used by this test."),
            uploadArtwork: (input) => {
                receivedSettings = input.settings;
                return Effect.succeed(design);
            },
            find: () => Effect.dieMessage("Not used by this test."),
            artwork: () => Effect.dieMessage("Not used by this test."),
            artworkPreview: () => Effect.dieMessage("Not used by this test."),
            updateSettings: () => Effect.dieMessage("Not used by this test."),
        });
        const result = await Effect.runPromise(uploadDesignArtwork(design.id, artwork, "image/png").pipe(Effect.provide(layer)));
        expect(result).toEqual(design);
        expect(receivedSettings).toBeUndefined();
    });
});
describe("artworkPreviewKey", () => {
    it("changes when replacement artwork has a new content hash", () => {
        const first = artworkPreviewKey(design.id, "first-hash");
        const replacement = artworkPreviewKey(design.id, "replacement-hash");
        expect(replacement).not.toBe(first);
    });
});
