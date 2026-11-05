import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { printPng } from "./testing/print-png";

import {
  artworkDimensionsCanBeResolved,
  planCroppedSource,
  planRecursiveLayers,
  printGeometryKey,
  printSourceResolution,
  maximumPrintCropZoom,
  printAssetRenderSlotDelay,
  renderPrintAsset,
  type PrintAssetSettings,
} from "./print-assets";

const SOURCE = new Uint8Array([137, 80, 78, 71]);

it("bounds render-slot polling without extending its 55-second wait budget", () => {
  let elapsed = 0;
  let attempts = 0;
  const waits: number[] = [];
  for (;;) {
    attempts += 1;
    const delay = printAssetRenderSlotDelay(attempts, elapsed);
    if (delay === 0) break;
    waits.push(delay);
    elapsed += delay;
  }
  expect(waits.slice(0, 5)).toEqual([250, 500, 1_000, 2_000, 2_000]);
  expect(Math.max(...waits)).toBe(2_000);
  expect(elapsed).toBe(55_000);
  expect(attempts).toBeLessThanOrEqual(31);
  expect(printAssetRenderSlotDelay(attempts, 55_001)).toBe(0);
});
const OUTPUT = printPng(4_500, 5_100);
const SETTINGS: PrintAssetSettings = {
  cropX: 0.5,
  cropY: 0.5,
  cropZoom: 1,
  depth: 2,
  placementWidth: 0.2,
  placementX: 0.3,
  placementY: 0.4,
};

interface TransformOperation {
  readonly kind: "transform";
  readonly options: ImageTransform;
}

interface DrawOperation {
  readonly kind: "draw";
  readonly options: ImageDrawOptions | undefined;
  readonly source: "stream" | "transformer";
}

type Operation = DrawOperation | TransformOperation;

class RecordingTransformer implements ImageTransformer {
  private transformCount = 0;
  constructor(
    readonly operations: Operation[],
    private readonly outputStatus: number,
    private readonly recordOutput: (width: number, height: number) => void,
    private readonly sources: Promise<Uint8Array>[],
    private readonly outputBytes: Uint8Array,
    private width: number,
    private height: number,
  ) {}

  transform(options: ImageTransform) {
    this.transformCount += 1;
    if (options.width !== undefined) this.width = options.width;
    if (options.height !== undefined) this.height = options.height;
    this.operations.push({ kind: "transform", options });
    return this;
  }

  draw(
    image: ReadableStream<Uint8Array> | ImageTransformer,
    options?: ImageDrawOptions,
  ) {
    this.transformCount += 1;
    const source = image instanceof ReadableStream ? "stream" : "transformer";
    if (image instanceof ReadableStream) {
      this.sources.push(new Response(image).arrayBuffer().then(buffer => new Uint8Array(buffer)));
    } else if (image instanceof RecordingTransformer) {
      this.sources.push(...image.sources);
      this.transformCount += image.transformCount;
    }
    this.operations.push({ kind: "draw", options, source });
    return this;
  }

  async output(options: ImageOutputOptions) {
    if (this.transformCount > 10) throw new Error('IMAGES_TRANSFORM_ERROR 9432: Bad request: 10 "transforms" maximum');
    const size = (await Promise.all(this.sources)).reduce((total, source) => total + source.byteLength, 0);
    if (size > 20_000_000) throw new Error("Images graph exceeds input budget");
    this.recordOutput(this.width, this.height);
    this.operations.push({ kind: "transform", options: {
      background: options.format,
    } });
    const status = this.outputStatus;
    const bytes = this.outputBytes;
    return Promise.resolve({
      contentType() {
        return "image/png";
      },
      image() {
        return byteStream(bytes);
      },
      response() {
        return new Response(byteStream(bytes), {
          headers: { "content-type": "image/png" },
          status,
        });
      },
    });
  }
}

class RecordingImages {
  readonly inputs: Promise<Uint8Array>[] = [];
  readonly operations: Operation[] = [];
  inputCount = 0;
  outputCount = 0;
  readonly outputSizes: { width: number; height: number }[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly format = "image/png",
    private readonly outputStatus = 200,
    private readonly outputBytes = printPng(width, height),
  ) {}

  async info(stream: ReadableStream<Uint8Array>): Promise<ImageInfoResponse> {
    await stream.cancel();
    return {
      fileSize: OUTPUT.byteLength,
      format: this.format,
      height: this.height,
      width: this.width,
    };
  }

