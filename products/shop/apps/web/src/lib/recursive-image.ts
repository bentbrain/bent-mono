export const PREVIEW_WIDTH = 750;
export const PREVIEW_HEIGHT = 900;

const ARTWORK_TO_CHEST_WIDTH_RATIO = 0.5;
const MINIMUM_INITIAL_PLACEMENT_WIDTH = 0.11;
const MAXIMUM_INITIAL_PLACEMENT_WIDTH = 0.36;

export interface EditorSettings {
  removeBackground?: boolean | undefined;
  cropX: number;
  cropY: number;
  cropZoom: number;
  placementX: number;
  placementY: number;
  placementWidth: number;
  depth: number;
}

export const DEFAULT_SETTINGS: EditorSettings = {
  cropX: 0.5,
  cropY: 0.5,
  cropZoom: 1,
  placementX: 0.37,
  placementY: 0.41,
  placementWidth: 0.26,
  depth: 5,
};

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

interface ScratchCanvases {
  readonly first: HTMLCanvasElement;
  readonly second: HTMLCanvasElement;
}

const scratchCanvasesByDestination = new WeakMap<
  HTMLCanvasElement,
  ScratchCanvases
>();

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function getScratchCanvases(
  destination: HTMLCanvasElement,
  width: number,
  height: number,
) {
  const existing = scratchCanvasesByDestination.get(destination);
  if (existing) {
    resizeCanvas(existing.first, width, height);
    resizeCanvas(existing.second, width, height);
    return existing;
  }

  const created = {
    first: createCanvas(width, height),
    second: createCanvas(width, height),
  };
  scratchCanvasesByDestination.set(destination, created);
  return created;
}

function drawCroppedSource(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement | ImageBitmap,
  width: number,
  height: number,
  settings: EditorSettings,
) {
  const containScale = Math.min(width / source.width, height / source.height);
  const scale = containScale * settings.cropZoom;
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;

  context.drawImage(
    source,
    width / 2 - settings.cropX * drawWidth,
    height / 2 - settings.cropY * drawHeight,
    drawWidth,
    drawHeight,
  );
}

export function renderRecursiveImage(
  destination: HTMLCanvasElement,
  source: HTMLCanvasElement | ImageBitmap,
  settings: EditorSettings,
) {
  const { width, height } = destination;
  const scratch = getScratchCanvases(destination, width, height);
  let previous = scratch.first;
  let next = scratch.second;
  const firstContext = previous.getContext("2d");

  if (!firstContext) {
    throw new Error("Canvas rendering is not available in this browser.");
  }

  firstContext.clearRect(0, 0, width, height);
  drawCroppedSource(firstContext, source, width, height, settings);

  const placementWidth = settings.placementWidth * width;
  const placementHeight = placementWidth * (height / width);
  const placementX = settings.placementX * width;
  const placementY = settings.placementY * height;

  for (let level = 0; level < settings.depth; level += 1) {
    const nextContext = next.getContext("2d");

    if (!nextContext) {
      throw new Error("Canvas rendering is not available in this browser.");
    }

    nextContext.clearRect(0, 0, width, height);
    drawCroppedSource(nextContext, source, width, height, settings);
    nextContext.drawImage(
      previous,
      placementX,
      placementY,
      placementWidth,
      placementHeight,
    );
    const rendered = next;
    next = previous;
    previous = rendered;
  }

  const destinationContext = destination.getContext("2d");
  if (!destinationContext) {
    throw new Error("Canvas rendering is not available in this browser.");
  }

  destinationContext.clearRect(0, 0, width, height);
  destinationContext.drawImage(previous, 0, 0);
}

interface SilhouetteProfile {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
  rowCenters: Float32Array;
  rowWidths: Float32Array;
}

interface ProfileWindow {
  center: number;
  width: number;
}

