"use client";

import { useEffect, useRef } from "react";

interface ProcessedCutoutRevealProps {
  imageUrl: string;
  layerScale?: number;
  onCovered: () => void;
  onComplete: () => void;
}

interface VisibleBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

const REVEAL_DURATION_MS = 2_600;
const EXPANSION_STAGE_END = 0.48;
const DEFAULT_REVEAL_LAYER_SCALE = 1.9;

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function easeInOutCubic(value: number) {
  const progress = clamp01(value);
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function findVisibleBounds(image: HTMLImageElement): VisibleBounds {
  const analysisScale = Math.min(1, 480 / Math.max(image.naturalWidth, 1));
  const width = Math.max(1, Math.round(image.naturalWidth * analysisScale));
  const height = Math.max(1, Math.round(image.naturalHeight * analysisScale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    return { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  }

  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3] ?? 0;
      if (alpha <= 20) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }

  if (maximumX < minimumX || maximumY < minimumY) {
    return { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  }

  const inverseScale = 1 / analysisScale;
  return {
    x: minimumX * inverseScale,
    y: minimumY * inverseScale,
    width: (maximumX - minimumX + 1) * inverseScale,
    height: (maximumY - minimumY + 1) * inverseScale,
  };
}

function drawSubjectCanvas(
  context: CanvasRenderingContext2D,
  subjectCanvas: HTMLCanvasElement,
  centerX: number,
  centerY: number,
  height: number,
) {
  const width = height * (subjectCanvas.width / subjectCanvas.height);
  context.drawImage(
    subjectCanvas,
    0,
    0,
    subjectCanvas.width,
    subjectCanvas.height,
    centerX - width / 2,
    centerY - height / 2,
    width,
    height,
  );
}

function createSolidSubjectCanvas(
  image: HTMLImageElement,
  bounds: VisibleBounds,
  color: string,
) {
  const maximumDimension = 1_024;
  const scale = Math.min(
    1,
    maximumDimension / Math.max(bounds.width, bounds.height),
  );
  const subjectCanvas = document.createElement("canvas");
  subjectCanvas.width = Math.max(1, Math.round(bounds.width * scale));
  subjectCanvas.height = Math.max(1, Math.round(bounds.height * scale));
  const subjectContext = subjectCanvas.getContext("2d");
  if (!subjectContext) return subjectCanvas;

  subjectContext.drawImage(
    image,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    subjectCanvas.width,
    subjectCanvas.height,
  );
  subjectContext.globalCompositeOperation = "source-in";
  subjectContext.fillStyle = color;
  subjectContext.fillRect(0, 0, subjectCanvas.width, subjectCanvas.height);
  subjectContext.globalCompositeOperation = "source-over";
  return subjectCanvas;
}

function createLayerHeights(
  width: number,
  height: number,
  layerScale: number,
) {
  const layerHeights: number[] = [];
  const smallestHeight = Math.max(18, Math.min(width, height) * 0.04);
  const largestHeight = Math.hypot(width, height) * 2.8;
  let layerHeight = smallestHeight;

  while (layerHeight < largestHeight) {
    layerHeights.push(layerHeight);
    layerHeight *= layerScale;
  }
  layerHeights.push(largestHeight);
  return layerHeights;
}

function drawRecursiveLayers(
  context: CanvasRenderingContext2D,
  blueSubjectCanvas: HTMLCanvasElement,
  whiteSubjectCanvas: HTMLCanvasElement,
  width: number,
  height: number,
  layerHeights: number[],
  expansionProgress: number,
) {
  const layerTravel = easeInOutCubic(expansionProgress) * layerHeights.length;

  for (let index = layerHeights.length - 1; index >= 0; index -= 1) {
    const targetHeight = layerHeights[index];
    if (targetHeight === undefined) continue;
    if (layerTravel <= index) continue;
    drawSubjectCanvas(
      context,
      index % 2 === 0 ? blueSubjectCanvas : whiteSubjectCanvas,
      width / 2,
      height / 2,
      targetHeight,
    );
  }
}

function clearRecursiveLayers(
  context: CanvasRenderingContext2D,
  subjectCanvas: HTMLCanvasElement,
  width: number,
  height: number,
  layerHeights: number[],
  holeProgress: number,
) {
  const holeTravel = easeInOutCubic(holeProgress) * layerHeights.length;

  for (let index = 0; index < layerHeights.length; index += 1) {
    const targetHeight = layerHeights[index];
    if (targetHeight === undefined) continue;
    if (holeTravel <= index) break;
    drawSubjectCanvas(
      context,
      subjectCanvas,
      width / 2,
      height / 2,
      targetHeight,
    );
  }
}

export function ProcessedCutoutReveal({
  imageUrl,
  layerScale = DEFAULT_REVEAL_LAYER_SCALE,
  onCovered,
  onComplete,
}: ProcessedCutoutRevealProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const image = new Image();
    let animationFrame = 0;
    let cancelled = false;

    image.onload = () => {
      const context = canvas.getContext("2d");
      if (!context || cancelled) return;

      const bounds = findVisibleBounds(image);
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const pageBackground = getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim();
      const primaryBlue =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--blue")
          .trim() || "#0647ff";
      const blueSubjectCanvas = createSolidSubjectCanvas(
        image,
        bounds,
        primaryBlue,
      );
      const whiteSubjectCanvas = createSolidSubjectCanvas(
        image,
        bounds,
        "#ffffff",
      );
      let startedAt: number | undefined;
      let covered = false;

      const draw = (time: number) => {
        startedAt ??= time;
        const progress = reducedMotion
          ? 1
          : clamp01((time - startedAt) / REVEAL_DURATION_MS);
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const pixelRatio = Math.min(window.devicePixelRatio, 2);
        const pixelWidth = Math.max(1, Math.round(width * pixelRatio));
        const pixelHeight = Math.max(1, Math.round(height * pixelRatio));

        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
        }
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.globalCompositeOperation = "source-over";
        context.clearRect(0, 0, width, height);
        const expansionProgress = clamp01(progress / EXPANSION_STAGE_END);
        const holeProgress = clamp01(
          (progress - EXPANSION_STAGE_END) / (1 - EXPANSION_STAGE_END),
        );
        const layerHeights = createLayerHeights(width, height, layerScale);

        if (expansionProgress >= 1) {
          context.fillStyle = pageBackground;
          context.fillRect(0, 0, width, height);
          if (!covered) {
            covered = true;
            onCovered();
          }
        }

        drawRecursiveLayers(
          context,
          blueSubjectCanvas,
          whiteSubjectCanvas,
          width,
          height,
          layerHeights,
          expansionProgress,
        );

        if (holeProgress > 0) {
          context.globalCompositeOperation = "destination-out";
          clearRecursiveLayers(
            context,
            blueSubjectCanvas,
            width,
            height,
            layerHeights,
            holeProgress,
          );
        }

        if (progress < 1) {
          animationFrame = requestAnimationFrame(draw);
        } else {
          context.clearRect(0, 0, width, height);
          onComplete();
        }
      };

      animationFrame = requestAnimationFrame(draw);
    };

    image.src = imageUrl;
    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
    };
  }, [imageUrl, layerScale, onComplete, onCovered]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 h-dvh w-dvw touch-none overscroll-none"
    />
  );
}
