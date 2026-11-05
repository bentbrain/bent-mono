import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { processPortraitForStorage } from "./portrait-processing";
import { prepareStoredArtwork, validateSourceImage, type ImageProcessingBinding } from "./image-processing";
import sharp from "sharp";
import { maximumPrintCropZoom, printSourceResolution } from "./print-assets";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function photoProcessing(width: number, height: number) {
  const outputs: { options: ImageOutputOptions; transforms: ImageTransform[] }[] = [];
  const images: ImageProcessingBinding = {
    info: () => Promise.resolve({ format: "image/jpeg", width, height }),
    input: () => {
      const transforms: ImageTransform[] = [];
      const transformer = {
        transform(options: ImageTransform) { transforms.push(options); return transformer; },
        output(options: ImageOutputOptions) {
          outputs.push({ options, transforms });
          // A normal camera JPEG can expand beyond 20 MiB when encoded as PNG.
          const bytes = options.format === "image/png" ? new Uint8Array(21 * 1024 * 1024) : jpeg;
          return Promise.resolve({ response: () => new Response(bytes) });
        },
      };
      return transformer;
    },
  };
  return { images, outputs };
}

describe("high-resolution portrait storage", () => {
  it("accepts a camera photo whose PNG expansion exceeds the old artwork cap", async () => {
    const { images } = photoProcessing(3_024, 4_032);
    const result = await processPortraitForStorage(images, jpeg, () => Promise.resolve(true),
      { screen: () => Effect.succeed({ decision: "allowed", model: "test" }) }, undefined, true);
    expect(result).toMatchObject({ ok: true, width: 3_024, height: 4_032 });
  });

  it("retains 48 MP source dimensions and gains zoom without lowering print PPI", async () => {
    const { images, outputs } = photoProcessing(6_048, 8_064);
    const result = await processPortraitForStorage(images, jpeg, () => Promise.resolve(true),
      { screen: () => Effect.succeed({ decision: "allowed", model: "test" }) }, undefined, true);
    expect(result).toMatchObject({ ok: true, width: 6_048, height: 8_064,
      original: { width: 6_048, height: 8_064 } });
    const artwork = outputs.filter(output => output.options.format !== "image/jpeg");
    expect(artwork.length).toBeGreaterThanOrEqual(2);
    expect(artwork.every(output => output.transforms.every(transform => !transform.width && !transform.height))).toBe(true);
    const geometry = { width: 4_150, height: 4_690 };
    const zoom = maximumPrintCropZoom(6_048, 8_064, geometry);
    expect(zoom).toBeGreaterThan(maximumPrintCropZoom(3_072, 4_096, geometry));
    expect(printSourceResolution(6_048, 8_064, geometry, { cropX: 0.5, cropY: 0.5, cropZoom: zoom }).safe).toBe(true);
  });
});

// Exercise the real encoders as well as the provider-boundary failure fixtures.
// Segmentation itself is cloud-only; this adapter preserves alpha for that step.
const realEncoding: ImageProcessingBinding = {
  async info(stream) {
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    return { format: `image/${metadata.format}`, width: metadata.width, height: metadata.height };
  },
  input(stream) {
    const input = new Response(stream).arrayBuffer();
    const transforms: ImageTransform[] = [];
    const transformer = {
      transform(options: ImageTransform) { transforms.push(options); return transformer; },
      async output(options: ImageOutputOptions) {
        let pipeline = sharp(await input).autoOrient();
        if (transforms.some(transform => transform.background)) pipeline = pipeline.flatten({ background: "white" });
        if (options.format !== "image/webp") throw new Error("Unexpected storage format");
        const result = await pipeline.webp({ quality: options.quality ?? 100, lossless: options.quality === 100 }).toBuffer();
        return { response: () => new Response(result) };
      },
    };
    return transformer;
  },
};

