import {
  Input,
  UrlSource,
  ALL_FORMATS,
  CanvasSink,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  Quality,
} from 'mediabunny';
import { drawStory, type Story } from './story';

export async function loadStory(story: Story, signal?: AbortSignal) {
  const inputs: Input[] = [];
  const bitmaps: ImageBitmap[] = [];
  const frames: ((
    time: number,
  ) => Promise<ImageBitmap | HTMLCanvasElement | OffscreenCanvas>)[] = [];
  const cancel = () => {
    for (const input of inputs) input.dispose();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (const media of story.media) {
      signal?.throwIfAborted();
      if (media.kind === 'photo') {
        const blob = await (await fetch(media.url, { signal })).blob();
        const bitmap = await createImageBitmap(blob);
        bitmaps.push(bitmap);
        signal?.throwIfAborted();
        frames.push(() => Promise.resolve(bitmap));
      } else {
        const input = new Input({
          source: new UrlSource(media.url),
          formats: ALL_FORMATS,
        });
        inputs.push(input);
        signal?.throwIfAborted();
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode()))
          throw new Error('Video cannot be decoded in this browser');
        const sink = new CanvasSink(track, {
          width: 620,
        });
        frames.push(async (time) => {
          const result = await sink.getCanvas(
            time % Math.max(0.1, media.duration || 8),
          );
          if (!result) throw new Error('Video frame unavailable');
          return result.canvas;
        });
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    await document.fonts.ready;
    signal?.throwIfAborted();
    return {
      canvas,
      async draw(time: number) {
        signal?.throwIfAborted();
        const images = await Promise.all(frames.map((frame) => frame(time)));
        signal?.throwIfAborted();
        drawStory(ctx, story, images, time);
      },
      dispose() {
        signal?.removeEventListener('abort', cancel);
        for (const input of inputs) input.dispose();
        for (const bitmap of bitmaps) bitmap.close();
      },
    };
  } catch (error) {
    signal?.removeEventListener('abort', cancel);
    for (const bitmap of bitmaps) bitmap.close();
    inputs.forEach((input) => {
      input.dispose();
    });
    throw error;
  }
}
export async function renderStory(
  story: Story,
  format: 'png' | 'mp4',
  progress: (value: number) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const renderer = await loadStory(story, signal);
  try {
    if (format === 'png') {
      await renderer.draw(0);
      return await new Promise<Blob>((resolve, reject) => {
        renderer.canvas.toBlob((blob) => {
          if (signal?.aborted)
            reject(new DOMException('Export cancelled', 'AbortError'));
          else if (blob) resolve(blob);
          else reject(new Error('PNG export failed'));
        }, 'image/png');
      });
    }
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    const source = new CanvasSource(renderer.canvas, {
      codec: 'avc',
      quality: new Quality('high'),
    });
    output.addVideoTrack(source, { frameRate: 30 });
    await output.start();
    const seconds = Math.min(
        10,
        Math.max(5, ...story.media.map((m) => m.duration || 0)),
      ),
      frames = Math.ceil(seconds * 30);
    try {
      for (let i = 0; i < frames; i++) {
        signal?.throwIfAborted();
        await renderer.draw(i / 30);
        await source.add(i / 30, 1 / 30);
        progress((i + 1) / frames);
      }
      source.close();
      await output.finalize();
      signal?.throwIfAborted();
      const buffer = output.target.buffer;
      if (!buffer) throw new Error('MP4 export failed');
      return new Blob([buffer], { type: 'video/mp4' });
    } catch (error) {
      await output.cancel();
      throw error;
    }
  } finally {
    renderer.dispose();
  }
}