  input(stream: ReadableStream<Uint8Array>) {
    const source = new Response(stream).arrayBuffer().then(buffer => new Uint8Array(buffer));
    this.inputs.push(source);
    this.inputCount += 1;
    return new RecordingTransformer(
      this.operations,
      this.outputStatus,
      (width, height) => { this.outputCount += 1; this.outputSizes.push({ width, height }); },
      [source],
      this.outputBytes,
      this.width,
      this.height,
    );
  }
}

describe("print geometry", () => {
  it.each([{ width: 3024, height: 4032 }, { width: 4032, height: 3024 }, { width: 1080, height: 1920 }])(
    "keeps the maximum zoom printable with integer render dimensions: $width x $height", source => {
      const geometry = { width: 4682, height: 5291 };
      const zoom = maximumPrintCropZoom(source.width, source.height, geometry);
      expect(printSourceResolution(source.width, source.height, geometry, { ...SETTINGS, cropZoom: zoom }).safe).toBe(true);
      expect(printSourceResolution(source.width, source.height, geometry, { ...SETTINGS, cropZoom: zoom + 0.001 }).safe).toBe(false);
    });

  it.each([
    { width: 2_316, height: 3_088, zoom: 0.976271186440678, ppi: 179.35, safe: true },
    { width: 1_080, height: 1_920, zoom: 1, ppi: 108.85, safe: false },
    { width: 2_160, height: 3_840, zoom: 1, ppi: 217.7, safe: true },
    { width: 3_000, height: 4_000, zoom: 2, ppi: 113.4, safe: false },
    { width: 2_341, height: 2_646, zoom: 1, ppi: 150, safe: true },
    { width: 2_340, height: 2_645, zoom: 1, ppi: 149.95, safe: false },
  ])("checks density at the actual printed size: $width × $height, zoom $zoom", ({ width, height, zoom, ppi, safe }) => {
    const resolution = printSourceResolution(width, height,
      { width: 4_682, height: 5_291 }, { ...SETTINGS, cropZoom: zoom });
    expect(resolution.safe).toBe(safe);
    expect(resolution.ppi).toBeCloseTo(ppi, 1);
  });

  it("does not count clipped pixels as extra print detail", () => {
    const geometry = { width: 4_682, height: 5_291 };
    const centered = printSourceResolution(3_000, 4_000, geometry, { ...SETTINGS, cropZoom: 2 });
    expect(printSourceResolution(3_000, 4_000, geometry, { cropX: 0.1, cropY: 0.8, cropZoom: 2 }))
      .toEqual(centered);
  });

  it("rejects undersized recovered artwork before invoking Images", async () => {
    const images = new RecordingImages(4_682, 5_291);
    await expect(renderPrintAsset(images, SOURCE, 1_080, 1_920,
      { width: 4_682, height: 5_291, decorationMethod: "dtg" }, SETTINGS))
      .rejects.toThrow("below 150 PPI");
    expect(images.inputCount).toBe(0);
  });

  it("recovers missing dimensions from integrity-checked historical artwork", () => {
    expect(artworkDimensionsCanBeResolved(null, null)).toBe(true);
    expect(artworkDimensionsCanBeResolved(3_000, 4_000)).toBe(true);
    expect(artworkDimensionsCanBeResolved(null, 4_000)).toBe(false);
    expect(artworkDimensionsCanBeResolved(0, 4_000)).toBe(false);
  });

  it("creates a stable normalized key", () => {
    expect(printGeometryKey({
      decorationMethod: " DTG ",
      height: 5_100,
      width: 4_500,
    })).toBe("dtg:4500x5100");
  });

  it("rejects unsafe method and dimension values", () => {
    expect(() => printGeometryKey({
      decorationMethod: "dtg/front",
      height: 5_100,
      width: 4_500,
    })).toThrow("invalid decoration method");
    expect(() => printGeometryKey({
      decorationMethod: "dtg",
      height: 5_100,
      width: 12_001,
    })).toThrow("dimensions are invalid");
  });
});