it("preserves large JPEG pixels, applies EXIF rotation and strips metadata", async () => {
  const bytes = await sharp({ create: { width: 5_000, height: 3_000, channels: 3, background: "#735b41" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const valid = await validateSourceImage(realEncoding, bytes);
  expect(valid.ok).toBe(true);
  if (!valid.ok) throw new Error("Expected valid JPEG");
  const result = await prepareStoredArtwork(realEncoding, bytes, false, valid.image);
  expect(result).toMatchObject({ ok: true, width: 3_000, height: 5_000 });
  if (!result.ok) throw new Error("Expected prepared JPEG");
  const metadata = await sharp(result.bytes).metadata();
  expect(metadata.format).toBe("webp");
  expect(metadata.exif).toBeUndefined();
  expect(metadata.orientation).toBeUndefined();
});

it.each(["png", "webp"] satisfies ("png" | "webp")[])("accepts %s source bytes and flattens transparency at full resolution", async format => {
  const bytes = await sharp({ create: { width: 5_000, height: 3_000, channels: 4, background: "#00000000" } })
    .toFormat(format).toBuffer();
  const valid = await validateSourceImage(realEncoding, bytes);
  expect(valid.ok).toBe(true);
  if (!valid.ok) throw new Error("Expected valid source");
  const result = await prepareStoredArtwork(realEncoding, bytes, false, valid.image);
  expect(result).toMatchObject({ ok: true, width: 5_000, height: 3_000 });
  if (!result.ok) throw new Error("Expected prepared source");
  const pixel = await sharp(result.bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  expect([...pixel]).toEqual([255, 255, 255]);
});

it("re-encodes oversized artwork without reducing its dimensions", async () => {
  const qualities: number[] = [];
  const images: ImageProcessingBinding = {
    info: () => Promise.resolve({ format: "image/webp", width: 6_048, height: 8_064 }),
    input: () => {
      const transformer = {
        transform(options: ImageTransform) {
          expect(options.width).toBeUndefined();
          expect(options.height).toBeUndefined();
          return transformer;
        },
        output(options: ImageOutputOptions) {
          qualities.push(options.quality ?? 0);
          const bytes = options.quality === 100 ? new Uint8Array(19_000_001) : jpeg;
          return Promise.resolve({ response: () => new Response(bytes) });
        },
      };
      return transformer;
    },
  };
  expect(await prepareStoredArtwork(images, jpeg, true, { width: 6_048, height: 8_064 }))
    .toMatchObject({ ok: true, width: 6_048, height: 8_064 });
  expect(qualities).toEqual([100, 95]);
});

it("records the failing encoding stage and provider code without private exception data", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const images: ImageProcessingBinding = {
      ...photoProcessing(5_712, 4_284).images,
      input: () => {
        const transformer = {
          transform() { return transformer; },
          output() {
            return Promise.reject(Object.assign(new Error("private-photo https://private.example/token"), { code: 9422 }));
          },
        };
        return transformer;
      },
    };
    expect(await prepareStoredArtwork(images, jpeg, true, { width: 5_712, height: 4_284 }))
      .toEqual({ ok: false, reason: "dependency" });
    expect(warn).toHaveBeenCalledExactlyOnceWith("bent.shop image processing failed", {
      stage: "stored-cutout", failure: "encode", inputBytes: jpeg.length,
      sourceWidth: 5_712, sourceHeight: 4_284, quality: 100,
      durationMs: 0, providerCode: 9422,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  } finally { warn.mockRestore(); now.mockRestore(); }
});

it("distinguishes provider dimension changes from encoding exceptions", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const { images } = photoProcessing(1_024, 768);
    expect(await prepareStoredArtwork(images, jpeg, false, { width: 5_712, height: 4_284 }))
      .toEqual({ ok: false, reason: "dependency" });
    expect(warn).toHaveBeenCalledExactlyOnceWith("bent.shop image processing failed", {
      stage: "stored-original", failure: "dimensions", inputBytes: jpeg.length,
      sourceWidth: 5_712, sourceHeight: 4_284, quality: 100,
      outputBytes: jpeg.length, outputWidth: 1_024, outputHeight: 768,
    });
  } finally { warn.mockRestore(); }
});

it.each([9523, 9529])("retries lossless provider error %i at high quality without reducing source dimensions", async code => {
  const qualities: number[] = [];
  const images: ImageProcessingBinding = {
    info: () => Promise.resolve({ format: "image/webp", width: 4_284, height: 5_712 }),
    input: () => {
      const transformer = {
        transform(options: ImageTransform) {
          expect(options.width).toBeUndefined();
          expect(options.height).toBeUndefined();
          return transformer;
        },
        output(options: ImageOutputOptions) {
          qualities.push(options.quality ?? 0);
          if (options.quality === 100) return Promise.reject(Object.assign(new Error("Transformation failed"), { code }));
          return Promise.resolve({ response: () => new Response(jpeg) });
        },
      };
      return transformer;
    },
  };
  expect(await prepareStoredArtwork(images, jpeg, false, { width: 5_712, height: 4_284 }))
    .toMatchObject({ ok: true, width: 4_284, height: 5_712 });
  expect(qualities).toEqual([100, 95]);
});

it.each([9523, 9529])("stops after one retry when provider error %i persists", async code => {
  const qualities: number[] = [];
  const images: ImageProcessingBinding = {
    ...photoProcessing(5_712, 4_284).images,
    input: () => {
      const transformer = {
        transform() { return transformer; },
        output(options: ImageOutputOptions) {
          qualities.push(options.quality ?? 0);
          return Promise.reject(Object.assign(new Error("Transformation failed"), { code }));
        },
      };
      return transformer;
    },
  };
  expect(await prepareStoredArtwork(images, jpeg, true, { width: 5_712, height: 4_284 }))
    .toEqual({ ok: false, reason: "dependency" });
  expect(qualities).toEqual([100, 95]);
});
