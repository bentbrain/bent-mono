import { missingRequiredPrintGeometrySql, requiredPrintGeometryCtesSql } from "./print-asset-recovery-candidates.ts";
import { createHash } from "node:crypto";
import { isPrintMemoryCapacityError, printBufferAdmission, PRINT_STREAM_BUFFER_BYTES } from "./print-asset-memory.ts";
import { createPrintStagingSession, publishStagedPrint, type EncodedPrint, type StagedPrint } from "./print-asset-staging.ts";
export { isPrintMemoryCapacityError } from "./print-asset-memory.ts";
import { MAX_DESIGN_ARTWORK_BYTES, MAX_PRINT_ASSET_BYTES } from "@forever-tee/contracts/limits";
import { validatePrintPng } from "./print-png.ts";
import { Data, Effect } from "effect";

const PRINT_ASSET_CONTENT_TYPE = "image/png";
const MAX_GEOMETRY_EDGE = 12_000;
const PRINT_CANVAS_DPI = 300;
const MINIMUM_SOURCE_PPI = 150;
const PRINT_ASSET_RENDER_LEASE_MS = 60_000;
const PRINT_ASSET_RENDER_SLOT_WAIT_MS = 250;
const PRINT_ASSET_RENDER_SLOT_MAX_WAIT_MS = 2_000;
const PRINT_ASSET_RENDER_SLOT_WAIT_LIMIT_MS = 55_000;
const PRINT_ASSET_RECONCILIATION_LIMIT = 3;
const PRINT_ASSET_RETRY_CLAIM_MS = 5 * 60_000;
const PRINT_ASSET_RETRY_BASE_MS = 15 * 60_000;
const PRINT_ASSET_RETRY_MAX_MS = 24 * 60 * 60_000;
const TRANSPARENT_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 1, 115, 82, 71, 66, 0, 174, 206, 28, 233, 0, 0, 0, 4,
  115, 66, 73, 84, 8, 8, 8, 8, 124, 8, 100, 136, 0, 0, 0, 11, 73,
  68, 65, 84, 8, 153, 99, 96, 0, 2, 0, 0, 5, 0, 1, 98, 85, 50,
  136, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

export interface PrintGeometry {
  readonly decorationMethod: string;
  readonly height: number;
  readonly width: number;
}

export interface PrintAssetSettings {
  readonly printMode?: "recursive" | "base-image-only";
  readonly cropX: number;
  readonly cropY: number;
  readonly cropZoom: number;
  readonly depth: number;
  readonly placementWidth: number;
  readonly placementX: number;
  readonly placementY: number;
}

interface PrintAssetEnv {
  readonly DB: D1Database;
  readonly DESIGN_ARTWORK: R2Bucket;
  readonly IMAGES: ImagesBinding;
}

interface PrintAssetImageBinding {
  info(stream: ReadableStream<Uint8Array>): Promise<ImageInfoResponse>;
  input(stream: ReadableStream<Uint8Array>): ImageTransformer;
}

interface ProductSourceRow {
  readonly print_mode: "recursive" | "base-image-only";
  readonly artwork_height: number | null;
  readonly artwork_key: string;
  readonly artwork_sha256: string;
  readonly artwork_width: number | null;
  readonly base_product_id: string;
  readonly byte_size: number;
  readonly configured_product_id: string;
  readonly crop_x: number;
  readonly crop_y: number;
  readonly crop_zoom: number;
  readonly design_id: string;
  readonly design_revision_id: string;
  readonly placement_depth: number;
  readonly placement_width: number;
  readonly placement_x: number;
  readonly placement_y: number;
  readonly projection_version: string;
}

type ArtworkSource = Pick<ProductSourceRow, "artwork_key" | "artwork_sha256" | "byte_size">;

export interface PrintAssetQueueContext {
  dispose(): void;
  readSource(source: ArtworkSource): Promise<Uint8Array>;
  runGeometry(operation: () => Promise<void>): Promise<void>;
}

// One queue invocation can prepare both family members without duplicating the
// portrait buffer. Queued families may start all four required geometries,
// while every slot still reserves bytes from the same isolate-wide budget.
export function createPrintAssetQueueContext(env: PrintAssetEnv, geometryLimit: 3 | 4 = 3): PrintAssetQueueContext {
  const sources = new Map<string, Promise<Uint8Array>>();
  const releaseSources: (() => void)[] = [];
  let streamCreditAvailable = false;
  let disposed = false;
  let active = 0;
  const waiting: (() => void)[] = [];
  const geometryWaiting: (() => void)[] = [];
  return {
    dispose() {
      if (active || waiting.length || geometryWaiting.length) throw new Error("Print context disposed before renders settled.");
      disposed = true;
      // Drop the last retained portrait promises before advertising free bytes.
      sources.clear();
      for (const release of releaseSources) release();
      releaseSources.length = 0;
      streamCreditAvailable = false;
    },
    readSource(source) {
      if (disposed) throw new Error("Print context is disposed.");
      const key = JSON.stringify([source.artwork_key, source.artwork_sha256, source.byte_size]);
      let pending = sources.get(key);
      if (!pending) {
        if (source.byte_size <= 0 || source.byte_size > MAX_DESIGN_ARTWORK_BYTES) {
          throw new Error("Print source exceeds the supported limit.");
        }
        // Admit at least one geometry together with the portrait: families can
        // never fill the pool with sources while none can start their render.
        const first = sources.size === 0;
        const release = printBufferAdmission.reserve(source.byte_size + (first ? PRINT_STREAM_BUFFER_BYTES : 0));
        if (first) streamCreditAvailable = true;
        releaseSources.push(release);
        pending = readVerifiedArtworkSource(env.DESIGN_ARTWORK, source);
        sources.set(key, pending);
      }
      return pending;
    },
    async runGeometry(operation) {
      if (disposed) throw new Error("Print context is disposed.");
      if (active >= geometryLimit) await new Promise<void>(resolve => { geometryWaiting.push(resolve); });
      else active += 1;
      let credit = streamCreditAvailable;
      let release: (() => void) | undefined;
      if (credit) streamCreditAvailable = false;
      else {
        try { release = printBufferAdmission.reserve(PRINT_STREAM_BUFFER_BYTES); }
        catch (error) {
          if (!isPrintMemoryCapacityError(error)) throw error;
          // This admitted family already owns one slot. Wait only on that
          // bounded local slot, never on memory another family must release.
          await new Promise<void>(resolve => { waiting.push(resolve); });
          credit = true;
        }
      }
      try { await operation(); }
      finally {
        const nextGeometry = geometryWaiting.shift();
        if (nextGeometry) nextGeometry();
        else active -= 1;
        if (credit) {
          const next = waiting.shift();
          if (next) next();
          else streamCreditAvailable = true;
        }
        release?.();
      }
    },
  };
}

