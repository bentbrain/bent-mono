import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

// Test data, not product art. Fixed coloured blocks with transparent margins
// exercise alpha decoding without reading or copying any customer's artwork.
export function syntheticProductionCanaryArtwork() {
  // Both launch products require at least 150 DPI source artwork. Keep this
  // synthetic fixture above the stricter tee threshold (2333 by 2923) so the
  // canary exercises real family admission instead of the expected low-resolution
  // rejection path.
  const width = 2400, height = 3000, stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  const rows = [Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let row = 0; row < rows.length; row++) for (let x = 300; x < width - 300; x++) {
    const at = 1 + x * 4, alternate = (Math.floor(x / 200) + row) % 2;
    rows[row].set(alternate ? [240, 90, 50, 255] : [30, 110, 200, 220], at);
  }
  for (let y = 375; y < height - 375; y++) rows[Math.floor(y / 200) % 2].copy(pixels, y * stride);
  const chunk = (name, data) => {
    const content = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
  return { bytes, source: { kind: "synthetic-colour-blocks-v1", byte_size: bytes.length, artwork_width: width, artwork_height: height,
    sha256: createHash("sha256").update(bytes).digest("hex"), customerArtworkRead: false } };
}
