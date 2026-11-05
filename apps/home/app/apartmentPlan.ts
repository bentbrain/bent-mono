export type FloorMaterial = "oak" | "wet-tile" | "balcony-tile";
export type WallFinish = "paint" | "tile" | "glass";
export type WallKind =
  | "exterior"
  | "partition"
  | "sliding-glazing"
  | "glass-balustrade";
export type WallAxis = "x" | "z";
export type OpeningKind = "door";

export interface PlanPoint {
  readonly x: number;
  readonly z: number;
}

export interface FloorCell {
  readonly x: number;
  readonly z: number;
  readonly material: FloorMaterial;
}

export interface WallOpening {
  readonly fromTick: number;
  readonly toTick: number;
  readonly kind: OpeningKind;
}

export interface WallRun {
  readonly id: string;
  readonly axis: WallAxis;
  readonly fixedTick: number;
  readonly fromTick: number;
  readonly toTick: number;
  readonly kind: WallKind;
  readonly finish: WallFinish;
  readonly outwardNormal: PlanPoint;
  readonly openings: readonly WallOpening[];
}

export interface CompiledWallSegment {
  readonly id: string;
  readonly start: PlanPoint;
  readonly end: PlanPoint;
  readonly kind: WallKind;
  readonly finish: WallFinish;
  readonly outwardNormal: PlanPoint;
  readonly startCap: boolean;
  readonly endCap: boolean;
}

interface VisibleInterval {
  readonly fromTick: number;
  readonly toTick: number;
}

export const PLAN_WIDTH = 18;
export const PLAN_DEPTH = 14;
export const PLAN_CENTER = { x: 8.5, z: 6.5 };

export const APARTMENT_ROWS: readonly string[] = [
  "BBBBBBBBBBDDDDDDDD",
  "BBBBBBBBBBDDDDDDDD",
  "BBBBBBBBBBDDDDDDDD",
  "LLLLLLLLLLDDDDDDDD",
  "LLLLLLLLLLDDDDDDDD",
  "LLLLLLLLLLDDDDDDDD",
  "LLLLLLLLLLDDDDDDDD",
  "LLLLLLLLLLDDDDDDDD",
  "LLLLLLLLLLHHHTTTTT",
  "LLLLLLLLLLHHHTTTTT",
  "LLLLLLLLLLHHHTTTTT",
  ".LLLLLLLLLUU......",
  ".LLLLLLLLLUU......",
  ".LLLLLLLLLUU......",
];

export const WALL_RUNS: readonly WallRun[] = [
  {
    id: "balcony-balustrade",
    axis: "x",
    fixedTick: -1,
    fromTick: -1,
    toTick: 19,
    kind: "glass-balustrade",
    finish: "glass",
    outwardNormal: { x: 0, z: -1 },
    openings: [],
  },
  {
    id: "bedroom-north",
    axis: "x",
    fixedTick: -1,
    fromTick: 19,
    toTick: 35,
    kind: "exterior",
    finish: "paint",
    outwardNormal: { x: 0, z: -1 },
    openings: [],
  },
  {
    id: "west-main",
    axis: "z",
    fixedTick: -1,
    fromTick: -1,
    toTick: 21,
    kind: "exterior",
    finish: "paint",
    outwardNormal: { x: -1, z: 0 },
    openings: [],
  },
  {
    id: "entry-return",
    axis: "x",
    fixedTick: 21,
    fromTick: -1,
    toTick: 1,
    kind: "exterior",
    finish: "paint",
    outwardNormal: { x: 0, z: 1 },
    openings: [],
  },
  {
    id: "entry-west",
    axis: "z",
    fixedTick: 1,
    fromTick: 21,
    toTick: 27,
    kind: "exterior",
    finish: "paint",
    outwardNormal: { x: -1, z: 0 },
    openings: [],
  },
  {
    id: "entry-south",
    axis: "x",
    fixedTick: 27,
    fromTick: 1,
    toTick: 23,
    kind: "exterior",
    finish: "paint",
    outwardNormal: { x: 0, z: 1 },
    openings: [{ fromTick: 15, toTick: 19, kind: "door" }],
  },
  {
    id: "laundry-east",
    axis: "z",
    fixedTick: 23,
    fromTick: 21,
    toTick: 27,
    kind: "exterior",
    finish: "paint",
    outwardNormal: { x: 1, z: 0 },
    openings: [],
  },
  {
    id: "bathroom-south",
    axis: "x",
    fixedTick: 21,
    fromTick: 23,
    toTick: 35,
    kind: "exterior",
    finish: "paint",
    outwardNormal: { x: 0, z: 1 },
    openings: [],
  },
  {
    id: "east-main",
    axis: "z",
    fixedTick: 35,
    fromTick: -1,
    toTick: 21,
    kind: "exterior",
    finish: "paint",
    outwardNormal: { x: 1, z: 0 },
    openings: [],
  },
  {
    id: "facade-kitchen-pier",
    axis: "x",
    fixedTick: 5,
    fromTick: -1,
    toTick: 3,
    kind: "partition",
    finish: "paint",
    outwardNormal: { x: 0, z: -1 },
    openings: [],
  },
  {
    id: "living-slider",
    axis: "x",
    fixedTick: 5,
    fromTick: 3,
    toTick: 17,
    kind: "sliding-glazing",
    finish: "glass",
    outwardNormal: { x: 0, z: -1 },
    openings: [],
  },
  {
    id: "facade-bedroom-pier",
    axis: "x",
    fixedTick: 5,
    fromTick: 17,
    toTick: 19,
    kind: "partition",
    finish: "paint",
    outwardNormal: { x: 0, z: -1 },
    openings: [],
  },
  {
    id: "bedroom-west",
    axis: "z",
    fixedTick: 19,
    fromTick: -1,
    toTick: 15,
    kind: "partition",
    finish: "paint",
    outwardNormal: { x: -1, z: 0 },
    openings: [{ fromTick: 11, toTick: 15, kind: "door" }],
  },
  {
    id: "bedroom-south",
    axis: "x",
    fixedTick: 15,
    fromTick: 19,
    toTick: 35,
    kind: "partition",
    finish: "paint",
    outwardNormal: { x: 0, z: -1 },
    openings: [{ fromTick: 19, toTick: 23, kind: "door" }],
  },
  {
    id: "bathroom-west",
    axis: "z",
    fixedTick: 25,
    fromTick: 15,
    toTick: 21,
    kind: "partition",
    finish: "tile",
    outwardNormal: { x: -1, z: 0 },
    openings: [{ fromTick: 15, toTick: 19, kind: "door" }],
  },
  {
    id: "laundry-north",
    axis: "x",
    fixedTick: 21,
    fromTick: 19,
    toTick: 23,
    kind: "partition",
    finish: "paint",
    outwardNormal: { x: 0, z: -1 },
    openings: [],
  },
  {
    id: "laundry-west",
    axis: "z",
    fixedTick: 19,
    fromTick: 21,
    toTick: 27,
    kind: "partition",
    finish: "paint",
    outwardNormal: { x: -1, z: 0 },
    openings: [{ fromTick: 23, toTick: 27, kind: "door" }],
  },
];