async function readVerifiedArtworkSource(bucket: R2Bucket, source: ArtworkSource) {
  const object = await bucket.get(source.artwork_key);
  if (object?.size !== source.byte_size) {
    await object?.body.cancel();
    throw new Error("Configured product artwork is unavailable.");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== source.byte_size || bytesToHex(await sha256(bytes)) !== source.artwork_sha256) {
    throw new Error("Configured product artwork failed its integrity check.");
  }
  return bytes;
}

interface GeometryRow {
  readonly decoration_method: string;
  readonly print_height: number;
  readonly print_width: number;
}

interface AssetRow {
  readonly base_product_id: string;
  readonly byte_size: number | null;
  readonly design_revision_id: string;
  readonly geometry_key: string;
  readonly height_px: number | null;
  readonly id: string;
  readonly object_sha256: string | null;
  readonly object_storage_key: string | null;
  readonly projection_version: string;
  readonly sha256: string | null;
  readonly status: string;
  readonly storage_key: string | null;
  readonly width_px: number | null;
}

interface PrintAssetObjectRow {
  readonly byte_size: number;
  readonly content_type: string;
  readonly height_px: number;
  readonly sha256: string;
  readonly storage_key: string;
  readonly width_px: number;
}

interface PrintAssetRenderLease {
  readonly leaseId: string;
  readonly slot: number;
}

interface PrintAssetRenderSlotRow {
  readonly slot: number;
}

interface PrintAssetReconciliationRow {
  readonly configured_product_id: string;
}

class PrintAssetRenderDatabaseError extends Data.TaggedError(
  "PrintAssetRenderDatabaseError",
)<{ readonly operation: string }> {}

class PrintAssetRenderCapacityError extends Data.TaggedError(
  "PrintAssetRenderCapacityError",
)<{ readonly message: string }> {}

class PrintAssetRenderingError extends Data.TaggedError(
  "PrintAssetRenderingError",
)<{ readonly message: string }> {}

export interface CropPlan {
  readonly destinationLeft: number;
  readonly destinationTop: number;
  readonly height: number;
  readonly trimBottom: number;
  readonly trimLeft: number;
  readonly trimRight: number;
  readonly trimTop: number;
  readonly width: number;
}

export interface RecursiveLayerPlan {
  readonly destinationLeft: number;
  readonly destinationTop: number;
  readonly height: number;
  readonly trimBottom: number;
  readonly trimLeft: number;
  readonly trimRight: number;
  readonly trimTop: number;
  readonly width: number;
}

export interface RenderedPrintAsset {
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly sha256: string;
  readonly sha256Bytes: Uint8Array;
  readonly width: number;
}

export function printGeometryKey(geometry: PrintGeometry) {
  const method = geometry.decorationMethod.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(method)) {
    throw new Error("Print geometry has an invalid decoration method.");
  }
  validateDimension(geometry.width);
  validateDimension(geometry.height);
  return `${method}:${String(geometry.width)}x${String(geometry.height)}`;
}

function printAssetObjectKey(sha256: string) {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("Print asset object checksum is invalid.");
  }
  return `print-assets/blobs/${sha256}.png`;
}

export function artworkDimensionsCanBeResolved(
  width: number | null,
  height: number | null,
) {
  const storedDimensionsAreValid =
    width !== null && height !== null &&
    validDimension(width) && validDimension(height);
  const dimensionsCanBeRecovered = width === null && height === null;
  return storedDimensionsAreValid || dimensionsCanBeRecovered;
}

export function planCroppedSource(
  sourceWidth: number,
  sourceHeight: number,
  geometry: Pick<PrintGeometry, "height" | "width">,
  settings: Pick<PrintAssetSettings, "cropX" | "cropY" | "cropZoom">,
): CropPlan {
  validateDimension(sourceWidth);
  validateDimension(sourceHeight);
  validateDimension(geometry.width);
  validateDimension(geometry.height);
  if (
    !isUnit(settings.cropX) || !isUnit(settings.cropY) ||
    !Number.isFinite(settings.cropZoom) || settings.cropZoom <= 0
  ) {
    throw new Error("Print asset crop settings are invalid.");
  }
  const containScale = Math.min(
    geometry.width / sourceWidth,
    geometry.height / sourceHeight,
  );
  const width = Math.max(1, Math.round(sourceWidth * containScale * settings.cropZoom));
  const height = Math.max(1, Math.round(sourceHeight * containScale * settings.cropZoom));
  const untrimmedLeft = Math.round(geometry.width / 2 - settings.cropX * width);
  const untrimmedTop = Math.round(geometry.height / 2 - settings.cropY * height);
  const trimLeft = Math.max(0, -untrimmedLeft);
  const trimTop = Math.max(0, -untrimmedTop);
  const trimRight = Math.max(0, untrimmedLeft + width - geometry.width);
  const trimBottom = Math.max(0, untrimmedTop + height - geometry.height);
  if (trimLeft + trimRight >= width || trimTop + trimBottom >= height) {
    throw new Error("Print asset crop falls outside the print geometry.");
  }
  return {
    destinationLeft: Math.max(0, untrimmedLeft),
    destinationTop: Math.max(0, untrimmedTop),
    height,
    trimBottom,
    trimLeft,
    trimRight,
    trimTop,
    width,
  };
}

export function printSourceResolution(
  sourceWidth: number,
  sourceHeight: number,
  geometry: Pick<PrintGeometry, "height" | "width">,
  settings: Pick<PrintAssetSettings, "cropX" | "cropY" | "cropZoom">,
) {
  const crop = planCroppedSource(sourceWidth, sourceHeight, geometry, settings);
  // Trimming removes source pixels too; it cannot improve their printed density.
  // The outer portrait is largest. Every recursive copy is smaller.
  const ppi = PRINT_CANVAS_DPI * Math.min(
    sourceWidth / crop.width,
    sourceHeight / crop.height,
  );
  return { ppi, safe: ppi >= MINIMUM_SOURCE_PPI };
}

