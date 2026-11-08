import {
  MAX_DESIGN_ARTWORK_BYTES,
  MAX_DESIGN_SOURCE_BYTES,
  MAX_DESIGN_SOURCE_EDGE,
  MAX_DESIGN_SOURCE_PIXELS,
  MAX_PREPARED_ARTWORK_BYTES,
} from "@forever-tee/contracts/limits";

export const MAX_SOURCE_BYTES = MAX_DESIGN_SOURCE_BYTES;
const MAX_SOURCE_EDGE = MAX_DESIGN_SOURCE_EDGE;
const MAX_SOURCE_PIXELS = MAX_DESIGN_SOURCE_PIXELS;
const MAX_PREVIEW_EDGE = 1_600;
export const MODERATION_PREVIEW_MAX_BYTES = 512 * 1_024;
export const MODERATION_PREVIEW_MAX_EDGE = 512;
export const MAX_OUTPUT_BYTES = MAX_DESIGN_ARTWORK_BYTES;
export const JPEG_CONTENT_TYPE = "image/jpeg";

interface ProcessedImage {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly width: number;
}

interface InvalidImage {
  readonly ok: false;
  readonly reason: "invalid" | "dependency" | "output-too-large" | "quota";
}

export type ImageProcessingResult = ProcessedImage | InvalidImage;

interface ValidatedImage {
  readonly height: number;
  readonly width: number;
}

type ImageValidationResult =
  | { readonly ok: true; readonly image: ValidatedImage }
  | { readonly ok: false; readonly reason: "dependency" | "invalid" };

export interface ModerationPreview {
  readonly bytes: Uint8Array;
  readonly contentType: typeof JPEG_CONTENT_TYPE;
}

type ModerationPreviewResult =
  | { readonly ok: true; readonly preview: ModerationPreview }
  | {
    readonly ok: false;
    readonly reason: "dependency" | "output-too-large";
  };

interface ImageProcessingInfo {
  readonly format: string;
  readonly height?: number;
  readonly width?: number;
}

interface ImageProcessingOutput {
  response(): Response;
}

interface ImageProcessingTransformer {
  transform(options: ImageTransform): ImageProcessingTransformer;
  output(options: ImageOutputOptions): Promise<ImageProcessingOutput>;
}

export interface ImageProcessingBinding {
  info(stream: ReadableStream<Uint8Array>): Promise<ImageProcessingInfo>;
  input(stream: ReadableStream<Uint8Array>): ImageProcessingTransformer;
}

export async function processJpeg(
  images: ImageProcessingBinding,
  bytes: Uint8Array,
  quality: "preview" | "print",
  beforeTransform: () => Promise<boolean>,
): Promise<ImageProcessingResult> {
  const validation = await validateJpeg(images, bytes);
  if (!validation.ok) return validation;
  if (!await beforeTransform()) return { ok: false, reason: "quota" };
  return segmentJpeg(images, bytes, validation.image, quality);
}

async function validateJpeg(
  images: ImageProcessingBinding,
  bytes: Uint8Array,
): Promise<ImageValidationResult> {
  if (!hasJpegMagic(bytes)) return { ok: false, reason: "invalid" };
  return validateSourceImage(images, bytes);
}

export async function validateSourceImage(
  images: ImageProcessingBinding,
  bytes: Uint8Array,
): Promise<ImageValidationResult> {
  const detected = sourceContentType(bytes);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_SOURCE_BYTES ||
    !detected
  ) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const info = await images.info(byteStream(bytes));
    if (
      info.format === "image/svg+xml" ||
      normalizedFormat(info.format) !== detected ||
      typeof info.width !== "number" ||
      typeof info.height !== "number" ||
      !Number.isInteger(info.width) ||
      !Number.isInteger(info.height) ||
      info.width <= 0 ||
      info.height <= 0 ||
      info.width > MAX_SOURCE_EDGE ||
      info.height > MAX_SOURCE_EDGE ||
      info.width * info.height > MAX_SOURCE_PIXELS
    ) {
      return { ok: false, reason: "invalid" };
    }
    return {
      ok: true,
      image: { height: info.height, width: info.width },
    };
  } catch (error) {
    logImageFailure("source-info", "exception", { inputBytes: bytes.byteLength }, error);
    return { ok: false, reason: "dependency" };
  }
}

