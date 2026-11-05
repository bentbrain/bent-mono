import {
  clamp,
  type EditorSettings,
} from "@/lib/recursive-image";

export type EditingLayer = "crop" | "placement";

export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

export interface GestureMetrics {
  readonly centerX: number;
  readonly centerY: number;
  readonly distance: number;
}

export function gestureMetrics(
  pointers: ReadonlyMap<number, PointerPosition>,
): GestureMetrics | undefined {
  const iterator = pointers.values();
  const firstResult = iterator.next();
  if (firstResult.done) return undefined;
  const first = firstResult.value;
  const secondResult = iterator.next();
  if (secondResult.done) {
    return { centerX: first.x, centerY: first.y, distance: 0 };
  }
  const second = secondResult.value;
  return {
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}

export function editingLayerAtPoint(
  settings: EditorSettings,
  pointerX: number,
  pointerY: number,
): EditingLayer {
  return settings.depth > 0 && pointerX >= settings.placementX &&
      pointerX <= settings.placementX + settings.placementWidth &&
      pointerY >= settings.placementY &&
      pointerY <= settings.placementY + settings.placementWidth
    ? "placement"
    : "crop";
}

export function applyDirectManipulation(
  layer: EditingLayer,
  start: EditorSettings,
  startMetrics: GestureMetrics,
  currentMetrics: GestureMetrics,
  editorWidth: number,
  editorHeight: number,
  maximumCropZoom = 2.6,
): EditorSettings {
  if (editorWidth <= 0 || editorHeight <= 0) return start;

  const deltaX = (currentMetrics.centerX - startMetrics.centerX) / editorWidth;
  const deltaY = (currentMetrics.centerY - startMetrics.centerY) / editorHeight;
  const scale = startMetrics.distance > 0
    ? currentMetrics.distance / startMetrics.distance
    : 1;

  if (layer === "placement") {
    const placementWidth = clamp(start.placementWidth * scale, 0.08, 0.48);
    return {
      ...start,
      placementWidth,
      placementX: clamp(
        start.placementX + deltaX - (placementWidth - start.placementWidth) / 2,
        0,
        1 - placementWidth,
      ),
      placementY: clamp(
        start.placementY + deltaY - (placementWidth - start.placementWidth) / 2,
        0,
        1 - placementWidth,
      ),
    };
  }

  const cropZoom = clamp(start.cropZoom * scale, 0.65, Math.max(0.65, Math.min(2.6, maximumCropZoom)));
  return {
    ...start,
    cropZoom,
    cropX: clamp(start.cropX - deltaX / cropZoom, 0, 1),
    cropY: clamp(start.cropY - deltaY / cropZoom, 0, 1),
  };
}