// Use the same accepted supplier geometry and source pixels as print rendering.
// The current shirt M area is also used for every larger size.
export function maximumPrintCropZoom(
  sourceWidth: number,
  sourceHeight: number,
  geometry: Pick<PrintGeometry, "height" | "width">,
) {
  validateDimension(sourceWidth);
  validateDimension(sourceHeight);
  validateDimension(geometry.width);
  validateDimension(geometry.height);
  const containScale = Math.min(geometry.width / sourceWidth, geometry.height / sourceHeight);
  // Round down so serialization and gesture arithmetic cannot cross the boundary.
  return Math.floor(Math.min(2.6, PRINT_CANVAS_DPI / MINIMUM_SOURCE_PPI / containScale) * 1_000_000) / 1_000_000;
}

export async function productMaximumCropZoom(
  db: D1Database,
  baseProductId: string,
  sourceWidth: number,
  sourceHeight: number,
) {
  const geometries = await readPrintGeometries(db, baseProductId);
  return geometries.length === 0 ? null : Math.min(...geometries.map(geometry =>
    maximumPrintCropZoom(sourceWidth, sourceHeight, geometry)
  ));
}

export async function productPrintResolution(
  db: D1Database,
  baseProductId: string,
  sourceWidth: number,
  sourceHeight: number,
  settings: Pick<PrintAssetSettings, "cropX" | "cropY" | "cropZoom">,
) {
  const geometries = await readPrintGeometries(db, baseProductId);
  if (geometries.length === 0) return undefined;
  const ppi = Math.min(...geometries.map((geometry) =>
    printSourceResolution(sourceWidth, sourceHeight, geometry, settings).ppi
  ));
  return { ppi, safe: ppi >= MINIMUM_SOURCE_PPI };
}

export function planRecursiveLayers(
  crop: CropPlan,
  geometry: Pick<PrintGeometry, "height" | "width">,
  settings: Pick<
    PrintAssetSettings,
    "depth" | "placementWidth" | "placementX" | "placementY" | "printMode"
  >,
): RecursiveLayerPlan[] {
  const layers: RecursiveLayerPlan[] = [];
  let originLeft = 0;
  let originTop = 0;
  let scale = 1;
  for (let level = 0; level <= (settings.printMode === "base-image-only" ? 0 : settings.depth); level += 1) {
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));
    const visibleWidth = Math.max(1, Math.round(
      (crop.width - crop.trimLeft - crop.trimRight) * scale,
    ));
    const visibleHeight = Math.max(1, Math.round(
      (crop.height - crop.trimTop - crop.trimBottom) * scale,
    ));
    const trimLeft = Math.min(
      width - visibleWidth,
      Math.round(crop.trimLeft * scale),
    );
    const trimTop = Math.min(
      height - visibleHeight,
      Math.round(crop.trimTop * scale),
    );
    layers.push({
      destinationLeft: Math.round(
        originLeft + crop.destinationLeft * scale,
      ),
      destinationTop: Math.round(
        originTop + crop.destinationTop * scale,
      ),
      height,
      trimBottom: height - visibleHeight - trimTop,
      trimLeft,
      trimRight: width - visibleWidth - trimLeft,
      trimTop,
      width,
    });
    originLeft += settings.placementX * geometry.width * scale;
    originTop += settings.placementY * geometry.height * scale;
    scale *= settings.placementWidth;
  }
  return layers;
}

const PRINT_GRAPH_INPUT_LIMIT = 20_000_000;
const PRINT_GRAPH_TRANSFORM_LIMIT = 10;
const MAX_GROUPED_PRINT_PIXELS = 1_000_000;
const MAX_GROUPED_PRINT_BYTES = MAX_GROUPED_PRINT_PIXELS * 8 + 65_536;

interface PrintCompositionPlan {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly layers: readonly RecursiveLayerPlan[];
  readonly tail?: PrintCompositionPlan;
}

function layerNeedsTrim(layer: RecursiveLayerPlan) {
  return layer.trimTop > 0 || layer.trimRight > 0 || layer.trimBottom > 0 || layer.trimLeft > 0;
}

// Reserve a draw for the remaining layers before filling an Images graph. A
// small tail is flattened at its exact final pixel size, never resized again.
// If no bounded plan fits, retain the existing sequential renderer.
function planPrintComposition(
  layers: readonly RecursiveLayerPlan[],
  sourceBytes: number,
  canvas: Pick<PrintCompositionPlan, "left" | "top" | "width" | "height">,
): PrintCompositionPlan | undefined {
  const operations = (items: readonly RecursiveLayerPlan[]) =>
    1 + items.reduce((total, layer) => total + (layerNeedsTrim(layer) ? 3 : 2), 0);
  if (TRANSPARENT_PNG.byteLength + sourceBytes * layers.length <= PRINT_GRAPH_INPUT_LIMIT &&
    operations(layers) <= PRINT_GRAPH_TRANSFORM_LIMIT) {
    return { ...canvas, layers };
  }
  for (let split = layers.length - 1; split > 0; split -= 1) {
    const head = layers.slice(0, split);
    if (operations(head) + 1 > PRINT_GRAPH_TRANSFORM_LIMIT) continue;
    const remaining = layers.slice(split);
    const left = Math.min(...remaining.map(layer => layer.destinationLeft));
    const top = Math.min(...remaining.map(layer => layer.destinationTop));
    const right = Math.max(...remaining.map(layer => layer.destinationLeft + layer.width - layer.trimLeft - layer.trimRight));
    const bottom = Math.max(...remaining.map(layer => layer.destinationTop + layer.height - layer.trimTop - layer.trimBottom));
    const width = right - left;
    const height = bottom - top;
    // Keep intermediate buffers small and avoid changing canvas clipping.
    if (left < canvas.left || top < canvas.top || right > canvas.left + canvas.width ||
      bottom > canvas.top + canvas.height || width * height > MAX_GROUPED_PRINT_PIXELS) continue;
    // Conservative admission estimate only; actual encoded bytes are checked
    // before drawing. PNG metadata/compression can never bypass the byte cap.
    const estimatedTailBytes = width * height * 8 + 65_536;
    if (TRANSPARENT_PNG.byteLength + head.length * sourceBytes + estimatedTailBytes > PRINT_GRAPH_INPUT_LIMIT) continue;
    const tail = planPrintComposition(remaining, sourceBytes, { left, top, width, height });
    if (tail) return { ...canvas, layers: head, tail };
  }
  return undefined;
}