export async function deriveModerationPreview(
  images: ImageProcessingBinding,
  bytes: Uint8Array,
): Promise<ModerationPreviewResult> {
  try {
    const output = await images.input(byteStream(bytes))
      .transform({
        fit: "scale-down",
        height: MODERATION_PREVIEW_MAX_EDGE,
        width: MODERATION_PREVIEW_MAX_EDGE,
      })
      .output({ format: "image/jpeg", quality: 75 });
    const response = output.response();
    if (!response.ok || !response.body) {
      logImageFailure("moderation-preview", "response", { inputBytes: bytes.byteLength, status: response.status });
      return { ok: false, reason: "dependency" };
    }
    const preview = await readBoundedStream(
      response.body,
      MODERATION_PREVIEW_MAX_BYTES,
    );
    return preview
      ? {
        ok: true,
        preview: { bytes: preview, contentType: JPEG_CONTENT_TYPE },
      }
      : { ok: false, reason: "output-too-large" };
  } catch (error) {
    logImageFailure("moderation-preview", "exception", { inputBytes: bytes.byteLength }, error);
    return { ok: false, reason: "dependency" };
  }
}

export async function segmentJpeg(
  images: ImageProcessingBinding,
  bytes: Uint8Array,
  image: ValidatedImage,
  quality: "preview" | "print",
  removeBackground = true,
): Promise<ImageProcessingResult> {
  try {
    const edge = quality === "preview" ? MAX_PREVIEW_EDGE : Math.max(image.width, image.height);
    const resized = images.input(byteStream(bytes))
      .transform({ fit: "scale-down", height: edge, width: edge });
    const output = await (removeBackground ? resized.transform({ segment: "foreground" }) : resized)
      .output({ format: "image/png" });
    const response = output.response();
    if (!response.ok || !response.body) {
      logImageFailure("segment-jpeg", "response", { inputBytes: bytes.byteLength, status: response.status });
      return { ok: false, reason: "dependency" };
    }
    const result = await readBoundedStream(response.body, MAX_OUTPUT_BYTES);
    const scale = Math.min(1, edge / image.width, edge / image.height);
    return result
      ? {
        ok: true,
        bytes: result,
        height: Math.max(1, Math.round(image.height * scale)),
        width: Math.max(1, Math.round(image.width * scale)),
      }
      : { ok: false, reason: "output-too-large" };
  } catch (error) {
    logImageFailure("segment-jpeg", "exception", { inputBytes: bytes.byteLength }, error);
    return { ok: false, reason: "dependency" };
  }
}

