import { crc32 } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { validatePrintPng } from "./print-png";
import { printPng } from "./testing/print-png";

const geometry = { width: 200, height: 300 };
const png = printPng(geometry.width, geometry.height);
function stream(bytes: Uint8Array, chunkSize = bytes.length) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(offset, offset + chunkSize));
    offset = Math.min(bytes.length, offset + chunkSize);
  } });
}
describe("print PNG validation", () => {
  it.each([1, 2, 3, 7, 13, 32, 64_000])("accepts valid PNG across %i-byte chunks", async size => {
    await expect(validatePrintPng(stream(png, size), geometry, png.length)).resolves.toBeUndefined();
  });
  it("rejects every truncated prefix", async () => {
    for (let end = 0; end < png.length; end += 1) {
      await expect(validatePrintPng(stream(png.subarray(0, end)), geometry, png.length)).rejects.toThrow("invalid PNG");
    }
  });
  it("rejects wrong geometry with a valid header CRC", async () => {
    await expect(validatePrintPng(stream(printPng(201, 300)), geometry, 10_000)).rejects.toThrow("invalid PNG geometry");
  });
  it("checks compressed data CRC and refuses extra bytes after IEND", async () => {
    const corrupt = new Uint8Array(png);
    corrupt[45] = (corrupt[45] ?? 0) ^ 1;
    await expect(validatePrintPng(stream(corrupt), geometry, 10_000)).rejects.toThrow("invalid PNG");
    const trailing = new Uint8Array(png.length + 1); trailing.set(png);
    await expect(validatePrintPng(stream(trailing), geometry, 10_000)).rejects.toThrow("invalid PNG");
  });
  it("rejects invalid IHDR encoding even when its checksum is correct", async () => {
    const corrupt = new Uint8Array(png);
    corrupt[26] = 1; // Unsupported PNG compression method.
    new DataView(corrupt.buffer).setUint32(29, crc32(corrupt.subarray(12, 29)));
    await expect(validatePrintPng(stream(corrupt), geometry, 10_000)).rejects.toThrow("invalid PNG");
  });
  it("cancels the source when the output cap is exceeded", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png); }, cancel });
    await expect(validatePrintPng(source, geometry, png.length - 1)).rejects.toThrow("storage limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
