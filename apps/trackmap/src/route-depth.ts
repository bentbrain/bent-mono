interface ProjectedPoint {
  x: number;
  y: number;
  depth: number;
  segment: number;
  progress: number;
}

type RouteLayer =
  | { kind: "edge"; a: ProjectedPoint; b: ProjectedPoint; depth: number }
  | { kind: "marker"; point: ProjectedPoint; start: boolean; depth: number };

export function depthLayers(points: ProjectedPoint[]): RouteLayer[] {
  const first = points[0],
    last = points.at(-1);
  if (!first || !last) return [];
  const layers: RouteLayer[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (a.segment !== b.segment) continue;
    // A sparse edge can cross an endpoint's depth plane. Split there so its
    // nearer half can cover the marker even when its midpoint is farther away.
    const cuts = [0, 1];
    if (a.depth !== b.depth) {
      for (const depth of [first.depth, last.depth]) {
        const t = (depth - a.depth) / (b.depth - a.depth);
        if (t > 0 && t < 1) cuts.push(t);
      }
    }
    const sorted = [...new Set(cuts)].sort((x, y) => x - y);
    const at = (t: number): ProjectedPoint =>
      t === 0
        ? a
        : t === 1
          ? b
          : {
              x: a.x + (b.x - a.x) * t,
              y: a.y + (b.y - a.y) * t,
              depth: a.depth + (b.depth - a.depth) * t,
              progress: a.progress + (b.progress - a.progress) * t,
              segment: a.segment,
            };
    for (let j = 1; j < sorted.length; j++) {
      const start = at(sorted[j - 1]),
        end = at(sorted[j]);
      layers.push({
        kind: "edge",
        a: start,
        b: end,
        depth: (start.depth + end.depth) / 2,
      });
    }
  }
  // Ties put endpoint markers over their own incident line caps.
  layers.push({
    kind: "marker",
    point: first,
    start: true,
    depth: first.depth,
  });
  layers.push({ kind: "marker", point: last, start: false, depth: last.depth });
  return layers.sort((a, b) => b.depth - a.depth);
}