interface BufferedPrint extends EncodedPrint { readonly bytes: Uint8Array }
interface PrintCompositionTiming { imagesOutputMs: number; pngValidationMs: number; graphCount: number }

export async function renderPrintAsset(
  images: PrintAssetImageBinding,
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  geometry: PrintGeometry,
  settings: PrintAssetSettings,
): Promise<RenderedPrintAsset> {
  const output = await composePrintAsset(images, source, sourceWidth, sourceHeight, geometry, settings,
    async (stream, maxBytes): Promise<BufferedPrint> => {
      const bytes = await readBoundedStream(stream, maxBytes);
      if (!bytes) throw new Error("Rendered print asset exceeds the storage limit.");
      return { bytes, byteLength: bytes.byteLength, stream: () => Promise.resolve(byteStream(bytes)) };
    });
  const digest = await sha256(output.bytes);
  return { bytes: output.bytes, height: geometry.height, width: geometry.width,
    sha256: bytesToHex(digest), sha256Bytes: digest };
}

async function composePrintAsset<Output extends EncodedPrint>(
  images: PrintAssetImageBinding, source: Uint8Array, sourceWidth: number, sourceHeight: number,
  geometry: PrintGeometry, settings: PrintAssetSettings,
  readOutput: (stream: ReadableStream<Uint8Array>, maxBytes: number, intermediate: boolean) => Promise<Output>,
  timings?: PrintCompositionTiming,
): Promise<Output> {
  printGeometryKey(geometry);
  validateSettings(settings);
  if (!printSourceResolution(sourceWidth, sourceHeight, geometry, settings).safe) {
    throw new Error("The artwork resolution is below 150 PPI at its printed size.");
  }
  const crop = planCroppedSource(
    sourceWidth,
    sourceHeight,
    geometry,
    settings,
  );
  const croppedSource = (layer: RecursiveLayerPlan) => {
    let transformed = images.input(byteStream(source)).transform({
      fit: "squeeze",
      height: layer.height,
      width: layer.width,
    });
    if (layerNeedsTrim(layer)) {
      transformed = transformed.transform({
        trim: {
          bottom: layer.trimBottom,
          left: layer.trimLeft,
          right: layer.trimRight,
          top: layer.trimTop,
        },
      });
    }
    return transformed;
  };
  const outputPng = async (transformer: ImageTransformer, maxBytes = MAX_PRINT_ASSET_BYTES, intermediate = false) => {
    const start = performance.now();
    const output = await transformer.output({ format: PRINT_ASSET_CONTENT_TYPE }).finally(() => {
      if (timings) { timings.imagesOutputMs += performance.now() - start; timings.graphCount += 1; }
    });
    const response = output.response();
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Print asset rendering returned ${String(response.status)}.`);
    }
    return readOutput(response.body, maxBytes, intermediate);
  };
  // Count all original and prepared inputs in a graph. Repeated source
  // streams count separately, even when they contain identical bytes.
  const graphInputLimit = PRINT_GRAPH_INPUT_LIMIT;
  // The binding flattens resize, trim and draw into the same operation list.
  const graphTransformLimit = PRINT_GRAPH_TRANSFORM_LIMIT;
  const layers = planRecursiveLayers(crop, geometry, settings);
  const renderSequential = async () => {
    let composition = images.input(byteStream(TRANSPARENT_PNG)).transform({
      fit: "squeeze", height: geometry.height, width: geometry.width,
    });
    let inputBytes = TRANSPARENT_PNG.byteLength;
    let transforms = 1;
    const flushComposition = async () => {
      const intermediate = await outputPng(composition, PRINT_GRAPH_INPUT_LIMIT, true);
      composition = images.input(await intermediate.stream());
      inputBytes = intermediate.byteLength;
      transforms = 0;
    };
    for (const layer of layers) {
      const layerTransforms = layerNeedsTrim(layer) ? 3 : 2; // Resize, optional trim, draw.
      if (inputBytes + source.byteLength <= graphInputLimit && transforms + layerTransforms > graphTransformLimit) {
        // Small sources can hit the operation ceiling before the byte ceiling.
        await flushComposition();
      }
      if (inputBytes + source.byteLength <= graphInputLimit && transforms + layerTransforms <= graphTransformLimit) {
        composition = composition.draw(croppedSource(layer), {
          left: layer.destinationLeft, top: layer.destinationTop,
        });
        inputBytes += source.byteLength;
        transforms += layerTransforms;
        continue;
      }
      // Resize only the overlay when the original would exceed the graph budget.
      // Keep the full canvas unencoded until a byte or operation limit requires a flush.
      const overlay = await outputPng(croppedSource(layer), PRINT_GRAPH_INPUT_LIMIT, true);
      if (inputBytes + overlay.byteLength > graphInputLimit || transforms + 1 > graphTransformLimit) {
        await flushComposition();
      }
      if (inputBytes + overlay.byteLength > graphInputLimit) {
        throw new Error("Print composition exceeds the image input limit.");
      }
      composition = composition.draw(await overlay.stream(), {
        left: layer.destinationLeft, top: layer.destinationTop,
      });
      inputBytes += overlay.byteLength;
      transforms += 1;
    }
    return outputPng(composition);
  };
  const renderGrouped = async (plan: PrintCompositionPlan, intermediate = false): Promise<Output | undefined> => {
    const tailBytes = plan.tail ? await renderGrouped(plan.tail, true) : undefined;
    if (plan.tail && !tailBytes) return undefined;
    const inputBytes = TRANSPARENT_PNG.byteLength + plan.layers.length * source.byteLength + (tailBytes?.byteLength ?? 0);
    if (inputBytes > graphInputLimit || (tailBytes && tailBytes.byteLength > MAX_GROUPED_PRINT_BYTES)) return undefined;
    let composition = images.input(byteStream(TRANSPARENT_PNG)).transform({
      fit: "squeeze", height: plan.height, width: plan.width,
    });
    for (const layer of plan.layers) {
      composition = composition.draw(croppedSource(layer), {
        left: layer.destinationLeft - plan.left, top: layer.destinationTop - plan.top,
      });
    }
    if (plan.tail && tailBytes) {
      composition = composition.draw(await tailBytes.stream(), {
        left: plan.tail.left - plan.left, top: plan.tail.top - plan.top,
      });
    }
    return outputPng(composition, intermediate ? MAX_GROUPED_PRINT_BYTES : MAX_PRINT_ASSET_BYTES, intermediate);
  };
  const grouped = planPrintComposition(layers, source.byteLength, {
    left: 0, top: 0, width: geometry.width, height: geometry.height,
  });
  const bytes = (grouped ? await renderGrouped(grouped) : undefined) ?? await renderSequential();
  const validationStart = performance.now();
  await validatePrintPng(await bytes.stream(), geometry, MAX_PRINT_ASSET_BYTES).finally(() => {
    if (timings) timings.pngValidationMs += performance.now() - validationStart;
  });
  return bytes;
}

export async function ensureConfiguredProductPrintAssets(
  env: PrintAssetEnv,
  configuredProductId: string,
  execution: "request" | "queue" = "request",
  queueContext?: PrintAssetQueueContext,
) {
  const context = queueContext ?? createPrintAssetQueueContext(env);
  try { await ensureConfiguredProductPrintAssetsWithContext(env, configuredProductId, execution, context); }
  finally { if (!queueContext) context.dispose(); }
}

async function ensureConfiguredProductPrintAssetsWithContext(
  env: PrintAssetEnv, configuredProductId: string, execution: "request" | "queue", queueContext: PrintAssetQueueContext,
) {
  const startedAt = Date.now();
  const source = await readProductSource(env.DB, configuredProductId);
  if (!source || !validProductSource(source)) {
    throw new Error("Configured product does not have immutable print source data.");
  }
  const geometries = await readPrintGeometries(env.DB, source.base_product_id);
  if (geometries.length === 0) {
    throw new Error("Configured product has no accepted Printify geometry.");
  }
  const sourceFetchStartedAt = Date.now();
  const sourceBytes = await queueContext.readSource(source);
  const sourceFetchedAt = Date.now();
  const artworkDimensions = await resolveArtworkDimensions(
    env.IMAGES,
    source,
    sourceBytes,
  );
  const settings: PrintAssetSettings = {
    printMode: source.print_mode,
    cropX: source.crop_x,
    cropY: source.crop_y,
    cropZoom: source.crop_zoom,
    depth: source.placement_depth,
    placementWidth: source.placement_width,
    placementX: source.placement_x,
    placementY: source.placement_y,
  };
  if (execution === "queue") {
    const renderStartedAt = Date.now();
    // A family has three shirt geometries plus one tote. Its shared context
    // admits at most four renders, each within the isolate buffer budget.
    // Settle every started render before retrying, so a failed sibling cannot
    // release the product job lease while another render still owns its work.
    for (let index = 0; index < geometries.length; index += 3) {
      const results = await Promise.allSettled(geometries.slice(index, index + 3).map(geometry => {
        const prepare = () => ensureGeometryAsset(env, source, sourceBytes, artworkDimensions, geometry, settings, execution);
        return queueContext.runGeometry(prepare);
      }));
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw new Error("Print asset batch failed.", { cause: failed.reason });
    }
    console.info("Print preparation complete", {
      productId: configuredProductId, geometryCount: geometries.length,
      metadataMs: sourceFetchStartedAt - startedAt,
      sourceReadMs: sourceFetchedAt - sourceFetchStartedAt,
      sourceDimensionsMs: renderStartedAt - sourceFetchedAt,
      renderAndStoreMs: Date.now() - renderStartedAt,
      totalMs: Date.now() - startedAt,
    });
    return;
  }
  const results = await Promise.allSettled(geometries.map(geometry => queueContext.runGeometry(() =>
    ensureGeometryAsset(env, source, sourceBytes, artworkDimensions, geometry, settings)
  )));
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw new Error("Print asset batch failed.", { cause: failed.reason });
}

export async function reconcileConfiguredProductPrintAssets(
  env: PrintAssetEnv,
) {
  const now = Date.now();
  const candidates = await env.DB.prepare(`
    WITH ${requiredPrintGeometryCtesSql}
    SELECT products.id AS configured_product_id
    FROM products
    JOIN products AS base ON base.id = products.base_product_id
      AND base.status = 'active' AND base.design_id IS NULL
    LEFT JOIN print_asset_retries AS retries
      ON retries.configured_product_id = products.id
    WHERE products.status = 'active'
      AND (retries.next_attempt_at IS NULL OR retries.next_attempt_at <= ?)
      AND products.design_id IS NOT NULL
      AND products.design_revision_id IS NOT NULL
      AND products.projection_version IN ('legacy-shirt-v1', 'safe-margin-v1')
      AND NOT EXISTS (
        SELECT 1 FROM print_asset_jobs jobs
        WHERE jobs.configured_product_id = products.id AND jobs.status <> 'ready'
      )
      AND ${missingRequiredPrintGeometrySql}
    ORDER BY coalesce(retries.last_attempt_at, products.created_at), products.created_at, products.id
    LIMIT ?
  `).bind(now, PRINT_ASSET_RECONCILIATION_LIMIT)
    .all<PrintAssetReconciliationRow>();
  let productsFailed = 0;
  let productsReconciled = 0;
  for (const candidate of candidates.results) {
    const claimId = crypto.randomUUID();
    const startedAt = Date.now();
    // Reserve before touching R2/Images. An interrupted invocation becomes due
    // again after the claim expires; duplicate invocations cannot both claim it.
    const claim = await env.DB.prepare(`
      INSERT INTO print_asset_retries (
        configured_product_id, attempt_count, claim_id, next_attempt_at, last_attempt_at
      ) SELECT ?, 1, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM print_asset_jobs WHERE configured_product_id = ? AND status <> 'ready'
      )
      ON CONFLICT (configured_product_id) DO UPDATE SET
        attempt_count = min(print_asset_retries.attempt_count + 1, 16),
        claim_id = excluded.claim_id,
        next_attempt_at = excluded.next_attempt_at,
        last_attempt_at = excluded.last_attempt_at
      WHERE print_asset_retries.next_attempt_at <= ?
      RETURNING attempt_count
    `).bind(candidate.configured_product_id, claimId,
      startedAt + PRINT_ASSET_RETRY_CLAIM_MS, startedAt, candidate.configured_product_id, startedAt)
      .first<{ attempt_count: number }>();
    if (!claim) continue;
    try {
      await ensureConfiguredProductPrintAssets(
        env,
        candidate.configured_product_id,
      );
      await env.DB.prepare(`
        DELETE FROM print_asset_retries
        WHERE configured_product_id = ? AND claim_id = ?
      `).bind(candidate.configured_product_id, claimId).run();
      productsReconciled += 1;
    } catch {
      const delay = Math.min(
        PRINT_ASSET_RETRY_BASE_MS * 2 ** (claim.attempt_count - 1),
        PRINT_ASSET_RETRY_MAX_MS,
      );
      await env.DB.prepare(`
        UPDATE print_asset_retries SET claim_id = NULL, next_attempt_at = ?
        WHERE configured_product_id = ? AND claim_id = ?
      `).bind(Date.now() + delay, candidate.configured_product_id, claimId).run();
      productsFailed += 1;
    }
  }
  return { productsFailed, productsReconciled };
}

async function ensureGeometryAsset(
  env: PrintAssetEnv,
  source: ProductSourceRow,
  sourceBytes: Uint8Array,
  artworkDimensions: { readonly height: number; readonly width: number },
  geometry: PrintGeometry,
  settings: PrintAssetSettings,
  execution: "request" | "queue" = "request",
) {
  const geometryKey = printGeometryKey(geometry);
  const now = Date.now();
  const candidateId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO print_assets (
      id, configured_product_id, design_revision_id, base_product_id,
      projection_version, geometry_key, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT (configured_product_id, geometry_key) DO NOTHING
  `).bind(
    candidateId,
    source.configured_product_id,
    source.design_revision_id,
    source.base_product_id,
    source.projection_version,
    geometryKey,
    now,
    now,
  ).run();
  const asset = await env.DB.prepare(`
    SELECT assets.id, assets.design_revision_id, assets.base_product_id,
      assets.projection_version, assets.geometry_key, assets.storage_key,
      assets.byte_size, assets.width_px, assets.height_px, assets.sha256,
      assets.object_sha256, assets.status,
      coalesce(objects.storage_key, assets.storage_key) AS object_storage_key
    FROM print_assets AS assets
    LEFT JOIN print_asset_objects AS objects
      ON objects.sha256 = assets.object_sha256
    WHERE assets.configured_product_id = ? AND assets.geometry_key = ?
  `).bind(source.configured_product_id, geometryKey).first<AssetRow>();
  if (!asset || !assetBelongsToSource(asset, source, geometryKey)) {
    throw new Error("Print asset identity could not be reserved.");
  }
  if (
    readyAssetMatches(asset, geometry) &&
    await storedReadyAssetMatches(env.DESIGN_ARTWORK, asset)
  ) return;

  await env.DB.prepare(`
    UPDATE print_assets SET status = 'pending', last_error = NULL, updated_at = ?
    WHERE id = ? AND status <> 'ready'
  `).bind(now, asset.id).run();
  const staging = createPrintStagingSession(env, source.configured_product_id, asset.id);
  const timings = { imagesOutputMs: 0, pngValidationMs: 0, graphCount: 0, publicationMs: 0, assetCommitMs: 0 };
  const started = performance.now();
  let ready = false;
  try {
    const render = () =>
      composePrintAsset(
        env.IMAGES,
        sourceBytes,
        artworkDimensions.width,
        artworkDimensions.height,
        geometry,
        settings,
        (stream, maxBytes, intermediate) => staging.write(stream, maxBytes, intermediate),
        timings,
      );
    const encoded = execution === "queue" ? await render() : await withPrintAssetRenderSlot(env.DB, render);
    const rendered = { ...encoded, width: geometry.width, height: geometry.height };
    staging.assertActive();
    const publicationStart = performance.now();
    await ensurePrintAssetObject(env, rendered, now, staging.signal).finally(() => {
      timings.publicationMs += performance.now() - publicationStart;
    });
    staging.assertActive();
    const storageKey = `print-assets/${source.configured_product_id}/${geometryKey}/${rendered.sha256}.png`;
    const readyAt = Date.now();
    const commitStart = performance.now();
    const updated = await env.DB.prepare(`
      UPDATE print_assets SET storage_key = ?, content_type = 'image/png',
        byte_size = ?, width_px = ?, height_px = ?, sha256 = ?,
        object_sha256 = ?, status = 'ready', last_error = NULL,
        ready_at = ?, updated_at = ?
      WHERE id = ?
        AND design_revision_id = ? AND base_product_id = ?
        AND projection_version = ? AND geometry_key = ?
    `).bind(
      storageKey,
      rendered.byteLength,
      rendered.width,
      rendered.height,
      rendered.sha256,
      rendered.sha256,
      readyAt,
      readyAt,
      asset.id,
      source.design_revision_id,
      source.base_product_id,
      source.projection_version,
      geometryKey,
    ).run();
    timings.assetCommitMs += performance.now() - commitStart;
    if (updated.meta.changes !== 1) {
      throw new Error("Rendered print asset could not be committed.");
    }
    ready = true;
  } catch (cause) {
    if (isPrintMemoryCapacityError(cause)) throw cause;
    const message = cause instanceof Error ? cause.message : "Print asset rendering failed.";
    await env.DB.prepare(`
      UPDATE print_assets SET status = 'failed', last_error = ?, updated_at = ?
      WHERE id = ? AND status <> 'ready'
    `).bind(message.slice(0, 500), Date.now(), asset.id).run();
    throw cause;
  } finally {
    await staging.dispose();
    // These phase sums can overlap provider input/output work and must not be
    // added together as wall time. totalMs includes awaited resource cleanup.
    console.info("Print geometry timing", { schemaVersion: 1, event: "print_geometry_timing",
      productId: source.configured_product_id, assetId: asset.id, width: geometry.width,
      height: geometry.height, sourceBytes: sourceBytes.byteLength, ready,
      totalMs: performance.now() - started, ...timings, ...staging.timings });
  }
}

