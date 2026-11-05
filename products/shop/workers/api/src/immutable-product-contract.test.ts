import { protectedConfig } from "./protected-config";
import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import { ConfiguredProductRevisionSnapshotSchema } from "@forever-tee/contracts";
const snapshot = {
    configuredProductId: "47cba7a2-498e-44cc-9769-b37641e6a63a",
    baseProductId: "a51b7acf-77e9-4762-83c4-62d96dd8942c",
    baseProductSlug: "staple-tee",
    designId: protectedConfig("resource_83abf907850d"),
    designRevisionId: "59ccdb2a-21d7-4018-9f21-6d369cc69e54",
    placement: { x: 0.39, y: 0.43, width: 0.22, depth: 5 },
    projectionVersion: "safe-margin-v1",
    artworkSha256: "a".repeat(64),
    contentType: "image/png",
    byteSize: 4,
    shopifyHandle: "bent-shirt",
    artworkUrl: "/v2/internal/design-revisions/59ccdb2a-21d7-4018-9f21-6d369cc69e54/artwork",
};
describe("immutable configured-product contract", () => {
    it("decodes the complete immutable snapshot", () => {
        expect(Schema.decodeUnknownSync(ConfiguredProductRevisionSnapshotSchema)(snapshot)).toEqual(snapshot);
    });
    it("rejects nullable revisions and malformed artwork integrity metadata", () => {
        const nullRevision = Schema.decodeUnknownEither(ConfiguredProductRevisionSnapshotSchema)({ ...snapshot, designRevisionId: null });
        const invalidSha = Schema.decodeUnknownEither(ConfiguredProductRevisionSnapshotSchema)({ ...snapshot, artworkSha256: "not-a-sha" });
        const emptyArtwork = Schema.decodeUnknownEither(ConfiguredProductRevisionSnapshotSchema)({ ...snapshot, byteSize: 0 });
        const unsafeContentType = Schema.decodeUnknownEither(ConfiguredProductRevisionSnapshotSchema)({ ...snapshot, contentType: "text/html" });
        const offCanvasPlacement = Schema.decodeUnknownEither(ConfiguredProductRevisionSnapshotSchema)({ ...snapshot, placement: { x: 0.8, y: 0.4, width: 0.3, depth: 5 } });
        expect(Either.isLeft(nullRevision)).toBe(true);
        expect(Either.isLeft(invalidSha)).toBe(true);
        expect(Either.isLeft(emptyArtwork)).toBe(true);
        expect(Either.isLeft(unsafeContentType)).toBe(true);
        expect(Either.isLeft(offCanvasPlacement)).toBe(true);
    });
});