function findLargestAlphaComponent(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const labels = new Int32Array(width * height);
  const queue = new Int32Array(width * height);
  let nextLabel = 0;
  let largestLabel = 0;
  let largestCount = 0;

  for (let start = 0; start < labels.length; start += 1) {
    const alpha = pixels[start * 4 + 3] ?? 0;
    if (alpha <= 40 || labels[start] !== 0) continue;

    nextLabel += 1;
    let queueStart = 0;
    let queueEnd = 1;
    let componentCount = 0;
    queue[0] = start;
    labels[start] = nextLabel;

    while (queueStart < queueEnd) {
      const index = queue[queueStart] ?? 0;
      queueStart += 1;
      componentCount += 1;
      const x = index % width;
      const y = Math.floor(index / width);

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (
            nextX < 0 ||
            nextX >= width ||
            nextY < 0 ||
            nextY >= height
          ) {
            continue;
          }
          const nextIndex = nextY * width + nextX;
          const nextAlpha = pixels[nextIndex * 4 + 3] ?? 0;
          if (nextAlpha <= 40 || labels[nextIndex] !== 0) continue;
          labels[nextIndex] = nextLabel;
          queue[queueEnd] = nextIndex;
          queueEnd += 1;
        }
      }
    }

    if (componentCount > largestCount) {
      largestCount = componentCount;
      largestLabel = nextLabel;
    }
  }

  return { labels, largestLabel };
}

function buildSilhouetteProfile(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): SilhouetteProfile | undefined {
  const { labels, largestLabel } = findLargestAlphaComponent(
    pixels,
    width,
    height,
  );
  if (largestLabel === 0) return undefined;

  const rowWidths = new Float32Array(height);
  const rowCenters = new Float32Array(height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    const rowPixels: number[] = [];
    for (let x = 0; x < width; x += 1) {
      if (labels[y * width + x] !== largestLabel) continue;
      rowPixels.push(x);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (rowPixels.length === 0) continue;
    const left = rowPixels[Math.floor((rowPixels.length - 1) * 0.1)] ?? 0;
    const right = rowPixels[Math.ceil((rowPixels.length - 1) * 0.9)] ?? left;
    rowWidths[y] = right - left + 1;
    rowCenters[y] = (left + right) / 2;
  }

  if (maxX < minX || maxY < minY) return undefined;
  return {
    maxX,
    maxY,
    minX,
    minY,
    rowCenters,
    rowWidths,
  };
}

function averageProfileWindow(
  profile: SilhouetteProfile,
  startY: number,
  endY: number,
): ProfileWindow | undefined {
  let centerTotal = 0;
  let widthTotal = 0;
  let count = 0;
  const start = Math.max(profile.minY, Math.floor(startY));
  const end = Math.min(profile.maxY, Math.ceil(endY));

  for (let y = start; y <= end; y += 1) {
    const width = profile.rowWidths[y] ?? 0;
    if (width === 0) continue;
    widthTotal += width;
    centerTotal += profile.rowCenters[y] ?? 0;
    count += 1;
  }

  if (count === 0) return undefined;
  return { center: centerTotal / count, width: widthTotal / count };
}

function estimateChestAnchor(profile: SilhouetteProfile) {
  const subjectHeight = profile.maxY - profile.minY + 1;
  const beforeWindow = Math.max(2, Math.round(subjectHeight * 0.04));
  const afterWindow = Math.max(3, Math.round(subjectHeight * 0.06));
  const searchStart = profile.minY + subjectHeight * 0.12;
  const searchEnd = profile.minY + subjectHeight * 0.58;
  const torsoReference = averageProfileWindow(
    profile,
    profile.minY + subjectHeight * 0.3,
    profile.minY + subjectHeight * 0.68,
  );
  let shoulderY: number | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let y = Math.floor(searchStart); y <= searchEnd; y += 1) {
    const before = averageProfileWindow(
      profile,
      y - beforeWindow,
      y - 1,
    );
    const after = averageProfileWindow(profile, y, y + afterWindow);
    if (!before || !after) continue;
    const gain = after.width - before.width;
    const centerShift = Math.abs(after.center - before.center);
    const score = gain - centerShift * 0.6;
    if (score > bestScore) {
      bestScore = score;
      shoulderY = y;
    }
  }

  const minimumGain = (torsoReference?.width ?? 0) * 0.1;
  const shoulderConfident =
    shoulderY !== undefined && bestScore >= Math.max(3, minimumGain);
  const anchorShoulderY =
    shoulderConfident && shoulderY !== undefined
      ? shoulderY
      : profile.minY + subjectHeight * 0.3;
  const chest = averageProfileWindow(
    profile,
    anchorShoulderY + subjectHeight * 0.08,
    anchorShoulderY + subjectHeight * 0.34,
  );
  const fallback = averageProfileWindow(
    profile,
    profile.minY + subjectHeight * 0.34,
    profile.minY + subjectHeight * 0.62,
  );
  const torso = chest ?? fallback;

  return {
    centerX: torso?.center ?? (profile.minX + profile.maxX) / 2,
    centerY: shoulderConfident
      ? anchorShoulderY + subjectHeight * 0.21
      : profile.minY + subjectHeight * 0.45,
    width: torso?.width ?? (profile.maxX - profile.minX + 1) * 0.72,
  };
}