type PublishedPrint = StagedPrint & { readonly width: number; readonly height: number };

async function ensurePrintAssetObject(
  env: PrintAssetEnv,
  rendered: PublishedPrint,
  now: number,
  signal: AbortSignal,
) {
  const existing = await readPrintAssetObject(env.DB, rendered.sha256);
  if (existing) {
    await verifyPrintAssetObject(env.DESIGN_ARTWORK, existing, rendered);
    return existing.storage_key;
  }
  const storageKey = printAssetObjectKey(rendered.sha256);
  const stored = await env.DESIGN_ARTWORK.head(storageKey);
  if (stored) {
    const storedSha256 = stored.checksums.sha256;
    if (
      stored.size !== rendered.byteLength ||
      !storedSha256 ||
      bytesToHex(new Uint8Array(storedSha256)) !== rendered.sha256
    ) {
      throw new Error("Stored print asset conflicts with its content address.");
    }
  } else {
    await publishStagedPrint(env.DESIGN_ARTWORK, storageKey, rendered, signal);
  }
  signal.throwIfAborted();
  await env.DB.prepare(`
    INSERT INTO print_asset_objects (
      sha256, storage_key, content_type, byte_size, width_px, height_px,
      created_at
    ) VALUES (?, ?, 'image/png', ?, ?, ?, ?)
    ON CONFLICT (sha256) DO NOTHING
  `).bind(
    rendered.sha256,
    storageKey,
    rendered.byteLength,
    rendered.width,
    rendered.height,
    now,
  ).run();
  const committed = await readPrintAssetObject(env.DB, rendered.sha256);
  if (!committed) {
    throw new Error("Print asset object could not be committed.");
  }
  await verifyPrintAssetObject(env.DESIGN_ARTWORK, committed, rendered);
  return committed.storage_key;
}

