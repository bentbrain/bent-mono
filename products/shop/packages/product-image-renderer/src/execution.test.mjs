import test from "node:test";
import assert from "node:assert/strict";
import { boundedImageTransfer, parseProductImageEvent } from "./execution.mjs";

test("v5 HTTP event parsing keeps its existing wire compatibility", () => {
    const event = { jobId: "1".repeat(36), grant: "", rendererVersion: "product-images-v5", extra: "retained HTTP compatibility" };
    assert.deepEqual(parseProductImageEvent(event), { jobId: event.jobId, grant: "", rendererVersion: "product-images-v5" });
    for (const update of [{ jobId: "x".repeat(36) }, { jobId: "1".repeat(35) }, { grant: "x".repeat(1025) }, { rendererVersion: "product-images-v4" }])
        assert.equal(parseProductImageEvent({ ...event, ...update }), undefined);
});
test("bounded transfers consume the exact limit and cancel oversized streams", async () => {
    assert.deepEqual(await boundedImageTransfer(new Response(Buffer.alloc(2048, 7)), 2048), Buffer.alloc(2048, 7));
    let cancelled = false;
    const stream = new ReadableStream({
        start(controller) { controller.enqueue(Buffer.alloc(2048, 7)); controller.enqueue(Buffer.alloc(1, 8)); },
        cancel() { cancelled = true; },
    });
    await assert.rejects(boundedImageTransfer(new Response(stream), 2048), /exceeds limit/);
    assert.equal(cancelled, true);
    await assert.rejects(boundedImageTransfer(new Response(null, { status: 404 }), 2048), /unavailable/);
});