// Retain every source pixel. Lossless WebP avoids PNG expansion for most
// photos; bounded high-quality encodings handle detailed camera images without
// reducing their dimensions. The result must remain usable as an Images input.
export async function prepareStoredArtwork(
  images: ImageProcessingBinding,
  bytes: Uint8Array,
  removeBackground: boolean,
  sourceDimensions: ValidatedImage,
): Promise<ImageProcessingResult> {
  const stage = removeBackground ? "stored-cutout" : "stored-original";
  const metadata = {
    inputBytes: bytes.byteLength,
    sourceWidth: sourceDimensions.width,
    sourceHeight: sourceDimensions.height,
  };
  for (const quality of [100, 95, 90, 85]) {
    const startedAt = performance.now();
    let operation: "encode" | "read-output" | "output-info" = "encode";
    try {
      const input = images.input(byteStream(bytes));
      const output = await input.transform(removeBackground ? { segment: "foreground" } : { background: "white" })
        .output({ format: "image/webp", quality, anim: false });
      const encodedAt = performance.now();
      const response = output.response();
      if (!response.ok || !response.body) {
        logImageFailure(stage, "response", { ...metadata, quality, status: response.status });
        return { ok: false, reason: "dependency" };
      }
      operation = "read-output";
      const result = await readBoundedStream(response.body, MAX_PREPARED_ARTWORK_BYTES);
      const readAt = performance.now();
      if (!result) {
        console.info("bent.shop image encoding exceeded limit", {
          stage, quality, ...metadata,
          encodeDurationMs: Math.round(encodedAt - startedAt),
          readDurationMs: Math.round(readAt - encodedAt),
        });
        continue;
      }
      operation = "output-info";
      const info = await images.info(byteStream(result));
      const sameDimensions = info.width === sourceDimensions.width && info.height === sourceDimensions.height;
      const rotatedDimensions = info.width === sourceDimensions.height && info.height === sourceDimensions.width;
      if (!validDimensions(info.width, info.height) || info.width === undefined || info.height === undefined ||
        (!sameDimensions && !rotatedDimensions)) {
        logImageFailure(stage, "dimensions", {
          ...metadata, quality, outputBytes: result.byteLength,
          ...(typeof info.width === "number" && Number.isFinite(info.width) ? { outputWidth: info.width } : {}),
          ...(typeof info.height === "number" && Number.isFinite(info.height) ? { outputHeight: info.height } : {}),
        });
        return { ok: false, reason: "dependency" };
      }
      // Numeric diagnostics only. Invocation metadata supplies correlation;
      // never include photo bytes, URLs, metadata or provider response bodies.
      console.info("bent.shop image preparation completed", {
        stage, quality, ...metadata, outputBytes: result.byteLength,
        encodeDurationMs: Math.round(encodedAt - startedAt),
        readDurationMs: Math.round(readAt - encodedAt),
        infoDurationMs: Math.round(performance.now() - readAt),
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { ok: true, bytes: result, width: info.width, height: info.height };
    } catch (error) {
      logImageFailure(stage, operation, {
        ...metadata, quality, durationMs: Math.round(performance.now() - startedAt),
      }, error);
      // A provider transform failure or timeout must not skip the high-quality encodings
      // already used for oversized output. Retry once after lossless failure;
      // other provider error codes are not retried.
      const providerCode = imageProviderCode(error);
      if (quality === 100 && (providerCode === 9523 || providerCode === 9529)) continue;
      return { ok: false, reason: "dependency" };
    }
  }
  logImageFailure(stage, "output-too-large", metadata);
  return { ok: false, reason: "output-too-large" };
}

// Cloudflare attaches invocation/ray IDs to this event. Never log source bytes,
// URLs, provider response bodies or arbitrary exception messages here.
function logImageFailure(
  stage: "source-info" | "moderation-preview" | "segment-jpeg" | "stored-original" | "stored-cutout",
  failure: "exception" | "response" | "dimensions" | "output-too-large" | "encode" | "read-output" | "output-info",
  metadata: Readonly<Record<string, number>>,
  error?: unknown,
) {
  const providerCode = imageProviderCode(error);
  console.warn("bent.shop image processing failed", {
    stage, failure, ...metadata,
    ...(providerCode === undefined ? {} : { providerCode }),
  });
}

function imageProviderCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "number" && Number.isSafeInteger(error.code) ? error.code : undefined;
}

function validDimensions(width: number | undefined, height: number | undefined) {
  return width !== undefined && height !== undefined && Number.isInteger(width) && Number.isInteger(height) &&
    width > 0 && height > 0 && width <= MAX_SOURCE_EDGE && height <= MAX_SOURCE_EDGE &&
    width * height <= MAX_SOURCE_PIXELS;
}

export function sourceContentType(bytes: Uint8Array): string | undefined {
  if (hasJpegMagic(bytes)) return JPEG_CONTENT_TYPE;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

function hasJpegMagic(bytes: Uint8Array) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
}

function normalizedFormat(format: string) {
  const value = format.toLowerCase();
  if (["jpeg", "jpg", "image/jpeg"].includes(value)) return "image/jpeg";
  if (["png", "image/png"].includes(value)) return "image/png";
  if (["webp", "image/webp"].includes(value)) return "image/webp";
  return undefined;
}

export function byteStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let next = await reader.read();
  while (!next.done) {
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
