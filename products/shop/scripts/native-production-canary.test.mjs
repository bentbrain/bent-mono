import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { verifyCanaryJobs, readCanaryArtwork, readCanaryResponse, canaryWebPath, canaryFailureStage, canaryArtworkKey } from "./native-production-canary.mjs";
import { syntheticProductionCanaryArtwork } from "./native-production-canary-source.mjs";
import { isProductionCanaryArtworkKey } from "./native-production-cloudflare.mjs";
test("Production canary requires exactly all four approved variants and one fenced attempt each", () => {
    const jobs = [["a51b7acf-77e9-4762-83c4-62d96dd8942c", "Black"], ["a51b7acf-77e9-4762-83c4-62d96dd8942c", "White"],
        ["97b629d7-1d3b-4d2a-a586-537168141e97", "Black"], ["97b629d7-1d3b-4d2a-a586-537168141e97", "Cream"]].map(([base_product_id, colour]) => ({ base_product_id, colour, status: "ready", attempt_count: 1, execution_id: "fixture", output_byte_size: 100 }));
    verifyCanaryJobs(jobs);
    for (const mutate of [values => { values.pop(); }, values => { values[0] = values[1]; }, values => { values[0].status = "failed"; },
        values => { values[0].attempt_count = 2; }, values => { values[0].execution_id = null; }, values => { values[0].output_byte_size = 0; }]) {
        const copy = structuredClone(jobs);
        mutate(copy);
        assert.throws(() => verifyCanaryJobs(copy));
    }
});
test("canary artwork reads enforce exact byte count and checksum", async () => {
    const bytes = Buffer.from("fixture"), source = { byte_size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    assert.deepEqual(await readCanaryArtwork(new Response(bytes), source), bytes);
    await assert.rejects(readCanaryArtwork(new Response(Buffer.from("too-large")), source));
    await assert.rejects(readCanaryArtwork(new Response(Buffer.from("bad")), source));
    await assert.rejects(readCanaryArtwork(new Response(bytes), { ...source, sha256: "a".repeat(64) }));
});
test("family response evidence is parsed only inside a fixed byte bound", async () => {
    assert.deepEqual(await readCanaryResponse(Response.json({ code: "PRODUCT_PROJECTION_UNSAFE" })), {
        bytes: Buffer.from('{"code":"PRODUCT_PROJECTION_UNSAFE"}'), value: { code: "PRODUCT_PROJECTION_UNSAFE" },
    });
    await assert.rejects(readCanaryResponse(new Response(Buffer.alloc(65537))));
    await assert.rejects(readCanaryResponse(new Response("not-json")));
});
test("synthetic PNG fixture is deterministic, bounded and reads no customer data", () => {
    const { bytes, source } = syntheticProductionCanaryArtwork();
    assert.deepEqual(syntheticProductionCanaryArtwork(), { bytes, source });
    assert.equal(source.customerArtworkRead, false);
    assert.equal(source.artwork_width, 2400);
    assert.equal(source.artwork_height, 3000);
    assert.ok(source.artwork_width >= 2333 && source.artwork_height >= 2923);
    assert.equal(bytes.readUInt32BE(16), 2400);
    assert.equal(bytes.readUInt32BE(20), 3000);
    assert.equal(bytes[25], 6);
    assert.equal(bytes.subarray(37, 41).toString(), "IDAT");
    const pixels = inflateSync(bytes.subarray(41, 41 + bytes.readUInt32BE(33)));
    assert.equal(pixels.length, 3000 * 9601);
    assert.equal(pixels[4], 0);
    assert.equal(pixels[375 * 9601 + 1 + 300 * 4 + 3], 220);
    assert.ok(source.byte_size < 250000);
});
test("canary BFF mapping admits only the fixed family, video and stream routes", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(canaryWebPath("/v2/configured-product-families"), "/api/configured-product-families");
    assert.equal(canaryWebPath(`/v2/internal/configured-products/${id}/story-video-events`), `/api/configured-product-video/${id}/events`);
    assert.equal(canaryWebPath(`/v2/internal/configured-products/${id}/story-videos/black`), `/api/configured-product-video/${id}/black.mp4`);
    assert.throws(() => canaryWebPath("/v2/design-drafts/other"));
});
test("each failed retry receives a distinct release-event stage", () => {
    assert.equal(canaryFailureStage("33222733106"), "canary-failed-ddccchddbag");
    assert.notEqual(canaryFailureStage("33222733106"), canaryFailureStage("33222733107"));
    assert.throws(() => canaryFailureStage("retry"));
});
test("canary artwork uses the immutable production print-source key", () => {
    const id = "11111111-1111-4111-8111-111111111111", digest = "a".repeat(64);
    assert.equal(canaryArtworkKey(id, digest), `designs/${id}/artwork/${digest}`);
    assert.throws(() => canaryArtworkKey(id, "not-a-digest"));
    const source = syntheticProductionCanaryArtwork().source;
    assert.equal(isProductionCanaryArtworkKey(canaryArtworkKey(id, source.sha256)), true);
    assert.equal(isProductionCanaryArtworkKey(`designs/${id}/native-production-canary.png`), false);
    assert.equal(isProductionCanaryArtworkKey(canaryArtworkKey(id, digest)), false);
});
