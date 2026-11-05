import { describe, expect, test } from "bun:test";
import {
  validateCharacterManifest,
  validateFurnitureManifest,
} from "./index";

const sprite = {
  source: "assets/sprites/chair/north.png",
  width: 32,
  height: 48,
  anchor: { x: 16, y: 40 },
};

describe("pixel asset contracts", () => {
  test('supports photo-derived fittings in all four authored views and rejects unknown palettes',()=>{
    const manifest={schemaVersion:1,kind:'furniture',id:'kitchen-run',displayName:'Fitted kitchen',footprint:{width:17,depth:3},heightPixels:140,palette:'apartment-fixtures-v2',views:{north:sprite,east:sprite,south:sprite,west:sprite}};
    expect(validateFurnitureManifest(manifest).ok).toBe(true);
    expect(validateFurnitureManifest({...manifest,palette:'unknown'}).ok).toBe(false);
    expect(validateFurnitureManifest({...manifest,views:{north:sprite,east:sprite,south:sprite}}).ok).toBe(false);
  });
  test("requires all four furniture directions", () => {
    const result = validateFurnitureManifest({
      schemaVersion: 1,
      kind: "furniture",
      id: "reading-chair",
      displayName: "Reading Chair",
      footprint: { width: 1, depth: 1 },
      heightPixels: 48,
      palette: "apartment-hotel-v1",
      views: {
        north: sprite,
        east: sprite,
        south: sprite,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("exactly north, east, south, and west");
  });

  test("accepts a complete furniture manifest", () => {
    const result = validateFurnitureManifest({
      schemaVersion: 1,
      kind: "furniture",
      id: "reading-chair",
      displayName: "Reading Chair",
      footprint: { width: 1, depth: 1 },
      heightPixels: 48,
      palette: "apartment-hotel-v1",
      views: {
        north: sprite,
        east: sprite,
        south: sprite,
        west: sprite,
      },
    });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("rejects a character animation with a missing direction", () => {
    const result = validateCharacterManifest({
      schemaVersion: 1,
      kind: "character",
      id: "miso-cat",
      displayName: "Miso",
      footprint: { width: 1, depth: 1 },
      palette: "apartment-hotel-v1",
      animations: {
        idle: {
          north: {
            ...sprite,
            frameWidth: 32,
            frameHeight: 48,
            frameCount: 4,
            framesPerSecond: 4,
          },
          east: {
            ...sprite,
            frameWidth: 32,
            frameHeight: 48,
            frameCount: 4,
            framesPerSecond: 4,
          },
          south: {
            ...sprite,
            frameWidth: 32,
            frameHeight: 48,
            frameCount: 4,
            framesPerSecond: 4,
          },
        },
      },
    });

    expect(result.ok).toBe(false);
  });
});
