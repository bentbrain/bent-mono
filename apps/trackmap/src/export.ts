import type { TrackPoint } from "./activity";
import type { CardOptions } from "./render";
import { cardStats, drawCard, prepareRoute } from "./render";

export async function exportPng(
  points: TrackPoint[],
  options: CardOptions,
  photo?: HTMLImageElement,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = options.format === "story" ? 1920 : 1080;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not create the export canvas.");
  drawCard(
    ctx,
    canvas.width,
    canvas.height,
    prepareRoute(points),
    cardStats(points, options.units),
    options,
    options.angle,
    photo,
  );
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("PNG export failed. Try again.")),
      "image/png",
    ),
  );
}

export async function exportGif(
  points: TrackPoint[],
  options: CardOptions,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
  photo?: HTMLImageElement,
) {
  const { GIFEncoder } = await import("gifenc");
  const canvas = document.createElement("canvas");
  canvas.width = 540;
  canvas.height = options.format === "story" ? 960 : 540;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Your browser could not create the export canvas.");
  const gif = GIFEncoder();
  // Index zero is reserved for transparent pixels. The cube is deterministic
  // across frames, preventing palette flicker and opaque black GIF backgrounds.
  const palette: number[][] = [[0, 0, 0]];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) palette.push([r * 51, g * 51, b * 51]);
  const route = prepareRoute(points);
  const stats = cardStats(points, options.units);
  const frames = Math.round(options.duration * 12);
  const indexed = new Uint8Array(canvas.width * canvas.height);
  for (let frame = 0; frame < frames; frame++) {
    if (signal.aborted)
      throw new DOMException("Export cancelled", "AbortError");
    drawCard(
      ctx,
      canvas.width,
      canvas.height,
      route,
      stats,
      options,
      options.angle + (frame / frames) * 360,
      photo,
    );
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < indexed.length; i++) {
      const offset = i * 4;
      indexed[i] =
        data[offset + 3] < 128
          ? 0
          : 1 +
            Math.round(data[offset] / 51) * 36 +
            Math.round(data[offset + 1] / 51) * 6 +
            Math.round(data[offset + 2] / 51);
    }
    gif.writeFrame(indexed, canvas.width, canvas.height, {
      palette,
      delay: 80 + (frame % 3 === 2 ? 10 : 0),
      transparent: options.background === "transparent" && !photo,
      transparentIndex: 0,
      dispose: 2,
      repeat: 0,
    });
    onProgress(Math.round(((frame + 1) / frames) * 100));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
