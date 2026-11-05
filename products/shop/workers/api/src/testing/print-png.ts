import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(data.byteLength + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.byteLength);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, -4)));
  return bytes;
}

// Real, decodable PNGs keep stream/geometry validation in the rendering tests.
export function printPng(width: number, height: number, options: { uncompressed?: boolean; paddingBytes?: number } = {}) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = options.uncompressed ? 8 : 1;
  header[9] = options.uncompressed ? 6 : 0;
  const stride = options.uncompressed ? width * 4 : Math.ceil(width / 8);
  const data = deflateSync(new Uint8Array((stride + 1) * height), { level: options.uncompressed ? 0 : 6 });
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    ...(options.paddingBytes ? [chunk("teSt", new Uint8Array(options.paddingBytes))] : []),
    chunk("IDAT", data), chunk("IEND", new Uint8Array()),
  ];
  const bytes = new Uint8Array(chunks.reduce((sum, item) => sum + item.byteLength, 0));
  let offset = 0;
  for (const item of chunks) { bytes.set(item, offset); offset += item.byteLength; }
  return bytes;
}
