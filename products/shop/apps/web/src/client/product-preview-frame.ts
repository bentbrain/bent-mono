// Brief, bounded memory only. Revocable image requests still check live access.
const frames = new Map<string, { canvas: HTMLCanvasElement; timer: number }>();
const MAX_FRAMES = 8;
const FRAME_LIFETIME_MS = 300_000;

export function previewFrameKey(productId: string, revision: string, color: string, view = 'flat') {
  return `${productId}/${revision}/${color.toLowerCase()}/${view}`;
}

function forget(key: string) {
  const frame = frames.get(key);
  if (!frame) return;
  window.clearTimeout(frame.timer);
  frames.delete(key);
  frame.canvas.width = 0;
  frame.canvas.height = 0;
}

export function retainPreviewFrame(key: string, source: CanvasImageSource, width: number, height: number) {
  if (width <= 0 || height <= 0) return;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(width, 768);
  canvas.height = Math.round(height * canvas.width / width);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  forget(key);
  frames.set(key, { canvas, timer: window.setTimeout(() => { forget(key); }, FRAME_LIFETIME_MS) });
  if (frames.size > MAX_FRAMES) {
    const first = frames.keys().next().value;
    if (first) forget(first);
  }
}

export function restorePreviewFrame(key: string, canvas: HTMLCanvasElement) {
  const frame = frames.get(key);
  if (!frame) return false;
  canvas.width = frame.canvas.width;
  canvas.height = frame.canvas.height;
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.drawImage(frame.canvas, 0, 0);
  return true;
}