export function suggestSettings(source: ImageBitmap): EditorSettings {
  const analysisWidth = Math.min(source.width, 480);
  const scale = analysisWidth / source.width;
  const analysisHeight = Math.max(1, Math.round(source.height * scale));
  const canvas = createCanvas(analysisWidth, analysisHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    return DEFAULT_SETTINGS;
  }

  context.drawImage(source, 0, 0, analysisWidth, analysisHeight);
  const pixels = context.getImageData(0, 0, analysisWidth, analysisHeight).data;
  const profile = buildSilhouetteProfile(
    pixels,
    analysisWidth,
    analysisHeight,
  );
  if (!profile) {
    return DEFAULT_SETTINGS;
  }

  const { minX, minY, maxX, maxY } = profile;

  const subjectWidth = maxX - minX;
  const subjectHeight = maxY - minY;
  const subjectCenterX = (minX + maxX) / 2 / analysisWidth;
  const subjectCenterY = (minY + maxY) / 2 / analysisHeight;
  const containScale = Math.min(
    PREVIEW_WIDTH / source.width,
    PREVIEW_HEIGHT / source.height,
  );
  const desiredScale = Math.min(
    (PREVIEW_WIDTH * 0.9) / (subjectWidth / scale),
    (PREVIEW_HEIGHT * 0.9) / (subjectHeight / scale),
  );
  const cropZoom = clamp(desiredScale / containScale, 0.65, 2.6);
  const drawWidth = source.width * containScale * cropZoom;
  const drawHeight = source.height * containScale * cropZoom;
  const chest = estimateChestAnchor(profile);
  const chestCenterX =
    0.5 + (chest.centerX / analysisWidth - subjectCenterX) *
      (drawWidth / PREVIEW_WIDTH);
  const chestCenterY =
    0.5 + (chest.centerY / analysisHeight - subjectCenterY) *
      (drawHeight / PREVIEW_HEIGHT);
  const visibleChestWidth =
    (chest.width / analysisWidth) * (drawWidth / PREVIEW_WIDTH);
  const placementWidth = clamp(
    visibleChestWidth * ARTWORK_TO_CHEST_WIDTH_RATIO,
    MINIMUM_INITIAL_PLACEMENT_WIDTH,
    MAXIMUM_INITIAL_PLACEMENT_WIDTH,
  );

  return {
    cropX: subjectCenterX,
    cropY: subjectCenterY,
    cropZoom,
    placementX: clamp(chestCenterX - placementWidth / 2, 0, 1 - placementWidth),
    placementY: clamp(chestCenterY - placementWidth / 2, 0, 1 - placementWidth),
    placementWidth,
    depth: DEFAULT_SETTINGS.depth,
  };
}

interface CanvasBlobOptions {
  quality?: number;
  type?: string;
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  { quality, type = "image/png" }: CanvasBlobOptions = {},
) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("The image could not be created."));
      }
    }, type, quality);
  });
}
