import {
  Input,
  BlobSource,
  ALL_FORMATS,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  Conversion,
  Quality,
} from 'mediabunny';
import { isShortVideoDuration } from './video-duration';

function waitForPreparation<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('preparation cancelled'),
      );
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not prepare image'));
      },
      'image/jpeg',
      0.9,
    );
  });
}
export async function prepareMedia(
  file: File,
  onProgress?: (stage: string) => void,
) {
  const controller = new AbortController();
  let currentStage = 'preparation';
  const timeout = setTimeout(() => {
    controller.abort(new Error(`${currentStage} timed out. retry this file.`));
  }, 120_000);
  try {
    return await prepare(file, controller.signal, (stage) => {
      if (!controller.signal.aborted) {
        currentStage = stage;
        onProgress?.(stage);
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function prepare(
  file: File,
  signal: AbortSignal,
  progress: (stage: string) => void,
) {
  const video =
    file.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(file.name);
  const canvas = document.createElement('canvas'),
    ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  if (video) {
    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });
    try {
      progress('reading video');
      const duration = await waitForPreparation(
        input.computeDuration(),
        signal,
      );
      if (!isShortVideoDuration(duration))
        throw new Error('Videos must be 10 seconds or shorter');
      const track = await waitForPreparation(
        input.getPrimaryVideoTrack(),
        signal,
      );
      if (!track) throw new Error('Could not read video');
      const [width, height] = await waitForPreparation(
        Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]),
        signal,
      );
      // Bound the longest edge in either orientation without enlarging small clips.
      const resize =
        width >= height
          ? { width: Math.min(1280, Math.max(2, 2 * Math.round(width / 2))) }
          : { height: Math.min(1280, Math.max(2, 2 * Math.round(height / 2))) };
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: new BufferTarget(),
      });
      progress('preparing video conversion');
      const initializing = Conversion.init({
        input,
        output,
        video: {
          codec: 'avc',
          ...resize,
          // Leave room below the API's 32 MiB preview limit for every
          // supported duration, including detailed portrait captures.
          quality: new Quality({ bitrate: 8_000_000, bitrateMode: 'variable' }),
          forceTranscode: true,
          frameRate: 30,
        },
        audio: { discard: true },
      }).then((conversion) => {
        // Initialization can settle after the deadline. Release those codecs too.
        if (signal.aborted) void conversion.cancel().catch(() => {});
        return conversion;
      });
      const conversion = await waitForPreparation(initializing, signal);
      try {
        if (!conversion.isValid)
          throw new Error(
            'This browser cannot convert the video. Try Safari or Chrome.',
          );
        conversion.onProgress = (value) => {
          progress(`converting video ${String(Math.round(value * 100))}%`);
        };
        progress('converting video 0%');
        await waitForPreparation(conversion.execute(), signal);
        const buffer = output.target.buffer;
        if (!buffer) throw new Error('Could not prepare video');
        const display = new File([buffer], 'video.mp4', { type: 'video/mp4' }),
          element = document.createElement('video'),
          url = URL.createObjectURL(display);
        element.muted = true;
        element.playsInline = true;
        element.preload = 'auto';
        try {
          progress('making video preview');
          await waitForPreparation(
            new Promise<void>((resolve, reject) => {
              element.onloadeddata = () => {
                resolve();
              };
              element.onerror = () => {
                reject(new Error('Could not read video'));
              };
              element.src = url;
              element.load();
            }),
            signal,
          );
          canvas.width = 1280;
          canvas.height = Math.round(
            (1280 * element.videoHeight) / element.videoWidth,
          );
          ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
          return {
            display,
            poster: new File(
              [await waitForPreparation(canvasBlob(canvas), signal)],
              'poster.jpg',
              {
                type: 'image/jpeg',
              },
            ),
          };
        } finally {
          element.onloadeddata = null;
          element.onerror = null;
          URL.revokeObjectURL(url);
          element.removeAttribute('src');
          element.load();
        }
      } finally {
        // Do not let a stalled codec's cleanup block the next file.
        void conversion.cancel().catch(() => {});
      }
    } finally {
      input.dispose();
    }
  }
  let source: Blob = file;
  if (/\.(heic|heif)$/i.test(file.name) || file.type.includes('hei')) {
    progress('converting photo');
    const { heicTo } = await waitForPreparation(import('heic-to/csp'), signal);
    source = await waitForPreparation(
      heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 }),
      signal,
    );
  }
  progress('making photo preview');
  const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  let bitmap: ImageBitmap | undefined;
  let svgImage: HTMLImageElement | undefined;
  let svgUrl: string | undefined;
  try {
    if (svg) {
      // SVG is decoded only in the browser's isolated image context: scripts
      // and external resources cannot run, and markup never enters the DOM.
      svgImage = document.createElement('img');
      svgUrl = URL.createObjectURL(
        new Blob([source], { type: 'image/svg+xml' }),
      );
      svgImage.src = svgUrl;
      await waitForPreparation(svgImage.decode(), signal);
    } else {
      bitmap = await waitForPreparation(
        createImageBitmap(source).then((value) => {
          if (signal.aborted) value.close();
          return value;
        }),
        signal,
      );
    }
    const image = bitmap || svgImage;
    const width = bitmap?.width ?? svgImage?.naturalWidth ?? 0;
    const height = bitmap?.height ?? svgImage?.naturalHeight ?? 0;
    if (!image || width <= 0 || height <= 0)
      throw new Error('Could not read photo dimensions');
    const scale = Math.min(1, 1600 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    // JPEG has no alpha channel. Composite transparent graphics explicitly so
    // black ink stays visible rather than disappearing into a black backdrop.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const display = new File(
      [await waitForPreparation(canvasBlob(canvas), signal)],
      'photo.jpg',
      {
        type: 'image/jpeg',
      },
    );
    return { display, poster: display };
  } finally {
    bitmap?.close();
    svgImage?.removeAttribute('src');
    if (svgUrl) URL.revokeObjectURL(svgUrl);
  }
}
