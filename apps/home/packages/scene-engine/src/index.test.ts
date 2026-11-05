import { describe, expect, test } from "bun:test";
import {
  directionForCamera,
  nextCameraQuarter,
  projectWorldPoint,
  rotateAroundOrigin,
  rotateDirectionClockwise,
} from "./index";

describe("four-quarter scene rotation", () => {
  test("rotates a point through every camera quarter", () => {
    expect(rotateAroundOrigin({ x: 2, z: 1 }, 0)).toEqual({ x: 2, z: 1 });
    expect(rotateAroundOrigin({ x: 2, z: 1 }, 1)).toEqual({ x: -1, z: 2 });
    expect(rotateAroundOrigin({ x: 2, z: 1 }, 2)).toEqual({ x: -2, z: -1 });
    expect(rotateAroundOrigin({ x: 2, z: 1 }, 3)).toEqual({ x: 1, z: -2 });
  });

  test("cycles camera and object directions", () => {
    expect(nextCameraQuarter(3)).toBe(0);
    expect(rotateDirectionClockwise("west")).toBe("north");
    expect(directionForCamera("north", 1)).toBe("west");
  });

  test("projects onto a two-to-one isometric grid", () => {
    expect(
      projectWorldPoint(
        { x: 1, z: 0 },
        0,
        { tileWidth: 32, tileHeight: 16, origin: { x: 160, y: 64 } },
      ),
    ).toEqual({ x: 176, y: 72 });
  });
});
