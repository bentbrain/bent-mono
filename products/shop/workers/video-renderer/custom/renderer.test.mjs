import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { drawExportFrame, exportSceneAt, EXPORT_QUALITY, renderFeaturedVideo, stackLayout } from "./renderer.mjs";

async function fixture() {
  const canvas = createCanvas(100, 100), context = canvas.getContext("2d");
  const layers = [];
  for (const color of ["#ff0000", "#00ff00", "#0000ff"]) {
    context.fillStyle = color;
    context.fillRect(0, 0, 100, 100);
    layers.push({ artwork: await canvas.encode("png"), crop: { cropX: 0.5, cropY: 0.5, cropZoom: 1 },
      placement: { x: 0.3, y: 0.3, width: 0.4, depth: 1 } });
  }
  context.clearRect(0, 0, 100, 100);
  return { layers, baseProductSlug: "staple-tee", mockup: await canvas.encode("png") };
}

test("nests each featured cutout once even when stored recursion depth is one", async () => {
  const { layers, baseProductSlug } = await fixture();
  const layout = stackLayout(layers, baseProductSlug);
  assert.equal(layout.length, 3);
  assert.equal(layout[2].bounds.width, layout[0].bounds.width * 0.4 * 0.4);
  const opening = exportSceneAt(layout, 0), closing = exportSceneAt(layout, 8);
  assert.ok(1920 / (opening.scale * Math.max(layout[2].bounds.width, layout[2].bounds.height)) < 0.003,
    "Opening should show less than 0.3% of the innermost image.");
  assert.equal(closing.scale, 0.64);
  assert.equal(closing.x, 750);
  assert.equal(closing.y, 750);
  assert.deepEqual(exportSceneAt(layout, 3), closing);
  assert.deepEqual([EXPORT_QUALITY.width, EXPORT_QUALITY.height, EXPORT_QUALITY.frameRate], [2160, 3840, 60]);
});

test("composes different cutouts in the final stack, with selected design outermost", async () => {
  const input = await fixture();
  const layout = stackLayout(await Promise.all(input.layers.map(async layer => ({ ...layer, source: await loadImage(layer.artwork) }))), input.baseProductSlug);
  const canvas = createCanvas(1080, 1920), context = canvas.getContext("2d");
  drawExportFrame(context, { layout, mockup: await loadImage(input.mockup), websiteLabel: "shop.bent.build" }, 8,
    { ...EXPORT_QUALITY, width: 1080, height: 1920 });
  for (const [index, layer] of layout.entries()) {
    const x = Math.round(540 + (layer.bounds.x + layer.bounds.width * 0.5 - 750) * 0.64);
    const y = Math.round(960 + (layer.bounds.y + layer.bounds.height * 0.25 - 750) * 0.64);
    const pixel = [...context.getImageData(x, y, 1, 1).data];
    assert.equal(pixel[index], 255);
    assert.equal(pixel.filter(channel => channel === 255).length, 2);
  }
});

test("opening is a flat image patch with no recognisable cutouts or text", async () => {
  const input = await fixture();
  const loaded = await Promise.all(input.layers.map(async layer => ({ ...layer, source: await loadImage(layer.artwork) })));
  for (const layers of [loaded, Array.from({ length: 7 }, () => ({ ...loaded[2], placement: { x: 0.3, y: 0.3, width: 0.08 } }))]) {
    const canvas = createCanvas(108, 192), context = canvas.getContext("2d");
    drawExportFrame(context, { layout: stackLayout(layers, input.baseProductSlug), mockup: await loadImage(input.mockup), websiteLabel: "shop.bent.build" }, 0,
      { ...EXPORT_QUALITY, width: 108, height: 192 });
    const pixels = context.getImageData(0, 0, 108, 192).data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      assert.deepEqual([...pixels.subarray(offset, offset + 4)], [0, 0, 255, 255]);
    }
  }
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
test("encodes only an MP4 with complete frames and expected artwork colors", { skip: !hasFfmpeg }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "featured-render-test-"));
  try {
    const input = await fixture();
    const result = await renderFeaturedVideo({ ...input, outputDirectory: directory }, {
      ...EXPORT_QUALITY, width: 216, height: 384, frameRate: 10, duration: 2, zoomDuration: 1, mp4Preset: "ultrafast",
    });
    const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", result.mp4], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.deepEqual([stream.width, stream.height, stream.r_frame_rate, stream.nb_read_frames], [216, 384, "10/1", "20"]);
    const decoded = spawnSync("ffmpeg", ["-v", "error", "-sseof", "-0.1", "-i", result.mp4, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    const canvas = createCanvas(216, 384);
    const layout = stackLayout(await Promise.all(input.layers.map(async layer => ({ ...layer, source: await loadImage(layer.artwork) }))), input.baseProductSlug);
    drawExportFrame(canvas.getContext("2d"), { layout, mockup: await loadImage(input.mockup), websiteLabel: "shop.bent.build" }, 1.9,
      { ...EXPORT_QUALITY, width: 216, height: 384, zoomDuration: 1 });
    const expected = canvas.getContext("2d").getImageData(0, 0, 216, 384).data;
    assert.equal(decoded.stdout.length, expected.length);
    const meanError = decoded.stdout.reduce((total, value, index) => total + Math.abs(value - expected[index]), 0) / expected.length;
    assert.ok(meanError < 3, `Decoded MP4 colors changed: mean error ${meanError}`);
    assert.deepEqual(await readdir(directory), ["featured.mp4"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("encoder startup failure rejects and removes incomplete output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "featured-render-error-"));
  try {
    await assert.rejects(renderFeaturedVideo({ ...await fixture(), outputDirectory: directory }, {
      ...EXPORT_QUALITY, width: 108, height: 192, frameRate: 1, duration: 1,
    }, "/does-not-exist/ffmpeg"));
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("4K 60 fps export stays within Apple hardware decoder reference limits", { skip: !hasFfmpeg }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "featured-render-4k-test-"));
  try {
    const result = await renderFeaturedVideo({ ...await fixture(), outputDirectory: directory }, {
      ...EXPORT_QUALITY, duration: 0.25, zoomDuration: 0.2,
    });
    // The broken export advertised 16 reference frames at Level 6. Apple playback
    // failed with AVFoundation -11821 although a complete software decode passed.
    const headers = spawnSync("ffmpeg", ["-v", "info", "-i", result.mp4, "-c:v", "copy",
      "-bsf:v", "trace_headers", "-f", "null", "-"], { encoding: "utf8" });
    assert.equal(headers.status, 0, headers.stderr);
    const references = Number(/max_num_ref_frames\s+[01]+ = (\d+)/.exec(headers.stderr)?.[1]);
    assert.ok(references >= 1 && references <= 4, `Expected at most 4 reference frames; found ${references}`);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", result.mp4], { encoding: "utf8" });
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.deepEqual([stream.width, stream.height, stream.r_frame_rate, stream.level], [2160, 3840, "60/1", 52]);
    if (process.platform === "darwin") {
      const decoded = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-hwaccel", "videotoolbox", "-i", result.mp4, "-f", "null", "-"]);
      assert.equal(decoded.status, 0, decoded.stderr.toString());
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
