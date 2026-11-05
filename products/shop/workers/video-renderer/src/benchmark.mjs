import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { renderStoryVideo } from "./renderer.mjs";

const root = resolve(import.meta.dirname, "../../..");
const outputDirectory = await mkdtemp(join(tmpdir(), "forever-tee-story-"));
const artwork = process.env.STORY_ARTWORK ?? "/tmp/forever-tee-saved-design.png";
const output = process.env.STORY_OUTPUT ?? join(outputDirectory, "render.mp4");
const mockup = process.env.STORY_MOCKUP ??
  resolve(root, "apps/web/public/mockups/tee-white-cutout-v1.png");

const result = await renderStoryVideo({
  artwork,
  baseProductSlug: "staple-tee",
  encoding: {
    crf: Number.parseInt(process.env.STORY_CRF ?? "21", 10),
    frameRate: Number.parseInt(process.env.STORY_FRAME_RATE ?? "30", 10),
    frameWidth: Number.parseInt(process.env.STORY_FRAME_WIDTH ?? "1080", 10),
  },
  mockup,
  preset: process.env.STORY_FFMPEG_PRESET ?? "medium",
  settings: {
    cropX: 0.47,
    cropY: 0.62,
    cropZoom: 1.06,
    depth: 5,
    placementWidth: 0.42,
    placementX: 0.3,
    placementY: 0.3,
  },
  websiteLabel: "shop.bent.build",
});
await writeFile(output, result.video);
console.info(JSON.stringify({
  bytes: result.video.byteLength,
  canvasTimeMs: result.canvasTimeMs,
  encoding: result.encoding,
  encoderDrainTimeMs: result.encoderDrainTimeMs,
  output,
  pipeTimeMs: result.pipeTimeMs,
  renderTimeMs: result.renderTimeMs,
  uniqueFrameCount: result.uniqueFrameCount,
}));
