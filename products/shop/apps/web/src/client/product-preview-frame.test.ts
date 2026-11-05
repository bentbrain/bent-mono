// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { previewFrameKey, retainPreviewFrame, restorePreviewFrame } from './product-preview-frame';

const originalContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
const drawImage = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: vi.fn(() => ({ drawImage })) });
});
afterEach(() => {
  vi.advanceTimersByTime(300_001);
  vi.useRealTimers();
  drawImage.mockClear();
  if (originalContext) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalContext);
});
function remember(key: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 1500; canvas.height = 1500;
  retainPreviewFrame(key, canvas, canvas.width, canvas.height);
}
it('copies a bounded frame without retaining the mounted canvas', () => {
  remember('frame');
  const target = document.createElement('canvas');
  expect(restorePreviewFrame('frame', target)).toBe(true);
  expect([target.width, target.height]).toEqual([768, 768]);
  expect(drawImage).toHaveBeenCalledTimes(2);
});
it('releases the frame after five minutes', () => {
  remember('frame');
  vi.advanceTimersByTime(300_001);
  expect(restorePreviewFrame('frame', document.createElement('canvas'))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('limits retained variants to eight frames', () => {
  for (let index = 0; index < 9; index++) remember(String(index));
  expect(restorePreviewFrame('0', document.createElement('canvas'))).toBe(false);
  expect(restorePreviewFrame('8', document.createElement('canvas'))).toBe(true);
  expect(vi.getTimerCount()).toBe(8);
});
it('separates revisions, products, colours and views', () => {
  const key = previewFrameKey('shirt', 'revision', 'White');
  remember(key);
  for (const other of [previewFrameKey('tote', 'revision', 'White'), previewFrameKey('shirt', 'new', 'White'),
    previewFrameKey('shirt', 'revision', 'Black'), previewFrameKey('shirt', 'revision', 'White', 'lifestyle')]) {
    expect(restorePreviewFrame(other, document.createElement('canvas'))).toBe(false);
  }
  expect(restorePreviewFrame(previewFrameKey('shirt', 'revision', 'white'), document.createElement('canvas'))).toBe(true);
});
