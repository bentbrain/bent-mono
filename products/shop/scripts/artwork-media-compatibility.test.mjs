import assert from "node:assert/strict";
import test from "node:test";
import { ARTWORK_MEDIA_CAPABILITY, assertArtworkMediaBundle, assertArtworkMediaWeb } from "./artwork-media-compatibility.mjs";

test("rollback rejects Worker and web artifacts predating owner media authorization", () => {
  assert.throws(() => assertArtworkMediaBundle(Buffer.from('"anonymous-drafts-v2"')), /Worker rollback/);
  assert.throws(() => assertArtworkMediaWeb({ id: "dpl_old" }), /Storefront rollback/);
  assertArtworkMediaBundle(Buffer.from(JSON.stringify(ARTWORK_MEDIA_CAPABILITY)));
  assertArtworkMediaWeb({ artworkMediaCapability: ARTWORK_MEDIA_CAPABILITY });
});
