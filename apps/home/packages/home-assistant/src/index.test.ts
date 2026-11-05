import { expect, test } from "bun:test";
import { mapVacuumPointToApartment } from "./index";

test("maps vacuum coordinates into apartment metres", () => {
  const mapped = mapVacuumPointToApartment(
    { x: 1000, y: 500 },
    {
      sourceMapId: "vacuum-map-1",
      scale: 0.001,
      rotationRadians: 0,
      reflectY: true,
      translation: { x: 2, z: 4 },
      measuredErrorMeters: 0.08,
    },
  );

  expect(mapped).toEqual({ x: 3, z: 3.5 });
});
