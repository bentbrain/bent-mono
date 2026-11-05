import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { renderStoryVideo } from "../src/renderer.mjs";
const execute = promisify(execFile);

export function backupFixture() {
  const make = (outer) => {
    const canvas = createCanvas(600, 750), ctx = canvas.getContext("2d");
    ctx.fillStyle = outer ? "#ff9900" : "#eeeeee"; ctx.fillRect(70, 250, 460, 500);
    ctx.fillStyle = outer ? "#ff00ff" : "#0055ff"; ctx.fillRect(220, 50, 160, 200);
    ctx.fillStyle = "#00aa44"; ctx.fillRect(180, 280, 240, 30);
    return canvas.toDataURL("image/png");
  };
  return { artwork: make(true), recursiveArtwork: make(false),
    settings: { cropX: .5, cropY: .5, cropZoom: 1, placementX: .25, placementY: .25, placementWidth: .45, depth: 5 },
    recursiveCrop: { cropX: .5, cropY: .5, cropZoom: 1 },
    recursivePlacement: { placementX: .25, placementY: .48, placementWidth: .45 },
    preset: "veryfast", encoding: { frameWidth: 1080, frameRate: 30, crf: 19, scaleBeforeHold: true },
    websiteLabel: "shop.bent.build" };
}

export async function compareBackupVideo(directory) {
  const result = await renderStoryVideo({ ...backupFixture(), baseProductSlug: "staple-tee",
    mockup: await readFile(new URL("../../../apps/web/public/mockups/tee-white-cutout-v1.png", import.meta.url)) });
  await writeFile(join(directory, "reference.mp4"), result.video);
  return compareVideoFrames(directory);
}

export async function compareVideoFrames(directory) {
  const frames = [];
  await execute("ffmpeg", ["-v", "error", "-i", join(directory, "cloud.mp4"), "-f", "null", "-"], { timeout: 60000 });
  for (const second of [0, 2, 4]) {
    const images = [];
    for (const name of ["reference", "cloud"]) {
      const path = join(directory, `${name}-${second}.png`);
      await execute("ffmpeg", ["-v", "error", "-y", "-ss", String(second), "-i", join(directory, `${name}.mp4`), "-frames:v", "1", path], { timeout: 60000 });
      const image = await loadImage(path);
      if (image.width !== 1080 || image.height !== 1920) throw Error("Unexpected backup video dimensions.");
      const canvas = createCanvas(1080, 1920), ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0); images.push(ctx.getImageData(0, 0, 1080, 1920).data);
    }
    let squared = 0;
    for (let index = 0; index < images[0].length; index++) squared += (images[0][index] - images[1][index]) ** 2;
    const rmse = Math.sqrt(squared / images[0].length);
    if (rmse >= 6) throw Error(`Backup composition differs at ${second}s (RMSE ${rmse.toFixed(2)}).`);
    frames.push({ second, rmse });
  }
  return frames;
}