describe("print asset crop planning", () => {
  it("contains and centres portrait artwork in the provider geometry", () => {
    expect(planCroppedSource(3_000, 4_000, {
      height: 5_100,
      width: 4_500,
    }, SETTINGS)).toEqual({
      destinationLeft: 338,
      destinationTop: 0,
      height: 5_100,
      trimBottom: 0,
      trimLeft: 0,
      trimRight: 0,
      trimTop: 0,
      width: 3_825,
    });
  });

  it("flattens recursive placement into final source layers", () => {
    expect(planRecursiveLayers({
      destinationLeft: 338,
      destinationTop: 0,
      height: 5_100,
      trimBottom: 0,
      trimLeft: 0,
      trimRight: 0,
      trimTop: 0,
      width: 3_825,
    }, { height: 5_100, width: 4_500 }, SETTINGS)).toEqual([
      {
        destinationLeft: 338,
        destinationTop: 0,
        height: 5_100,
        trimBottom: 0,
        trimLeft: 0,
        trimRight: 0,
        trimTop: 0,
        width: 3_825,
      },
      {
        destinationLeft: 1_418,
        destinationTop: 2_040,
        height: 1_020,
        trimBottom: 0,
        trimLeft: 0,
        trimRight: 0,
        trimTop: 0,
        width: 765,
      },
      {
        destinationLeft: 1_634,
        destinationTop: 2_448,
        height: 204,
        trimBottom: 0,
        trimLeft: 0,
        trimRight: 0,
        trimTop: 0,
        width: 153,
      },
    ]);
  });

  it("turns negative canvas offsets into deterministic source trims", () => {
    expect(planCroppedSource(3_000, 4_000, {
      height: 5_100,
      width: 4_500,
    }, { cropX: 1, cropY: 0.5, cropZoom: 1 })).toEqual({
      destinationLeft: 0,
      destinationTop: 0,
      height: 5_100,
      trimBottom: 0,
      trimLeft: 1_575,
      trimRight: 0,
      trimTop: 0,
      width: 3_825,
    });
  });
});

