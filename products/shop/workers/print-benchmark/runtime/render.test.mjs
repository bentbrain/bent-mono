import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderPrint } from './render.mjs';
import { comparePrints } from './compare.mjs';
import { renderPrint as renderReference } from './testing/png-layer-reference.mjs';

test('encodes only the final canvas instead of encoding every recursive layer', async t => {
  const source = await sharp({ create: { width: 12, height: 12, channels: 4,
    background: { r: 20, g: 140, b: 230, alpha: 0.5 } } }).png().toBuffer();
  const png = t.mock.method(sharp.prototype, 'png');
  await renderPrint(source, { width: 16, height: 16, layers: [12, 6, 3].map(size => ({
    width: size, height: size, trimLeft: 0, trimRight: 0, trimTop: 0, trimBottom: 0,
    destinationLeft: 1, destinationTop: 1,
  })) });
  assert.equal(png.mock.callCount(), 1);
});

for (const channels of [1, 2, 3, 4]) {
  test(`matches PNG layers pixel-for-pixel with ${channels} source channels and overlapping cropped layers`, async () => {
    const width = 31, height = 27, bytes = Buffer.alloc(width * height * channels);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 73 + Math.floor(index / channels) * 19) % 256;
    const source = await sharp(bytes, { raw: { width, height, channels } }).png().toBuffer();
    const plan = { width: 60, height: 53, layers: [
      { width: 50, height: 42, trimLeft: 3, trimRight: 8, trimTop: 4, trimBottom: 5, destinationLeft: 1, destinationTop: 2 },
      { width: 25, height: 19, trimLeft: 1, trimRight: 2, trimTop: 1, trimBottom: 3, destinationLeft: 15, destinationTop: 9 },
      { width: 7, height: 5, trimLeft: 0, trimRight: 0, trimTop: 0, trimBottom: 0, destinationLeft: 18, destinationTop: 11 },
    ] };
    const [reference, candidate] = await Promise.all([renderReference(source, plan), renderPrint(source, plan)]);
    assert.deepEqual(await sharp(candidate).ensureAlpha().raw().toBuffer(), await sharp(reference).ensureAlpha().raw().toBuffer());
  });
}

for (const encoding of ['jpeg', 'profiled-png', 'sixteen-bit-png']) {
  test(`retains source decoder behavior for ${encoding}`, async () => {
    const bytes = Buffer.alloc(37 * 41 * 4);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 29 + Math.floor(index / 4) * 37) % 256;
    const image = sharp(bytes, { raw: { width: 37, height: 41, channels: 4 } });
    const source = await (encoding === 'jpeg' ? image.jpeg() : encoding === 'profiled-png'
      ? image.withIccProfile('p3').png() : image.toColourspace('rgb16').png()).toBuffer();
    const plan = { width: 50, height: 60, layers: [
      { width: 29, height: 33, trimLeft: 2, trimRight: 1, trimTop: 3, trimBottom: 1, destinationLeft: 1, destinationTop: 2 },
      { width: 11, height: 15, trimLeft: 1, trimRight: 0, trimTop: 1, trimBottom: 0, destinationLeft: 13, destinationTop: 17 },
    ] };
    assert.deepEqual(await sharp(await renderPrint(source, plan)).ensureAlpha().raw().toBuffer(),
      await sharp(await renderReference(source, plan)).ensureAlpha().raw().toBuffer());
  });
}

test('uses exact resize then trim and preserves transparent canvas', async () => {
  const source = await sharp({ create: { width: 4, height: 4, channels: 4,
    background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const plan = { width: 8, height: 8, layers: [{ width: 4, height: 4, trimLeft: 1, trimRight: 1, trimTop: 1, trimBottom: 1,
    destinationLeft: 3, destinationTop: 2 }] };
  const output = await renderPrint(source, plan), pixels = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.equal(pixels.info.width, 8); assert.equal(pixels.info.height, 8); assert.equal(pixels.info.channels, 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const offset = (y * 8 + x) * 4, inside = x >= 3 && x < 5 && y >= 2 && y < 4;
    assert.deepEqual([...pixels.data.subarray(offset, offset + 4)], inside ? [255,0,0,255] : [0,0,0,0]);
  }
  assert.deepEqual(await comparePrints(output, output), { meanAbsoluteChannelDifference: 0, channelRmse: 0, meanAbsoluteAlphaDifference: 0 });
  await assert.rejects(comparePrints(output, source), /print shape and channels/);
});