function readPrintAssetObject(db: D1Database, sha256: string) {
  return db.prepare(`
    SELECT sha256, storage_key, content_type, byte_size, width_px, height_px
    FROM print_asset_objects WHERE sha256 = ?
  `).bind(sha256).first<PrintAssetObjectRow>();
}

async function verifyPrintAssetObject(
  bucket: R2Bucket,
  object: PrintAssetObjectRow,
  rendered: PublishedPrint,
) {
  if (
    object.sha256 !== rendered.sha256 ||
    object.content_type !== PRINT_ASSET_CONTENT_TYPE ||
    object.byte_size !== rendered.byteLength ||
    object.width_px !== rendered.width ||
    object.height_px !== rendered.height
  ) {
    throw new Error("Print asset object metadata conflicts with rendered bytes.");
  }
  const stored = await bucket.head(object.storage_key);
  const checksum = stored?.checksums.sha256;
  if (
    stored?.size !== rendered.byteLength ||
    !checksum || bytesToHex(new Uint8Array(checksum)) !== rendered.sha256
  ) {
    throw new Error("Print asset object failed its storage integrity check.");
  }
}

export function withPrintAssetRenderSlot<Success>(
  db: D1Database,
  render: () => Promise<Success>,
): Promise<Success> {
  const program = Effect.acquireUseRelease(
    acquirePrintAssetRenderSlot(db),
    () => Effect.tryPromise({
      try: render,
      catch: (cause) => new PrintAssetRenderingError({
        message: cause instanceof Error
          ? cause.message
          : "Print asset rendering failed.",
      }),
    }),
    (lease) => releasePrintAssetRenderSlot(db, lease).pipe(
      Effect.catchAll(() => Effect.void),
    ),
  );
  return Effect.runPromise(program);
}

