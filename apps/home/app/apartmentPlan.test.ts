import { describe, expect, test } from "bun:test";
import {
  APARTMENT_ROWS,
  PLAN_DEPTH,
  PLAN_WIDTH,
  apartmentFloorCells,
  compileWallRuns,
  floorMaterialAt,
} from "./apartmentPlan";

describe("apartment floorplan", () => {
  test("keeps every row on the same architectural grid", () => {
    expect(APARTMENT_ROWS).toHaveLength(PLAN_DEPTH);
    expect(APARTMENT_ROWS.every((row) => row.length === PLAN_WIDTH)).toBe(true);
  });

  test("maps the major rooms to their reference materials", () => {
    expect(floorMaterialAt(2, 1)).toBe("balcony-tile");
    expect(floorMaterialAt(4, 6)).toBe("oak");
    expect(floorMaterialAt(15, 9)).toBe("wet-tile");
    expect(floorMaterialAt(0, 13)).toBeUndefined();
    expect(floorMaterialAt(9, 3)).toBe("oak");
    expect(floorMaterialAt(10, 3)).toBe("oak");
  });

  test("builds one stable set of occupied floor cells", () => {
    const cells = apartmentFloorCells();
    expect(cells.length).toBeGreaterThan(150);
    expect(
      cells.every(
        (cell) =>
          Number.isInteger(cell.x) &&
          Number.isInteger(cell.z) &&
          cell.x >= 0 &&
          cell.z >= 0,
      ),
    ).toBe(true);
  });

  test("compiles walls into atomic spans and preserves explicit doors", () => {
    const segments = compileWallRuns();
    expect(segments.every((segment) => {
      const width = Math.abs(segment.end.x - segment.start.x);
      const depth = Math.abs(segment.end.z - segment.start.z);
      return (width === 0 || depth === 0) && width + depth <= 1;
    })).toBe(true);
    expect(
      segments.some(
        (segment) =>
          segment.id === "entry-south" &&
          segment.start.x < 7.5 &&
          segment.end.x <= 7.5,
      ),
    ).toBe(true);
    expect(
      segments.some(
        (segment) =>
          segment.id === "entry-south" &&
          segment.start.x >= 9.5,
      ),
    ).toBe(true);
  });
});