function materialForCode(code: string): FloorMaterial | undefined {
  if (code === "B") {
    return "balcony-tile";
  }
  if (code === "T" || code === "U") {
    return "wet-tile";
  }
  if (code === "L" || code === "D" || code === "H") {
    return "oak";
  }
  return undefined;
}

export function floorMaterialAt(
  x: number,
  z: number,
): FloorMaterial | undefined {
  if (x < 0 || z < 0 || x >= PLAN_WIDTH || z >= PLAN_DEPTH) {
    return undefined;
  }
  const row = APARTMENT_ROWS[z];
  if (row === undefined) {
    return undefined;
  }
  return materialForCode(row.charAt(x));
}

export function apartmentFloorCells(): readonly FloorCell[] {
  const cells: FloorCell[] = [];
  for (let z = 0; z < PLAN_DEPTH; z += 1) {
    for (let x = 0; x < PLAN_WIDTH; x += 1) {
      const material = floorMaterialAt(x, z);
      if (material !== undefined) {
        cells.push({ x, z, material });
      }
    }
  }
  return cells;
}

function visibleIntervals(run: WallRun): readonly VisibleInterval[] {
  const intervals: VisibleInterval[] = [];
  const openings = [...run.openings].sort(
    (left, right) => left.fromTick - right.fromTick,
  );
  let cursor = run.fromTick;

  for (const opening of openings) {
    if (opening.fromTick > cursor) {
      intervals.push({ fromTick: cursor, toTick: opening.fromTick });
    }
    if (opening.toTick > cursor) {
      cursor = opening.toTick;
    }
  }
  if (cursor < run.toTick) {
    intervals.push({ fromTick: cursor, toTick: run.toTick });
  }
  return intervals;
}

function pointForTick(
  run: WallRun,
  variableTick: number,
): PlanPoint {
  if (run.axis === "x") {
    return { x: variableTick / 2, z: run.fixedTick / 2 };
  }
  return { x: run.fixedTick / 2, z: variableTick / 2 };
}

export function compileWallRuns(): readonly CompiledWallSegment[] {
  const segments: CompiledWallSegment[] = [];
  for (const run of WALL_RUNS) {
    for (const interval of visibleIntervals(run)) {
      let cursor = interval.fromTick;
      while (cursor < interval.toTick) {
        const next = Math.min(cursor + 2, interval.toTick);
        segments.push({
          id: run.id,
          start: pointForTick(run, cursor),
          end: pointForTick(run, next),
          kind: run.kind,
          finish: run.finish,
          outwardNormal: run.outwardNormal,
          startCap: cursor === interval.fromTick,
          endCap: next === interval.toTick,
        });
        cursor = next;
      }
    }
  }
  return segments;
}
