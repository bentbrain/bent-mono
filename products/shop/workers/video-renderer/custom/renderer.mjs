import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import {
  cubicBezierProgress, DEFAULT_STORY_MOTION, STORY_CALL_TO_ACTION,
  STORY_FONT_FAMILY, storyArtworkBounds, storyCursorVisibleAt,
} from "../src/geometry.mjs";

export const EXPORT_QUALITY = Object.freeze({
  width: 2160, height: 3840, frameRate: 60, duration: 8, zoomDuration: 3,
  mp4Crf: 14, mp4Preset: "veryslow",
});

if (!GlobalFonts.registerFromPath(fileURLToPath(import.meta.resolve(
  "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
)), STORY_FONT_FAMILY)) throw new Error("Could not load the story font.");

export function stackLayout(layers, baseProductSlug) {
  if (layers.length < 1 || layers.length > 7) throw new Error("Expected one to seven cutouts.");
  let bounds = storyArtworkBounds(baseProductSlug);
  return layers.map(layer => {
    const positioned = { ...layer, bounds };
    const p = layer.placement;
    bounds = { x: bounds.x + p.x * bounds.width, y: bounds.y + p.y * bounds.height,
      width: bounds.width * p.width, height: bounds.height * p.width };
    return positioned;
  });
}

export function exportSceneAt(layout, timestamp, quality = EXPORT_QUALITY) {
  const inner = layout.at(-1).bounds;
  // Start inside a tiny patch of the innermost image, before any cutout is recognisable.
  const openingScale = 900 * 1024 / Math.max(inner.width, inner.height);
  const progress = Math.min(Math.max(timestamp / quality.zoomDuration, 0), 1);
  const eased = cubicBezierProgress(progress, DEFAULT_STORY_MOTION.easing);
  const scale = Math.exp(Math.log(openingScale) * (1 - eased) + Math.log(0.64) * eased);
  // Centre the innermost cutout initially, then settle on the whole garment.
  // Inverse scale keeps the camera over the small stack until the garment enters view.
  const pan = (1 / scale - 1 / openingScale) / (1 / 0.64 - 1 / openingScale);
  return { scale, x: (inner.x + inner.width / 2) * (1 - pan) + 750 * pan,
    y: (inner.y + inner.height / 2) * (1 - pan) + 750 * pan };
}

function drawCutout(context, layer) {
  const { source, crop, bounds } = layer;
  const scale = Math.min(bounds.width / source.width, bounds.height / source.height) * crop.cropZoom;
  const width = source.width * scale, height = source.height * scale;
  context.save();
  context.beginPath();
  context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  context.clip();
  context.drawImage(source, bounds.x + bounds.width / 2 - crop.cropX * width,
    bounds.y + bounds.height / 2 - crop.cropY * height, width, height);
  context.restore();
}

export function drawExportFrame(context, { layout, mockup, websiteLabel }, timestamp, quality = EXPORT_QUALITY) {
  context.save();
  context.scale(quality.width / 1080, quality.height / 1920);
  context.fillStyle = "#0647ff";
  context.fillRect(0, 0, 1080, 1920);
  context.fillStyle = "#ffffff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `400 46px "${STORY_FONT_FAMILY}"`;
  context.fillText(STORY_CALL_TO_ACTION, 540, 1475, 960);
  context.fillText(websiteLabel, 540, 1545, 960);
  if (storyCursorVisibleAt(timestamp)) {
    context.fillRect(540 + context.measureText(websiteLabel).width / 2 + 6, 1521, 3, 48);
  }
  const camera = exportSceneAt(layout, timestamp, quality);
  context.translate(540, 960);
  context.scale(camera.scale, camera.scale);
  context.translate(-camera.x, -camera.y);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(mockup, 0, 0, 1500, 1500);
  for (const layer of layout) drawCutout(context, layer);
  context.restore();
}

function encoder(args, executable) {
  const process = spawn(executable, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let errors = "";
  process.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-8000); });
  // A closed encoder pipe must reject the frame write, not crash the process.
  process.stdin.on("error", () => {});
  const completion = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", code => code === 0 ? resolve() :
      reject(new Error(`FFmpeg failed (${String(code)}): ${errors}`)));
  });
  void completion.catch(() => {});
  return { process, completion };
}

export async function renderFeaturedVideo({
  layers, baseProductSlug, mockup, outputDirectory, websiteLabel = "shop.bent.build",
}, quality = EXPORT_QUALITY, executable = "ffmpeg") {
  const loaded = await Promise.all(layers.map(async layer => ({ ...layer, source: await loadImage(layer.artwork) })));
  const assets = { layout: stackLayout(loaded, baseProductSlug), mockup: await loadImage(mockup), websiteLabel };
  const canvas = createCanvas(quality.width, quality.height);
  const context = canvas.getContext("2d");
  await mkdir(outputDirectory, { recursive: true });
  const mp4 = join(outputDirectory, "featured.mp4");
  const frameCount = Math.round(quality.duration * quality.frameRate);
  let active;
  try {
    active = encoder(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${quality.width}x${quality.height}`,
      "-framerate", String(quality.frameRate), "-i", "pipe:0", "-an", "-c:v", "libx264",
      "-preset", quality.mp4Preset, "-crf", String(quality.mp4Crf),
      // veryslow defaults to 16 references, which breaks Apple hardware decoding
      // at 4K. Four references fit Level 5.2 while retaining 4K/60 and CRF 14.
      "-refs", "4", "-profile:v", "high", "-level:v", "5.2", "-pix_fmt", "yuv420p",
      "-threads", "2", "-movflags", "+faststart", "-y", mp4], executable);
    for (let frame = 0; frame < frameCount; frame++) {
      drawExportFrame(context, assets, frame / quality.frameRate, quality);
      await Promise.race([
        new Promise((resolve, reject) => active.process.stdin.write(canvas.data(), error => error ? reject(error) : resolve())),
        active.completion.then(() => { throw new Error("FFmpeg exited before all frames were written."); }),
      ]);
    }
    active.process.stdin.end();
    await active.completion;
    return { mp4, frameCount, quality };
  } catch (error) {
    if (active && active.process.exitCode === null) active.process.kill("SIGKILL");
    if (active) await active.completion.catch(() => {});
    await rm(mp4, { force: true });
    throw error;
  }
}
