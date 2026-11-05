import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProbe } from "./artwork-preview-benchmark.mjs";
import { assertEarlyPreview, benchmarkLossless, comparePreviews, comparePrintSources } from "./artwork-preview-benchmark/metrics.mjs";
import { canContinue, createPreviewState, transitionPreview } from "./artwork-preview-benchmark/state.mjs";

test("the timing assertion rejects today's print-blocked preview", () => {
  assert.throws(() => assertEarlyPreview([{ name: "print-ready", elapsedMs: 20000 },
    { name: "final-preview", elapsedMs: 21000 }]), /not delivered before/);
  assert.deepEqual(assertEarlyPreview([{ name: "early-preview", elapsedMs: 3000 },
    { name: "print-ready", elapsedMs: 20000 }]), { earlyMs: 3000, printMs: 20000, headStartMs: 17000 });
});

test("final replacement preserves edits and stale uploads cannot replace the current preview", () => {
  let state = createPreviewState("upload-2", { cropX: 0.5, depth: 5 });
  state = transitionPreview(state, { type: "early", revision: "upload-2", preview: "small" });
  assert.equal(canContinue(state), false);
  state = transitionPreview(state, { type: "settings", revision: "upload-2", settings: { cropX: 0.7, depth: 0 } });
  assert.equal(transitionPreview(state, { type: "final", revision: "upload-1", preview: "stale" }), state);
  state = transitionPreview(state, { type: "final", revision: "upload-2", preview: "final" });
  assert.deepEqual(state.settings, { cropX: 0.7, depth: 0 });
  assert.equal(canContinue(state), true);
  assert.equal(transitionPreview(state, { type: "early", revision: "upload-2", preview: "late-small" }), state);
});

test("print failure preserves the editable image and settings while blocking Continue", () => {
  const initial = createPreviewState("upload", { cropZoom: 1.3 });
  const early = transitionPreview(initial, { type: "early", revision: "upload", preview: "small" });
  const failed = transitionPreview(early, { type: "failure", revision: "upload", message: "retry" });
  assert.equal(failed.preview, "small");
  assert.deepEqual(failed.settings, initial.settings);
  assert.equal(canContinue(failed), false);
});

test("pixel comparisons detect alpha loss and changed print dimensions", async () => {
  const source = await sharp({ create: { width: 6, height: 8, channels: 4,
    background: { r: 60, g: 120, b: 180, alpha: 0.5 } } }).png().toBuffer();
  const opaque = await sharp(source).flatten({ background: "white" }).png().toBuffer();
  const reduced = await sharp(source).resize(3, 4).png().toBuffer();
  assert.equal((await comparePrintSources(source, source)).identicalPixels, true);
  assert.equal((await comparePrintSources(source, reduced)).sameDimensions, false);
  assert.equal((await comparePrintSources(source, opaque)).identicalPixels, false);
  assert.ok((await comparePreviews(source, opaque)).changedAlphaFraction > 0.99);
});

test("every lossless candidate retains colour and alpha including transparent pixels", async () => {
  const source = await sharp(Buffer.from([20, 40, 80, 0, 150, 100, 50, 128, 255, 40, 100, 255]),
    { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const results = await benchmarkLossless(source, 1);
  assert.equal(results.length, 7);
  assert.ok(results.every(result => result.exact));
});

test("removing a redundant opaque alpha channel is pixel-equivalent", async () => {
  const source = await sharp(Buffer.from([20, 40, 80, 255, 150, 100, 50, 255]),
    { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  assert.ok((await benchmarkLossless(source, 1)).every(result => result.exact));
});

test("a truncated or malformed measurement cannot be reported as a completed probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artwork-probe-test-"));
  try {
    await assert.rejects(readProbe(new Response(""), directory), /did not complete/);
    await assert.rejects(readProbe(new Response(JSON.stringify({ name: "../outside", elapsedMs: 0 }) + "\n"), directory), /Invalid probe event/);
    await assert.rejects(readProbe(new Response(JSON.stringify({ name: "print-ready", elapsedMs: 0, bytes: 100, base64: "AA==" }) + "\n"), directory), /Invalid probe image length/);
    await assert.rejects(readProbe(new Response(JSON.stringify({ name: "complete", elapsedMs: 10 }) + "\n"), directory), /did not complete/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