function acquirePrintAssetRenderSlot(db: D1Database) {
  const leaseId = crypto.randomUUID();
  const waitStartedAt = Date.now();
  return Effect.gen(function*() {
    let failedAttempts = 0;
    for (;;) {
      const now = Date.now();
      const row = yield* printAssetRenderDatabaseEffect(
        "acquire print asset render slot",
        () => db.prepare(`
          UPDATE print_asset_render_slots
          SET lease_id = ?, lease_expires_at = ?
          WHERE slot = (
            SELECT slot FROM print_asset_render_slots
            WHERE lease_id IS NULL OR lease_expires_at <= ?
            ORDER BY slot LIMIT 1
          )
          AND (lease_id IS NULL OR lease_expires_at <= ?)
          RETURNING slot
        `).bind(
          leaseId,
          now + PRINT_ASSET_RENDER_LEASE_MS,
          now,
          now,
        ).first<PrintAssetRenderSlotRow>(),
      );
      if (row) return { leaseId, slot: row.slot };
      failedAttempts += 1;
      if (now - waitStartedAt >= PRINT_ASSET_RENDER_SLOT_WAIT_LIMIT_MS) {
        return yield* Effect.fail(new PrintAssetRenderCapacityError({
          message: "Print asset rendering capacity was not available in time.",
        }));
      }
      yield* Effect.sleep(printAssetRenderSlotDelay(failedAttempts, now - waitStartedAt));
    }
  });
}

export function printAssetRenderSlotDelay(failedAttempts: number, elapsedMs: number) {
  return Math.max(0, Math.min(
    PRINT_ASSET_RENDER_SLOT_WAIT_MS * 2 ** Math.min(failedAttempts - 1, 3),
    PRINT_ASSET_RENDER_SLOT_MAX_WAIT_MS,
    PRINT_ASSET_RENDER_SLOT_WAIT_LIMIT_MS - elapsedMs,
  ));
}

function releasePrintAssetRenderSlot(
  db: D1Database,
  lease: PrintAssetRenderLease,
) {
  return printAssetRenderDatabaseEffect(
    "release print asset render slot",
    () => db.prepare(`
      UPDATE print_asset_render_slots
      SET lease_id = NULL, lease_expires_at = NULL
      WHERE slot = ? AND lease_id = ?
    `).bind(lease.slot, lease.leaseId).run(),
  );
}

function printAssetRenderDatabaseEffect<Success>(
  operation: string,
  run: () => Promise<Success>,
) {
  return Effect.tryPromise({
    try: run,
    catch: () => new PrintAssetRenderDatabaseError({ operation }),
  });
}

