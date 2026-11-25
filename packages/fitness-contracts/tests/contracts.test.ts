import { describe, expect, test } from "bun:test";
import {
  DeviceEnrollRequest,
  DeviceHealthImportRequest,
  DeviceOutcome,
  HealthEnvelope,
  HealthImportReply,
  canonicalRef,
  isRunningWorkout,
  isWeightMetric,
} from "../src/index";

const uuid = "6F1C2A7E-3D4B-4C5A-8E9F-0A1B2C3D4E5F";
const weighIn = (ref: string, date = "2026-11-20T06:10:00+10:00") => ({
  ref,
  date,
  qty: 80.4,
});
const request = (data: object[], workouts: object[] = []) => ({
  data: {
    metrics: [{ name: "weight_body_mass", units: "kg", data }],
    workouts,
  },
});
const run = (ref: string) => ({
  ref,
  name: "Running",
  start: "2026-11-21T06:00:00+10:00",
  duration: 1815,
  distance: { qty: 5.2, units: "km" },
});
function firstIssue(value: unknown) {
  const parsed = DeviceHealthImportRequest.safeParse(value);
  if (parsed.success) return null;
  const [issue] = parsed.error.issues;
  return { path: issue?.path.join("."), message: issue?.message };
}

describe("Health envelope", () => {
  test("reads the Health Auto Export shape and keeps unknown entries", () => {
    const parsed = HealthEnvelope.parse({
      data: {
        metrics: [{ name: "heart_rate", units: "count/min", data: [{}] }],
        workouts: [{ name: "Walking" }],
      },
    });
    expect(parsed.data.metrics?.[0]?.name).toBe("heart_rate");
    expect(parsed.data.workouts).toHaveLength(1);
    expect(HealthEnvelope.safeParse({ metrics: [] }).success).toBe(false);
  });
  test("names weigh-ins and runs the way the importer reads them", () => {
    expect(
      ["weight_body_mass", "Body_Mass", "weight"].map(isWeightMetric),
    ).toEqual([true, true, true]);
    expect(isWeightMetric("step_count")).toBe(false);
    expect(
      ["Running", "Outdoor Run", "Indoor Run"].every(isRunningWorkout),
    ).toBe(true);
    expect(isRunningWorkout("Rowing")).toBe(false);
  });
});

describe("Device import requests", () => {
  test("accepts weigh-ins and runs that carry refs", () => {
    const parsed = DeviceHealthImportRequest.parse({
      expectedTimezone: "Australia/Brisbane",
      ...request([weighIn(`w:${uuid}`)], [run(`r:${uuid}`)]),
    });
    expect(parsed.expectedTimezone).toBe("Australia/Brisbane");
    expect(parsed.data.workouts?.[0]?.distance).toEqual({
      qty: 5.2,
      units: "km",
    });
    expect(
      DeviceHealthImportRequest.safeParse(
        request([], [{ ...run(`r:${uuid}`), distance: null }]),
      ).success,
    ).toBe(true);
  });
  test("names the entry that fails", () => {
    expect(
      firstIssue(request([{ date: "2026-11-20T06:10:00Z", qty: 80 }])),
    ).toMatchObject({
      path: "data.metrics.0.data.0.ref",
    });
    expect(firstIssue(request([weighIn("w:not-a-uuid")]))).toEqual({
      path: "data.metrics.0.data.0.ref",
      message: "Send the weigh-in's ref as w:<uuid>.",
    });
    expect(firstIssue(request([], [run(`w:${uuid}`)]))).toEqual({
      path: "data.workouts.0.ref",
      message: "A run ref starts with r:.",
    });
    expect(
      firstIssue(request([weighIn(`w:${uuid}`, "2026-11-20 06:10:00 +1000")])),
    ).toMatchObject({
      path: "data.metrics.0.data.0.date",
    });
    expect(
      firstIssue({
        data: { metrics: [{ name: "step_count", units: "count", data: [] }] },
      }),
    ).toMatchObject({ path: "data.metrics.0.name" });
    expect(
      firstIssue(request([], [{ ...run(`r:${uuid}`), name: "Walking" }])),
    ).toMatchObject({
      path: "data.workouts.0.name",
    });
    expect(
      firstIssue({
        data: { metrics: [{ name: "weight", units: "oz", data: [] }] },
      }),
    ).toMatchObject({ path: "data.metrics.0.units" });
    expect(
      firstIssue(request([], [{ ...run(`r:${uuid}`), duration: undefined }])),
    ).toMatchObject({
      path: "data.workouts.0.duration",
    });
  });
  test("compares refs in lower case", () => {
    expect(canonicalRef(`W:${uuid}`)).toBe(`w:${uuid.toLowerCase()}`);
    expect(
      firstIssue(
        request([
          weighIn(`w:${uuid}`),
          weighIn(`w:${uuid.toLowerCase()}`, "2026-11-21T06:10:00+10:00"),
        ]),
      ),
    ).toEqual({
      path: "data.metrics.0.data.1.ref",
      message: "This ref was already sent at data.metrics.0.data.0.ref.",
    });
    // A weigh-in and a run may share a HealthKit UUID only with their own prefixes.
    expect(
      firstIssue(request([weighIn(`w:${uuid}`)], [run(`r:${uuid}`)])),
    ).toBeNull();
  });
});

describe("Replies", () => {
  test("pairs each result with its codes", () => {
    const outcome = (result: string, code: string) =>
      DeviceOutcome.safeParse({
        ref: `w:${uuid}`,
        type: "weight",
        result,
        code,
      }).success;
    expect(outcome("added", "new")).toBe(true);
    expect(outcome("kept", "duplicate_in_request")).toBe(true);
    expect(outcome("skipped", "future")).toBe(true);
    expect(outcome("added", "future")).toBe(false);
    expect(outcome("kept", "new")).toBe(false);
  });
  test("tells the three reply shapes apart", () => {
    expect(
      HealthImportReply.parse({ received: { weights: 1, runs: 0 } }),
    ).toEqual({
      received: { weights: 1, runs: 0 },
    });
    expect(
      HealthImportReply.parse({
        kind: "device",
        accountTimezone: "UTC",
        outcomes: [],
      }),
    ).toMatchObject({ kind: "device" });
  });
});

describe("Enrollment", () => {
  test("checks the installation ID and device name", () => {
    expect(
      DeviceEnrollRequest.parse({
        installationId: uuid,
        deviceName: "  Synthetic iPhone ",
      }),
    ).toEqual({ installationId: uuid, deviceName: "Synthetic iPhone" });
    for (const deviceName of ["", "x".repeat(61), "iPhone\u0000", "iPhone‮"])
      expect(
        DeviceEnrollRequest.safeParse({ installationId: uuid, deviceName })
          .success,
      ).toBe(false);
    expect(
      DeviceEnrollRequest.safeParse({
        installationId: "phone",
        deviceName: "iPhone",
      }).success,
    ).toBe(false);
  });
});
