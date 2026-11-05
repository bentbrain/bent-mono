import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { planCroppedSource, planRecursiveLayers, renderPrintAsset } from '../workers/api/src/print-assets.ts';
import { sharpPrintImages } from './testing/sharp-print-images.mjs';

const geometry = { decorationMethod: 'dtg', width: 256, height: 320 };
const sourceWidth = 240, sourceHeight = 360;
const pixels = Buffer.alloc(sourceWidth * sourceHeight * 4);
for (let y = 0; y < sourceHeight; y++) for (let x = 0; x < sourceWidth; x++) {
  const at = (y * sourceWidth + x) * 4;
  pixels[at] = x % 256; pixels[at + 1] = y % 256; pixels[at + 2] = (x * 7 + y * 11) % 256;
  pixels[at + 3] = x < 20 || x > 220 ? 0 : x < 40 ? (x - 20) * 12 : 255;
}
const png = await sharp(pixels, { raw: { width: sourceWidth, height: sourceHeight, channels: 4 } }).png().toBuffer();

for (const depth of [1, 5, 8]) for (const cropZoom of [0.8, 1.1]) {
  test(`grouped pixels preserve source geometry and alpha at depth ${depth}, zoom ${cropZoom}`, async () => {
    // Padding changes graph admission without introducing a personal portrait fixture.
    const source = Buffer.concat([png, Buffer.alloc(6_120_149 - png.length)]);
    const settings = { cropX: 0.6, cropY: 0.55, cropZoom, depth,
      placementX: 0.3, placementY: 0.31, placementWidth: 0.398752 };
    const plans = planRecursiveLayers(planCroppedSource(sourceWidth, sourceHeight, geometry, settings), geometry, settings);
    let reference = await sharp({ create: { width: geometry.width, height: geometry.height,
      channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    // Independent flat reference: every original layer is placed directly on the full canvas.
    for (const p of plans) {
      const overlay = await sharp(source).resize(p.width, p.height, { fit: 'fill' }).png().toBuffer();
      const trimmed = await sharp(overlay).extract({ left: p.trimLeft, top: p.trimTop,
        width: p.width - p.trimLeft - p.trimRight, height: p.height - p.trimTop - p.trimBottom }).png().toBuffer();
      reference = await sharp(reference).composite([{ input: trimmed, left: p.destinationLeft, top: p.destinationTop }]).png().toBuffer();
    }
    const images = sharpPrintImages();
    const rendered = await renderPrintAsset(images, source, sourceWidth, sourceHeight, geometry, settings);
    assert.equal(rendered.width, geometry.width); assert.equal(rendered.height, geometry.height);
    for (const background of ['#000000', '#ffffff']) {
      const expected = await sharp(reference).flatten({ background }).raw().toBuffer();
      const actual = await sharp(rendered.bytes).flatten({ background }).raw().toBuffer();
      assert.equal(actual.length, expected.length);
      let max = 0, sum = 0;
      for (let i = 0; i < actual.length; i++) { const d = Math.abs(actual[i] - expected[i]); max = Math.max(max, d); sum += d; }
      // Regrouping alpha composites can round by a few 8-bit levels. This is
      // not a pixel-identical claim; both dark/light backgrounds bound visible error.
      assert.ok(max <= 3, `Visible channel difference ${max}`);
      assert.ok(sum / actual.length < 0.05, `Mean visible difference ${sum / actual.length}`);
    }
  });
}
