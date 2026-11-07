export type CardMedia = HTMLImageElement | HTMLVideoElement;

export function releaseMedia(media: CardMedia | undefined) {
  if (media instanceof HTMLVideoElement) {
    const url = media.src;
    media.pause();
    media.removeAttribute("src");
    media.load();
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

export function loadVideo(
  url: string,
  signal?: AbortSignal,
): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.loop = true;
    video.preload = "auto";
    const timeout = setTimeout(
      () =>
        fail(
          new Error(
            "The video took too long to open. Try exporting it as an H.264 MP4.",
          ),
        ),
      15_000,
    );
    function cleanup() {
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("error", error);
      signal?.removeEventListener("abort", cancel);
    }
    function fail(error: Error) {
      cleanup();
      video.pause();
      video.removeAttribute("src");
      video.load();
      reject(error);
    }
    function ready() {
      if (
        !video.videoWidth ||
        !video.videoHeight ||
        !Number.isFinite(video.duration)
      ) {
        fail(new Error("This video has no readable video track."));
        return;
      }
      cleanup();
      resolve(video);
    }
    function error() {
      fail(
        new Error(
          "This video could not be decoded. Export it as an H.264 MP4 and try again.",
        ),
      );
    }
    function cancel() {
      fail(new DOMException("Export cancelled", "AbortError"));
    }
    video.addEventListener("loadeddata", ready);
    video.addEventListener("error", error);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    video.src = url;
    video.load();
  });
}

export function seekVideo(
  video: HTMLVideoElement,
  time: number,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Export cancelled", "AbortError"));
      return;
    }
    const target = Math.min(time, Math.max(0, video.duration - 0.01));
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
      resolve();
      return;
    }
    const timeout = setTimeout(
      () => finish(new Error("A background video frame could not be read.")),
      10_000,
    );
    function finish(error?: Error) {
      clearTimeout(timeout);
      video.removeEventListener("seeked", ready);
      video.removeEventListener("error", failure);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    }
    function ready() {
      finish();
    }
    function failure() {
      finish(
        new Error("The background video could not be decoded completely."),
      );
    }
    function cancel() {
      finish(new DOMException("Export cancelled", "AbortError"));
    }
    video.addEventListener("seeked", ready, { once: true });
    video.addEventListener("error", failure, { once: true });
    signal.addEventListener("abort", cancel, { once: true });
    video.currentTime = target;
  });
}
