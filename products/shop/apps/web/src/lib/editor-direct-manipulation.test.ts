import { describe, expect, it } from "vitest";

import {
  applyDirectManipulation,
  editingLayerAtPoint,
  gestureMetrics,
} from "@/lib/editor-direct-manipulation";
import { DEFAULT_SETTINGS } from "@/lib/recursive-image";

describe("direct editor manipulation", () => {
  it("moves the outer photo everywhere when recursion is off", () => {
    expect(editingLayerAtPoint({ ...DEFAULT_SETTINGS, depth: 0 }, 0.5, 0.5)).toBe("crop");
  });

  it("selects the placed recursive layer without a separate mode control", () => {
    expect(editingLayerAtPoint(DEFAULT_SETTINGS, 0.5, 0.5)).toBe("placement");
    expect(editingLayerAtPoint(DEFAULT_SETTINGS, 0.1, 0.1)).toBe("crop");
  });

  it("derives a pinch center and distance from two pointers", () => {
    expect(gestureMetrics(new Map([
      [1, { x: 10, y: 20 }],
      [2, { x: 40, y: 60 }],
    ]))).toEqual({ centerX: 25, centerY: 40, distance: 50 });
  });

  it("stops a pinch at the shared print-quality ceiling while preserving positioning", () => {
    const settings = applyDirectManipulation("crop", DEFAULT_SETTINGS,
      { centerX: 100, centerY: 100, distance: 100 },
      { centerX: 110, centerY: 120, distance: 400 }, 1_000, 1_000, 1.524);
    expect(settings.cropZoom).toBe(1.524);
    expect(settings.cropX).toBeLessThan(DEFAULT_SETTINGS.cropX);
    const smaller = applyDirectManipulation("crop", settings,
      { centerX: 110, centerY: 120, distance: 400 },
      { centerX: 110, centerY: 120, distance: 300 }, 1_000, 1_000, 1.524);
    expect(smaller.cropZoom).toBeCloseTo(1.143);
  });

  it("drags and pinches placement while keeping it recoverable", () => {
    const settings = applyDirectManipulation(
      "placement",
      DEFAULT_SETTINGS,
      { centerX: 100, centerY: 100, distance: 100 },
      { centerX: 900, centerY: 900, distance: 400 },
      1_000,
      1_000,
    );

    expect(settings.placementWidth).toBe(0.48);
    expect(settings.placementX).toBe(0.52);
    expect(settings.placementY).toBe(0.52);
  });

  it("drags and pinches the crop within persisted setting limits", () => {
    const settings = applyDirectManipulation(
      "crop",
      DEFAULT_SETTINGS,
      { centerX: 500, centerY: 500, distance: 100 },
      { centerX: 1_500, centerY: -500, distance: 400 },
      1_000,
      1_000,
    );

    expect(settings.cropZoom).toBe(2.6);
    expect(settings.cropX).toBeCloseTo(0.115_384_615);
    expect(settings.cropY).toBeCloseTo(0.884_615_385);
  });
});
