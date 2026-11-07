import { describe, expect, test } from "bun:test";
import { prepareRoute, routePulseStops } from "../src/render";
import { depthLayers } from "../src/route-depth";

describe("directional route pulse", () => {
  test("follows travelled distance and excludes unrecorded connectors", () => {
    const route = prepareRoute([
      { lat: 0, lon: 0, segment: 0 },
      { lat: 0, lon: 0.001, segment: 0 },
      { lat: 0, lon: 0.01, segment: 0 },
      { lat: 1, lon: 1, segment: 1 },
      { lat: 1, lon: 1.005, segment: 1 },
    ]);
    expect(route[0].progress).toBe(0);
    expect(route[1].progress).toBeCloseTo(1 / 15);
    expect(route[2].progress).toBeCloseTo(2 / 3);
    expect(route[3].progress).toBe(route[2].progress);
    expect(route[4].progress).toBe(1);
  });

  test("moves smoothly within a sparse edge from start to finish", () => {
    const early = routePulseStops(0, 1, 1.5, 30);
    const late = routePulseStops(0, 1, 4.5, 30);
    expect(early.find((stop) => stop.alpha === 0.4)?.offset).toBe(0.25);
    expect(late.find((stop) => stop.alpha === 0.4)?.offset).toBe(0.75);
    expect(
      routePulseStops(0.7, 0.8, 1.5, 30).every((stop) => stop.alpha === 0),
    ).toBe(true);
  });

  test("loops continuously for every supported orbit duration", () => {
    for (const duration of [4, 6, 8, 15, 30, 60]) {
      const initial = routePulseStops(0, 1, 0, duration);
      expect(routePulseStops(0, 1, duration, duration)).toEqual(initial);
      const left = routePulseStops(0, 0.01, duration - 0.0001, duration)[0]
        .alpha;
      const right = routePulseStops(0.99, 1, 0.0001, duration).at(-1)?.alpha;
      expect(left).toBeCloseTo(right ?? -1, 6);
    }
  });
});

test("sparse edges split across marker depth while preserving direction and GPS gaps", () => {
  const layers = depthLayers([
    { x: 0, y: 0, depth: 0, progress: 0, segment: 0 },
    { x: -1, y: -1, depth: 8, progress: 0.2, segment: 1 },
    { x: 1, y: 1, depth: -2, progress: 0.8, segment: 1 },
    { x: 0, y: 0, depth: -4, progress: 1, segment: 2 },
  ]);
  expect(layers.map((layer) => layer.kind)).toEqual([
    "edge",
    "marker",
    "edge",
    "marker",
  ]);
  const edges = layers.filter((layer) => layer.kind === "edge");
  expect(edges).toHaveLength(2);
  expect(edges[0].b.depth).toBe(0);
  expect(edges[1].a.depth).toBe(0);
  expect(edges[0].b.progress).toBeCloseTo(0.68);
  expect(edges[1].a.progress).toBeCloseTo(0.68);
  expect(edges[1].b.progress).toBe(0.8);
  expect(
    edges.every((edge) => edge.a.segment === 1 && edge.b.segment === 1),
  ).toBe(true);
});
