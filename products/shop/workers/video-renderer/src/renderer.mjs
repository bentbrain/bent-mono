import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

import {
  DEFAULT_STORY_MOTION,
  STORY_CALL_TO_ACTION,
  STORY_DURATION_SECONDS,
  STORY_FONT_FAMILY,
  STORY_FRAME_HEIGHT,
  STORY_FRAME_RATE,
  STORY_FRAME_WIDTH,
  storyArtworkBounds,
  storyCursorVisibleAt,
  storySceneAt,
} from "./geometry.mjs";

const PRODUCT_SCENE_SIZE = 1_500;
const VIDEO_BACKGROUND = "#0647ff";
const VIDEO_FOREGROUND = "#ffffff";
const STORY_CALL_TO_ACTION_Y = 1_475;
const STORY_WEBSITE_LABEL_Y = 1_545;
const STORY_TEXT_SIZE = 46;
const STORY_CURSOR_HEIGHT = 48;
const STORY_CURSOR_WIDTH = 3;

const geistMonoPath = fileURLToPath(import.meta.resolve(
  "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
));
if (!GlobalFonts.registerFromPath(geistMonoPath, STORY_FONT_FAMILY)) {
  throw new Error("The story-video font could not be registered.");
}

function drawSourceInsideBounds(context, source, settings, bounds) {
  const containScale = Math.min(
    bounds.width / source.width,
    bounds.height / source.height,
  );
  const scale = containScale * settings.cropZoom;
  const width = source.width * scale;
  const height = source.height * scale;
  context.save();
  context.beginPath();
  context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  context.clip();
  context.drawImage(
    source,
    bounds.x + bounds.width / 2 - settings.cropX * width,
    bounds.y + bounds.height / 2 - settings.cropY * height,
    width,
    height,
  );
  context.restore();
}

export function drawRecursiveArtwork(context, source, settings, bounds, depth, recursiveSource = source, recursiveCrop, recursivePlacement) {
  drawSourceInsideBounds(context, source, settings, bounds);
  if (depth <= 0) return;
  const placementWidth = settings.placementWidth * bounds.width;
  drawRecursiveArtwork(
    context,
    recursiveSource,
    { ...settings, ...recursiveCrop, ...recursivePlacement },
    {
      height: placementWidth * (bounds.height / bounds.width),
      width: placementWidth,
      x: bounds.x + settings.placementX * bounds.width,
      y: bounds.y + settings.placementY * bounds.height,
    },
    depth - 1,
    recursiveSource,
    recursiveCrop,
    recursivePlacement,
  );
}

function drawFrame(context, assets, timestamp) {
  const scene = storySceneAt(assets.settings, timestamp, assets.motion, assets.recursivePlacement);
  const worldFocusX = assets.artworkBounds.x +
    scene.recursionFocusX * assets.artworkBounds.width;
  const worldFocusY = assets.artworkBounds.y +
    scene.recursionFocusY * assets.artworkBounds.height;

  context.fillStyle = VIDEO_BACKGROUND;
  context.fillRect(0, 0, STORY_FRAME_WIDTH, STORY_FRAME_HEIGHT);
  context.fillStyle = VIDEO_FOREGROUND;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `400 ${String(STORY_TEXT_SIZE)}px "${STORY_FONT_FAMILY}"`;
  context.fillText(
    STORY_CALL_TO_ACTION,
    STORY_FRAME_WIDTH / 2,
    STORY_CALL_TO_ACTION_Y,
    960,
  );
  context.fillText(
    assets.websiteLabel,
    STORY_FRAME_WIDTH / 2,
    STORY_WEBSITE_LABEL_Y,
    960,
  );
  if (
    timestamp < assets.motion.zoomDurationSeconds &&
    storyCursorVisibleAt(timestamp)
  ) {
    const labelWidth = context.measureText(assets.websiteLabel).width;
    context.fillRect(
      STORY_FRAME_WIDTH / 2 + labelWidth / 2 + 6,
      STORY_WEBSITE_LABEL_Y - STORY_CURSOR_HEIGHT / 2,
      STORY_CURSOR_WIDTH,
      STORY_CURSOR_HEIGHT,
    );
  }

  context.save();
  context.translate(scene.focalScreenX, scene.focalScreenY);
  context.scale(scene.cameraScale, scene.cameraScale);
  context.translate(-worldFocusX, -worldFocusY);
  context.drawImage(assets.mockup, 0, 0, PRODUCT_SCENE_SIZE, PRODUCT_SCENE_SIZE);
  drawRecursiveArtwork(
    context,
    assets.source,
    assets.settings,
    assets.artworkBounds,
    assets.settings.depth,
    assets.recursiveSource,
    assets.recursiveCrop,
    assets.recursivePlacement,
  );
  context.restore();
}

