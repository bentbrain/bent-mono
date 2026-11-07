import { FileVideo } from "./file-video";
import type { CardMedia } from "./media";
import { loadVideo, seekVideo } from "./media";

export type CardFrame =
  HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas;

// Export frames from the file rather than repeatedly seeking a playback
// element. The sequential decoder keeps its reference frames across samples.
export async function* backgroundFrames(
  media: CardMedia | undefined,
  count: number,
  fps: number,
  signal: AbortSignal,
): AsyncGenerator<CardFrame | undefined> {
  const checkAbort = () => signal.throwIfAborted();
  checkAbort();
  if (!(media instanceof HTMLVideoElement) && !(media instanceof FileVideo)) {
    for (let frame = 0; frame < count; frame++) {
      checkAbort();
      yield media;
    }
    return;
  }
  const file = media instanceof FileVideo ? media.file : undefined;
  if (file && typeof VideoDecoder !== "undefined") {
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } =
      await import("mediabunny");
    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });
    const cancel = () => input.dispose();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      checkAbort();
      // Preview loading already verified this decoder can open the file.
      // Later frame errors remain errors instead of producing partial output.
      const track = await input.getPrimaryVideoTrack().catch(() => null);
      checkAbort();
      if (track && (await track.canDecode())) {
        const start = Math.max(0, await track.getFirstTimestamp());
        const duration = (await track.computeDuration()) - start;
        if (!Number.isFinite(duration) || duration <= 0)
          throw new Error("This video has no readable video frames.");
        function* timestamps() {
          for (let frame = 0; frame < count; frame++)
            yield start + ((frame / fps) % duration);
        }
        const sink = new CanvasSink(track, { poolSize: 2 });
        for await (const frame of sink.canvasesAtTimestamps(timestamps())) {
          checkAbort();
          if (!frame)
            throw new Error("A background video frame could not be read.");
          yield frame.canvas;
        }
        return;
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      input.dispose();
    }
  }
  checkAbort();
  if (media instanceof FileVideo)
    throw new Error("The file video decoder is unavailable.");
  const video = await loadVideo(media.src, signal);
  try {
    for (let frame = 0; frame < count; frame++) {
      await seekVideo(video, (frame / fps) % video.duration, signal);
      yield video;
    }
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}