describe("print asset rendering", () => {
  it("accepts a full-resolution PNG above the source upload cap without another Images upload", async () => {
    const geometry = { decorationMethod: "dtg", width: 2_400, height: 2_300 };
    const bytes = printPng(geometry.width, geometry.height, { uncompressed: true });
    expect(bytes.byteLength).toBeGreaterThan(20 * 1024 * 1024);
    const images = new RecordingImages(geometry.width, geometry.height, "image/png", 200, bytes);
    images.info = () => Promise.reject(new Error("IMAGES_INFO_ERROR 9502: Images binding connection error"));
    const result = await renderPrintAsset(images, SOURCE, 2_400, 2_300, geometry,
      { ...SETTINGS, printMode: "base-image-only" });
    expect(result.bytes.byteLength).toBe(bytes.byteLength);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("renders the full recursive depth and validates the final PNG", async () => {
    const images = new RecordingImages(4_500, 5_100);
    const result = await renderPrintAsset(images, SOURCE, 3_000, 4_000, {
      decorationMethod: "dtg",
      height: 5_100,
      width: 4_500,
    }, SETTINGS);

    expect(result.bytes).toEqual(new Uint8Array(OUTPUT));
    expect(result.width).toBe(4_500);
    expect(result.height).toBe(5_100);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(images.inputCount).toBe(4);
    expect(images.outputCount).toBe(1);
    expect(images.operations.filter((operation) => operation.kind === "draw"))
      .toHaveLength(3);
    expect(images.operations.filter((operation) =>
      operation.kind === "draw" && operation.source === "transformer"
    )).toHaveLength(3);
    expect(images.operations.filter((operation) =>
      operation.kind === "draw" && operation.source === "stream"
    )).toHaveLength(0);
    expect(images.operations).toContainEqual({
      kind: "transform",
      options: { fit: "squeeze", height: 1_020, width: 765 },
    });
    const [canvas] = await Promise.all(images.inputs);
    if (!canvas) throw new Error("Expected the transparent canvas input.");
    expect(createHash("sha256").update(canvas).digest("hex"))
      .toBe("ca9b4e40a0cd14acc275b2313647e2ff8ca1e6fa57ad3db8d67665288b41bb79");
    expect(images.operations.filter((operation) =>
      operation.kind === "transform" &&
      operation.options.fit === "squeeze" &&
      operation.options.height === 5_100 &&
      operation.options.width === 4_500
    )).toHaveLength(1);
    expect(images.operations).toContainEqual({
      kind: "transform",
      options: { fit: "squeeze", height: 5_100, width: 4_500 },
    });
  });

  it("avoids repeated full-size PNG encodes for a large portrait without exceeding graph input limits", async () => {
    const images = new RecordingImages(4_500, 5_100);
    await renderPrintAsset(images, new Uint8Array(9_000_000), 3_000, 4_000, {
      decorationMethod: "dtg", height: 5_100, width: 4_500,
    }, { ...SETTINGS, depth: 5 });
    // Three bounded graphs replace four individual overlays and a final PNG.
    expect(images.outputCount).toBe(3);
  });

  it("uses two bounded graphs for the uncropped camera fixture at the operation ceiling", async () => {
    const images = new RecordingImages(4_682, 5_291);
    await renderPrintAsset(images, new Uint8Array(5_613_111), 2_400, 3_600, {
      decorationMethod: "dtg", height: 5_291, width: 4_682,
    }, { ...SETTINGS, depth: 5 });
    expect(images.outputCount).toBe(2);
  });

  it.each([4, 6_120_149])("completes a cropped depth-five portrait within the transform limit (%i bytes)", async (sourceBytes) => {
    const images = new RecordingImages(4_682, 5_291);
    await expect(renderPrintAsset(images, new Uint8Array(sourceBytes), 3_024, 4_032, {
      decorationMethod: "dtg", height: 5_291, width: 4_682,
    }, { ...SETTINGS, cropX: 0.7, cropZoom: 1.1, depth: 5 })).resolves.toMatchObject({ height: 5_291, width: 4_682 });
    expect(images.operations.filter(operation => operation.kind === "draw" && operation.source === "transformer")).toHaveLength(6);
  });

  it.each([
    { sourceBytes: 5_613_111, width: 2_400, height: 3_600, cropX: 0.5, cropZoom: 1, outputs: 2 },
    { sourceBytes: 6_120_149, width: 3_024, height: 4_032, cropX: 0.7, cropZoom: 1.1, outputs: 3 },
  ])("groups small recursive layers in bounded subcanvases ($sourceBytes bytes)", async (fixture) => {
    const images = new RecordingImages(4_682, 5_291);
    await renderPrintAsset(images, new Uint8Array(fixture.sourceBytes), fixture.width, fixture.height, {
      decorationMethod: "dtg", height: 5_291, width: 4_682,
    }, { ...SETTINGS, cropX: fixture.cropX, cropZoom: fixture.cropZoom, depth: 5 });
    expect(images.outputCount).toBe(fixture.outputs);
    expect(images.outputSizes.filter(size => size.width === 4_682 && size.height === 5_291)).toHaveLength(1);
    expect(images.operations.filter(operation => operation.kind === "transform" &&
      operation.options.width === 4_682 && operation.options.height === 5_291)).toHaveLength(1);
  });

  it("falls back to sequential composition when actual grouped bytes exceed the input budget", async () => {
    const images = new RecordingImages(4_500, 5_100, "image/png", 200, printPng(4_500, 5_100, { paddingBytes: 3_000_000 }));
    await expect(renderPrintAsset(images, new Uint8Array(9_000_000), 3_000, 4_000, {
      decorationMethod: "dtg", height: 5_100, width: 4_500,
    }, SETTINGS)).resolves.toMatchObject({ height: 5_100, width: 4_500 });
    // One attempted tail, then the original three-output fallback.
    expect(images.outputCount).toBe(4);
  });

  it.each([1, 5, 8])("keeps graph limits for extreme allowed placement at depth %i", async depth => {
    for (const placementWidth of [0.08, 0.48]) {
      const images = new RecordingImages(4_682, 5_291);
      await renderPrintAsset(images, new Uint8Array(6_120_149), 3_024, 4_032, {
        decorationMethod: "dtg", height: 5_291, width: 4_682,
      }, { ...SETTINGS, cropX: 0.7, cropZoom: 1.1, depth, placementWidth,
        placementX: 1 - placementWidth, placementY: 1 - placementWidth });
      expect(images.outputCount).toBeGreaterThan(0);
    }
  });

  it("does not retry failed grouped transforms through the fallback", async () => {
    const images = new RecordingImages(4_682, 5_291, "image/png", 503);
    await expect(renderPrintAsset(images, new Uint8Array(5_613_111), 2_400, 3_600, {
      decorationMethod: "dtg", height: 5_291, width: 4_682,
    }, { ...SETTINGS, depth: 5 })).rejects.toThrow("rendering returned 503");
    expect(images.outputCount).toBe(1);
  });

  it("rejects an output whose dimensions do not match the provider", async () => {
    const images = new RecordingImages(4_499, 5_100);
    await expect(renderPrintAsset(images, SOURCE, 3_000, 4_000, {
      decorationMethod: "dtg",
      height: 5_100,
      width: 4_500,
    }, SETTINGS)).rejects.toThrow("invalid PNG geometry");
  });
});

function byteStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

it("base-image-only print keeps the original outer layer and never includes recursive insets", () => {
  const geometry = { width: 4500, height: 5100 };
  const crop = planCroppedSource(3000, 4000, geometry, SETTINGS);
  const recursive = planRecursiveLayers(crop, geometry, SETTINGS);
  const base = planRecursiveLayers(crop, geometry, { ...SETTINGS, printMode: "base-image-only" });
  expect(recursive).toHaveLength(SETTINGS.depth + 1);
  expect(base).toEqual([recursive[0]]);
});