export function storyCursorBlinkExpression(startSeconds) {
  return `gte(t\\,${String(startSeconds)})*lt(mod(t\\,1)\\,0.5)`;
}

export function storyVideoFilters({
  cursorPosition, cursorStartSeconds, holdDurationSeconds, frameWidth, frameHeight,
  scaleBeforeHold = false,
}) {
  const needsScale = frameWidth !== STORY_FRAME_WIDTH || frameHeight !== STORY_FRAME_HEIGHT;
  if (scaleBeforeHold && needsScale) {
    const scaleX = STORY_FRAME_WIDTH / frameWidth;
    const scaleY = STORY_FRAME_HEIGHT / frameHeight;
    return {
      filters: [
        `[0:v]scale=${String(STORY_FRAME_WIDTH)}:${String(STORY_FRAME_HEIGHT)}:flags=lanczos[scaled]`,
        `[scaled]tpad=stop_mode=clone:stop_duration=${String(holdDurationSeconds)}[held]`,
        `[1:v]scale=iw*${String(scaleX)}:ih*${String(scaleY)}:flags=lanczos[cursor]`,
        `[held][cursor]overlay=${String(Math.round(cursorPosition.x * scaleX))}:` +
          `${String(Math.round(cursorPosition.y * scaleY))}` +
          `:enable='${storyCursorBlinkExpression(cursorStartSeconds)}':shortest=1[composed]`,
      ],
      outputLabel: "composed",
    };
  }
  const filters = [
    `[0:v]tpad=stop_mode=clone:stop_duration=${String(holdDurationSeconds)}[held]`,
    `[held][1:v]overlay=${String(cursorPosition.x)}:${String(cursorPosition.y)}` +
      `:enable='${storyCursorBlinkExpression(cursorStartSeconds)}'` +
      ":shortest=1[composed]",
  ];
  let outputLabel = "composed";
  if (needsScale) {
    filters.push(
      `[composed]scale=${String(STORY_FRAME_WIDTH)}:` +
        `${String(STORY_FRAME_HEIGHT)}:flags=lanczos[video]`,
    );
    outputLabel = "video";
  }
  return { filters, outputLabel };
}

function ffmpegProcess(
  outputPath,
  cursorPath,
  cursorPosition,
  cursorStartSeconds,
  preset,
  holdDurationSeconds,
  { crf, frameHeight, frameRate, frameWidth },
  scaleBeforeHold,
) {
  const { filters, outputLabel } = storyVideoFilters({
    cursorPosition, cursorStartSeconds, holdDurationSeconds,
    frameWidth, frameHeight, scaleBeforeHold,
  });
  return spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    `${String(frameWidth)}x${String(frameHeight)}`,
    "-framerate",
    String(frameRate),
    "-i",
    "pipe:0",
    "-loop",
    "1",
    "-framerate",
    String(frameRate),
    "-i",
    cursorPath,
    "-filter_complex",
    filters.join(";"),
    "-map",
    `[${outputLabel}]`,
    "-t",
    String(STORY_DURATION_SECONDS),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ], { stdio: ["pipe", "ignore", "pipe"] });
}

async function prepareCursor(context, encoding, workingDirectory, websiteLabel) {
  context.font = `400 ${String(STORY_TEXT_SIZE)}px "${STORY_FONT_FAMILY}"`;
  const labelWidth = context.measureText(websiteLabel).width;
  const scaleX = encoding.frameWidth / STORY_FRAME_WIDTH;
  const scaleY = encoding.frameHeight / STORY_FRAME_HEIGHT;
  const cursorCanvas = createCanvas(
    Math.max(1, Math.ceil(STORY_CURSOR_WIDTH * scaleX)),
    Math.max(1, Math.ceil(STORY_CURSOR_HEIGHT * scaleY)),
  );
  const cursorContext = cursorCanvas.getContext("2d");
  cursorContext.fillStyle = VIDEO_FOREGROUND;
  cursorContext.fillRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  const cursorPath = join(workingDirectory, "cursor.png");
  await writeFile(cursorPath, await cursorCanvas.encode("png"));
  return {
    cursorPath,
    cursorPosition: {
      x: Math.round(
        (STORY_FRAME_WIDTH / 2 + labelWidth / 2 + 6) * scaleX,
      ),
      y: Math.round(
        (STORY_WEBSITE_LABEL_Y - STORY_CURSOR_HEIGHT / 2) * scaleY,
      ),
    },
  };
}

