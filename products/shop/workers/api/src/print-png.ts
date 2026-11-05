const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array, previous: number) {
  let crc = previous;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  return crc >>> 0;
}
function invalid(): never { throw new Error("Rendered print asset has invalid PNG geometry or data."); }

// Validate the trusted encoder's complete PNG envelope without uploading the
// final print to Images again. Keep only a chunk header, IHDR and CRC in memory;
// IDAT data is checked in-place, never concatenated or decompressed in a Worker.
export async function validatePrintPng(
  stream: ReadableStream<Uint8Array>, geometry: { width: number; height: number }, maxBytes: number,
) {
  const reader = stream.getReader();
  const small = new Uint8Array(13);
  const view = new DataView(small.buffer);
  let phase: "signature" | "header" | "data" | "crc" | "end" = "signature";
  let filled = 0;
  let remaining = 0;
  let type = "";
  let crc = 0xffffffff;
  let total = 0;
  let headerSeen = false;
  let paletteSeen = false;
  let colorType = 0;
  let idatSeen = false;
  let idatEnded = false;
  let idatBytes = 0;
  let complete = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const bytes = item.value;
      total += bytes.byteLength;
      if (total > maxBytes) throw new Error("Rendered print asset exceeds the storage limit.");
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (phase === "end") invalid();
        if (phase === "data") {
          const length = Math.min(remaining, bytes.byteLength - offset);
          const data = bytes.subarray(offset, offset + length);
          crc = crc32(data, crc);
          if (type === "IHDR") { small.set(data, filled); filled += length; }
          offset += length;
          remaining -= length;
          if (remaining !== 0) continue;
          if (type === "IHDR") {
            colorType = small[9] ?? -1;
            const depth = small[8];
            const allowed = colorType === 0 ? [1, 2, 4, 8, 16] : colorType === 3 ? [1, 2, 4, 8]
              : [2, 4, 6].includes(colorType) ? [8, 16] : [];
            if (view.getUint32(0) !== geometry.width || view.getUint32(4) !== geometry.height ||
              depth === undefined || !allowed.includes(depth) || small[10] !== 0 || small[11] !== 0 ||
              (small[12] !== 0 && small[12] !== 1)) invalid();
          }
          phase = "crc";
          filled = 0;
          continue;
        }
        const required = phase === "crc" ? 4 : 8;
        const length = Math.min(required - filled, bytes.byteLength - offset);
        small.set(bytes.subarray(offset, offset + length), filled);
        filled += length;
        offset += length;
        if (filled < required) continue;
        filled = 0;
        if (phase === "signature") {
          if (!SIGNATURE.every((byte, index) => small[index] === byte)) invalid();
          phase = "header";
        } else if (phase === "header") {
          remaining = view.getUint32(0);
          type = String.fromCharCode(...small.subarray(4, 8));
          if (remaining > maxBytes || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
          if (!headerSeen && type !== "IHDR") invalid();
          if (type === "IHDR") {
            if (headerSeen || remaining !== 13) invalid();
            headerSeen = true;
          } else if (type === "PLTE") {
            if (paletteSeen || idatSeen || remaining < 3 || remaining > 768 || remaining % 3 !== 0 ||
              colorType === 0 || colorType === 4) invalid();
            paletteSeen = true;
          } else if (type === "IDAT") {
            if (idatEnded || (colorType === 3 && !paletteSeen)) invalid();
            idatSeen = true;
            idatBytes += remaining;
          } else if (type === "IEND") {
            if (remaining !== 0 || !idatSeen || idatBytes === 0) invalid();
          } else if (/^[A-Z]/.test(type)) invalid();
          if (idatSeen && type !== "IDAT") idatEnded = true;
          crc = crc32(small.subarray(4, 8), 0xffffffff);
          phase = remaining === 0 ? "crc" : "data";
        } else {
          if (view.getUint32(0) !== ((crc ^ 0xffffffff) >>> 0)) invalid();
          phase = type === "IEND" ? "end" : "header";
        }
      }
    }
    if (phase !== "end") invalid();
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
