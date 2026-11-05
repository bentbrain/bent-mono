import {
  Output,
  BufferTarget,
  Mp4OutputFormat,
  CanvasSource,
  Quality,
} from 'mediabunny';

// Deterministic noise reproduces size inflation without private travel media.
const canvas = document.createElement('canvas');
canvas.width = 360;
canvas.height = 640;
const context = canvas.getContext('2d');
if (!context) throw new Error('canvas unavailable');
const output = new Output({
  format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
  target: new BufferTarget(),
});
const source = new CanvasSource(canvas, {
  codec: 'avc',
  quality: new Quality({ bitrate: 2_000_000, bitrateMode: 'constant' }),
});
output.addVideoTrack(source, { frameRate: 30 });
await output.start();
try {
  const image = context.createImageData(canvas.width, canvas.height);
  let seed = 1195;
  for (let frame = 0; frame < 305; frame++) {
    for (let pixel = 0; pixel < image.data.length; pixel += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value = seed >>> 24;
      image.data[pixel] = value;
      image.data[pixel + 1] = value;
      image.data[pixel + 2] = value;
      image.data[pixel + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    await source.add(frame / 30, 1 / 30);
  }
  source.close();
  await output.finalize();
} catch (error) {
  await output.cancel();
  throw error;
}
const buffer = output.target.buffer;
if (!buffer) throw new Error('synthetic video unavailable');
const hash = await crypto.subtle.digest('SHA-256', buffer);
const files = new DataTransfer();
files.items.add(
  new File([buffer], 'sample bitrate.mov', { type: 'video/quicktime' }),
);
const input = document.querySelector('#upload');
if (!(input instanceof HTMLInputElement))
  throw new Error('upload control unavailable');
input.files = files.files;
input.dataset.originalHash = Array.from(new Uint8Array(hash), (byte) =>
  byte.toString(16).padStart(2, '0'),
).join('');
input.dispatchEvent(new Event('change', { bubbles: true }));