export function resolveStoryEncoding(encoding = {}) {
  const frameRate = encoding.frameRate === 24 ? 24 : STORY_FRAME_RATE;
  const is1080p = encoding.frameWidth === STORY_FRAME_WIDTH;
  const crf = Number.isSafeInteger(encoding.crf) &&
      encoding.crf >= 18 && encoding.crf <= 30
    ? encoding.crf
    : 21;
  return {
    crf,
    frameHeight: is1080p ? STORY_FRAME_HEIGHT : 1_280,
    frameRate,
    frameWidth: is1080p ? STORY_FRAME_WIDTH : 720,
  };
}

async function writeFrame(stream, frame) {
  if (stream.write(frame)) return;
  await new Promise((resolve) => stream.once("drain", resolve));
}

function encoderCompletion(encoder) {
  let encoderError = "";
  encoder.stderr.setEncoding("utf8");
  encoder.stderr.on("data", (chunk) => {
    encoderError += chunk;
  });
  return new Promise((resolve, reject) => {
    encoder.once("error", reject);
    encoder.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(encoderError || `FFmpeg exited with ${String(code)}.`));
    });
  });
}

export async function renderStoryVideo({
  artwork,
  recursiveArtwork,
  recursiveCrop,
  recursivePlacement,
  baseProductSlug,
  encoding,
  mockup,
  motion = DEFAULT_STORY_MOTION,
  preset = "medium",
  settings,
  websiteLabel,
}) {
  const startedAt = performance.now();
  const resolvedEncoding = resolveStoryEncoding(encoding);
  const [source, mockupImage, recursiveSource] = await Promise.all([
    loadImage(artwork),
    loadImage(mockup),
    recursiveArtwork ? loadImage(recursiveArtwork) : undefined,
  ]);
  const assetLoadTimeMs = Math.round(performance.now() - startedAt);
  const canvas = createCanvas(
    resolvedEncoding.frameWidth,
    resolvedEncoding.frameHeight,
  );
  const context = canvas.getContext("2d");
  const assets = {
    artworkBounds: storyArtworkBounds(baseProductSlug),
    mockup: mockupImage,
    motion,
    settings,
    source,
    recursiveSource,
    recursiveCrop,
    recursivePlacement,
    websiteLabel,
  };
  const workingDirectory = await mkdtemp(join(tmpdir(), "story-video-"));
  const outputPath = join(workingDirectory, "story.mp4");
  const uniqueFrameCount = Math.min(
    Math.ceil(assets.motion.zoomDurationSeconds * resolvedEncoding.frameRate) + 1,
    STORY_DURATION_SECONDS * resolvedEncoding.frameRate,
  );
  const holdDurationSeconds = Math.max(
    STORY_DURATION_SECONDS - uniqueFrameCount / resolvedEncoding.frameRate,
    0,
  );
  const { cursorPath, cursorPosition } = await prepareCursor(
    context,
    resolvedEncoding,
    workingDirectory,
    websiteLabel,
  );
  const encoder = ffmpegProcess(
    outputPath,
    cursorPath,
    cursorPosition,
    assets.motion.zoomDurationSeconds,
    preset,
    holdDurationSeconds,
    resolvedEncoding,
    encoding?.scaleBeforeHold === true,
  );
  const completion = encoderCompletion(encoder);

  try {
    let canvasTimeMs = 0;
    let pipeTimeMs = 0;
    for (let frame = 0; frame < uniqueFrameCount; frame += 1) {
      const timestamp = Math.min(
        frame / resolvedEncoding.frameRate,
        assets.motion.zoomDurationSeconds,
      );
      const canvasStartedAt = performance.now();
      context.save();
      context.scale(
        resolvedEncoding.frameWidth / STORY_FRAME_WIDTH,
        resolvedEncoding.frameHeight / STORY_FRAME_HEIGHT,
      );
      drawFrame(context, assets, timestamp);
      context.restore();
      const frameData = canvas.data();
      canvasTimeMs += performance.now() - canvasStartedAt;
      const pipeStartedAt = performance.now();
      await writeFrame(encoder.stdin, frameData);
      pipeTimeMs += performance.now() - pipeStartedAt;
    }
    encoder.stdin.end();
    const encoderDrainStartedAt = performance.now();
    await completion;
    const encoderDrainTimeMs = performance.now() - encoderDrainStartedAt;
    const video = await readFile(outputPath);
    return {
      assetLoadTimeMs,
      canvasTimeMs: Math.round(canvasTimeMs),
      encoding: resolvedEncoding,
      encoderDrainTimeMs: Math.round(encoderDrainTimeMs),
      pipeTimeMs: Math.round(pipeTimeMs),
      renderTimeMs: Math.round(performance.now() - startedAt),
      uniqueFrameCount,
      video,
    };
  } finally {
    await rm(workingDirectory, { force: true, recursive: true });
  }
}
