import type { CanvasSink, Input, WrappedCanvas } from "mediabunny";

// A file-backed preview avoids depending on the browser's playback pipeline.
// Keep only the current frame and a small decoder canvas pool in memory.
export class FileVideo {
  private version = 0;
  private position = 0;
  private wake: (() => void) | undefined;

  private constructor(
    readonly file: Blob,
    private readonly input: Input,
    private readonly sink: CanvasSink,
    private readonly start: number,
    private readonly duration: number,
    public canvas: WrappedCanvas["canvas"],
  ) {}

  static async open(file: Blob): Promise<FileVideo | undefined> {
    if (typeof VideoDecoder === "undefined") return;
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } =
      await import("mediabunny");
    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });
    let retained = false;
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return;
      const start = Math.max(0, await track.getFirstTimestamp());
      const duration = (await track.computeDuration()) - start;
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("This video has no readable video frames.");
      const sink = new CanvasSink(track, { poolSize: 2 });
      const first = await sink.getCanvas(start);
      if (!first) throw new Error("This video has no readable video frames.");
      const video = new FileVideo(
        file,
        input,
        sink,
        start,
        duration,
        first.canvas,
      );
      retained = true;
      return video;
    } finally {
      if (!retained) input.dispose();
    }
  }

  async play() {
    this.pause();
    const version = this.version;
    let offset = this.position;
    while (version === this.version) {
      const started = performance.now();
      for await (const frame of this.sink.canvases(
        this.start + offset,
        this.start + this.duration,
      )) {
        if (version !== this.version) return;
        const position = Math.max(0, frame.timestamp - this.start);
        const delay =
          (position - offset) * 1000 - (performance.now() - started);
        await this.wait(delay);
        if (version !== this.version) return;
        this.canvas = frame.canvas;
        this.position = position;
      }
      if (version !== this.version) return;
      await this.wait(
        (this.duration - offset) * 1000 - (performance.now() - started),
      );
      offset = 0;
    }
  }

  private wait(delay: number) {
    if (delay <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, delay);
      this.wake = done;
    });
  }

  pause() {
    this.version++;
    this.wake?.();
    this.wake = undefined;
  }

  release() {
    this.pause();
    this.input.dispose();
  }
}
