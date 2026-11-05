import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractMetadata } from '../src/lib/metadata';

void test('original JPEG EXIF preserves capture offset and GPS coordinates', async () => {
  const tiff = Buffer.alloc(197);
  tiff.write('II', 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  function entry(
    offset: number,
    tag: number,
    type: number,
    count: number,
    value: number,
  ) {
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    tiff.writeUInt32LE(value, offset + 8);
  }
  tiff.writeUInt16LE(2, 8);
  entry(10, 0x8769, 4, 1, 38);
  entry(22, 0x8825, 4, 1, 68);
  tiff.writeUInt16LE(2, 38);
  entry(40, 0x9003, 2, 20, 122);
  entry(52, 0x9011, 2, 7, 142);
  tiff.write('2026:10:15 20:15:00\0', 122);
  tiff.write('+09:00\0', 142);
  tiff.writeUInt16LE(4, 68);
  entry(70, 1, 2, 2, 'N'.charCodeAt(0));
  entry(82, 2, 5, 3, 149);
  entry(94, 3, 2, 2, 'E'.charCodeAt(0));
  entry(106, 4, 5, 3, 173);
  const coordinates: [number, number[]][] = [
    [149, [35, 41, 22.2]],
    [173, [139, 41, 30.12]],
  ];
  for (const [offset, values] of coordinates) {
    values.forEach((value, index) => {
      tiff.writeUInt32LE(Math.round(value * 10_000), offset + index * 8);
      tiff.writeUInt32LE(10_000, offset + index * 8 + 4);
    });
  }
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(exif.length + 2, 2);
  const jpeg = await readFile('public/demo/japan.jpg');
  const original = new Blob([
    jpeg.subarray(0, 2),
    marker,
    exif,
    jpeg.subarray(2),
  ]);
  const result = await extractMetadata(original, false);
  assert.ok(Math.abs((result.latitude ?? 0) - 35.6895) < 0.000001);
  assert.ok(Math.abs((result.longitude ?? 0) - 139.6917) < 0.000001);
  assert.equal(result.captured_at, '2026-10-15T11:15:00.000Z');
});