async function readProductSource(db: D1Database, configuredProductId: string) {
  return db.prepare(`
    SELECT products.id AS configured_product_id, products.base_product_id,
      products.design_id, products.design_revision_id,
      products.projection_version, products.print_mode, products.placement_x,
      products.placement_y, products.placement_width, products.placement_depth,
      design_revisions.artwork_key, design_revisions.byte_size,
      design_revisions.artwork_width, design_revisions.artwork_height,
      design_revisions.sha256 AS artwork_sha256, design_revisions.crop_x,
      design_revisions.crop_y, design_revisions.crop_zoom
    FROM products
    JOIN design_revisions ON design_revisions.id = products.design_revision_id
      AND design_revisions.design_id = products.design_id
    WHERE products.id = ? AND products.status = 'active'
      AND products.design_id IS NOT NULL
      AND products.design_revision_id IS NOT NULL
  `).bind(configuredProductId).first<ProductSourceRow>();
}

async function readPrintGeometries(db: D1Database, baseProductId: string) {
  // A catalogue refresh is not acceptance. Rendering and recovery must use the
  // same mapped catalogue as checkout, including during a partially completed sync.
  const rows = await db.prepare(`
    SELECT DISTINCT lower(variants.decoration_method) AS decoration_method,
      variants.print_width, variants.print_height
    FROM printify_catalogue_variants AS variants
    JOIN printify_catalogue_snapshots AS snapshots
      ON snapshots.id = variants.snapshot_id
    JOIN products AS base ON base.id = snapshots.base_product_id
      AND base.status = 'active' AND base.design_id IS NULL
    WHERE base.id = ? AND snapshots.id = (
      SELECT catalogue_snapshot_id FROM shopify_variant_mapping_snapshots
      WHERE base_product_id = base.id
        AND shopify_product_handle = base.shopify_handle
      ORDER BY retrieved_at DESC, id DESC LIMIT 1
    )
    ORDER BY decoration_method, print_width, print_height
  `).bind(baseProductId).all<GeometryRow>();
  return rows.results.map((row) => ({
    decorationMethod: row.decoration_method,
    height: row.print_height,
    width: row.print_width,
  }));
}

function validProductSource(source: ProductSourceRow) {
  return source.design_id.length > 0 && source.design_revision_id.length > 0 &&
    (source.artwork_key === `designs/${source.design_id}/artwork/${source.artwork_sha256}` ||
      source.artwork_key === `designs/${source.design_id}/original/${source.artwork_sha256}`) &&
    /^[0-9a-f]{64}$/.test(source.artwork_sha256) &&
    Number.isInteger(source.byte_size) && source.byte_size > 0 &&
    source.byte_size <= MAX_DESIGN_ARTWORK_BYTES &&
    artworkDimensionsCanBeResolved(
      source.artwork_width,
      source.artwork_height,
    ) &&
    (source.projection_version === "legacy-shirt-v1" ||
      source.projection_version === "safe-margin-v1");
}

async function resolveArtworkDimensions(
  images: PrintAssetImageBinding,
  source: ProductSourceRow,
  sourceBytes: Uint8Array,
) {
  if (source.artwork_width !== null && source.artwork_height !== null) {
    return { height: source.artwork_height, width: source.artwork_width };
  }
  const info = await images.info(byteStream(sourceBytes));
  if (!("width" in info) || !("height" in info)) {
    throw new Error("Historical configured product artwork dimensions are unavailable.");
  }
  validateDimension(info.width);
  validateDimension(info.height);
  return { height: info.height, width: info.width };
}

function assetBelongsToSource(
  asset: AssetRow,
  source: ProductSourceRow,
  geometryKey: string,
) {
  return asset.design_revision_id === source.design_revision_id &&
    asset.base_product_id === source.base_product_id &&
    asset.projection_version === source.projection_version &&
    asset.geometry_key === geometryKey;
}

function readyAssetMatches(asset: AssetRow, geometry: PrintGeometry) {
  return asset.status === "ready" && asset.storage_key !== null &&
    asset.object_storage_key !== null &&
    asset.byte_size !== null && asset.byte_size > 0 &&
    asset.width_px === geometry.width && asset.height_px === geometry.height &&
    asset.sha256 !== null && /^[0-9a-f]{64}$/.test(asset.sha256);
}

async function storedReadyAssetMatches(bucket: R2Bucket, asset: AssetRow) {
  if (
    asset.object_storage_key === null || asset.byte_size === null ||
    asset.sha256 === null
  ) return false;
  const object = await bucket.head(asset.object_storage_key);
  const checksum = object?.checksums.sha256;
  return object?.size === asset.byte_size && checksum !== undefined &&
    bytesToHex(new Uint8Array(checksum)) === asset.sha256;
}

function validateDimension(value: number) {
  if (!validDimension(value)) {
    throw new Error("Print geometry dimensions are invalid.");
  }
}

function validDimension(value: number) {
  return Number.isInteger(value) && value > 0 && value <= MAX_GEOMETRY_EDGE;
}

function validateSettings(settings: PrintAssetSettings) {
  if (
    (settings.printMode !== undefined && !["recursive", "base-image-only"].includes(settings.printMode)) ||
    !isUnit(settings.cropX) || !isUnit(settings.cropY) ||
    !Number.isFinite(settings.cropZoom) || settings.cropZoom < 0.65 ||
    settings.cropZoom > 2.6 || !isUnit(settings.placementX) ||
    !isUnit(settings.placementY) || !Number.isFinite(settings.placementWidth) ||
    settings.placementWidth < 0.08 || settings.placementWidth > 0.48 ||
    settings.placementX + settings.placementWidth > 1 ||
    settings.placementY + settings.placementWidth > 1 ||
    !Number.isInteger(settings.depth) || settings.depth < 0 || settings.depth > 8
  ) {
    throw new Error("Print asset settings are invalid.");
  }
}

function isUnit(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function byteStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readBoundedStream(
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

function sha256(bytes: Uint8Array) {
  // Incremental node crypto accepts the source view without a full-input clone.
  return Promise.resolve(new Uint8Array(createHash("sha256").update(bytes).digest()));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
