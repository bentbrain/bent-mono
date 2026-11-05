import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeVehicleState,
  vehicleStatusSchema,
  vinSchema,
} from "./index.js";

void test("unknown Fleet API vehicle states normalize safely", () => {
  assert.equal(normalizeVehicleState("online"), "online");
  assert.equal(normalizeVehicleState("unexpected"), "unknown");
  assert.equal(normalizeVehicleState(undefined), "unknown");
});

void test("the shared vehicle contract validates VIN and status boundaries", () => {
  assert.equal(vinSchema.safeParse("short").success, true);
  assert.equal(vinSchema.safeParse("tiny").success, false);
  assert.equal(
    vehicleStatusSchema.safeParse({
      vin: "MOCKVIN0000000001",
      displayName: "Nova",
      state: "online",
      batteryLevel: 101,
      estimatedRangeKm: 300,
      chargingState: "Disconnected",
      chargeLimitPercent: 80,
      locked: true,
      cabinTempC: 23,
      climateOn: false,
      sentryMode: true,
      observedAt: "2026-07-10T00:00:00.000Z",
    }).success,
    false
  );
});
