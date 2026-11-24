import { describe, expect, test } from "bun:test";
import {
  HealthImportError,
  healthInstant,
  assignRuns,
  readHealthExport,
  sameRun,
} from "../src/server/health-export";

const timezone = "Australia/Brisbane";
const today = "2026-11-24";
const weights = (units: string, data: unknown[]) => ({
  data: { metrics: [{ name: "weight_body_mass", units, data }] },
});

describe("Health export timestamps", () => {
  test("reads the Health Auto Export and ISO 8601 formats", () => {
    expect(healthInstant("2026-11-20 06:30:00 +1000")?.toISOString()).toBe(
      "2026-11-19T20:30:00.000Z",
    );
    expect(healthInstant("2026-11-20T06:30:00+10:00")?.toISOString()).toBe(
      "2026-11-19T20:30:00.000Z",
    );
    expect(healthInstant("2026-11-20T06:30:00.250Z")?.toISOString()).toBe(
      "2026-11-20T06:30:00.250Z",
    );
  });
  test("rejects timestamps without an offset", () => {
    expect(healthInstant("2026-11-20 06:30:00")).toBeNull();
    expect(healthInstant("2026-11-20")).toBeNull();
    expect(healthInstant("yesterday")).toBeNull();
  });
});

describe("Health export weigh-ins", () => {
  test("keeps the earliest weigh-in of each account date", () => {
    const result = readHealthExport(
      weights("kg", [
        { date: "2026-11-20 19:00:00 +1000", qty: 81.2, source: "Scale" },
        { date: "2026-11-20 06:10:00 +1000", qty: 80.4 },
        { date: "2026-11-21 06:00:00 +1000", qty: 80.1 },
      ]),
      timezone,
      today,
    );
    expect(result.weights.map((w) => [w.date, w.samples[0]?.kg])).toEqual([
      ["2026-11-20", 80.4],
      ["2026-11-21", 80.1],
    ]);
    expect(result.skipped).toEqual([]);
  });
  test("dates samples in the account timezone", () => {
    const result = readHealthExport(
      weights("kg", [{ date: "2026-11-20 22:30:00 +0000", qty: 80 }]),
      timezone,
      today,
    );
    expect(result.weights[0]?.date).toBe("2026-11-21");
  });
  test("converts pounds and stone to kilograms", () => {
    const pounds = readHealthExport(
      weights("lb", [{ date: "2026-11-20 06:00:00 +1000", qty: 176.37 }]),
      timezone,
      today,
    );
    expect(pounds.weights[0]?.samples[0]?.kg).toBeCloseTo(80, 2);
    const stone = readHealthExport(
      weights("st", [{ date: "2026-11-20 06:00:00 +1000", qty: 12.6 }]),
      timezone,
      today,
    );
    expect(stone.weights[0]?.samples[0]?.kg).toBeCloseTo(80.014, 2);
  });
  test("skips future, out-of-range and undated samples with reasons", () => {
    const result = readHealthExport(
      weights("kg", [
        { date: "2026-11-25 06:00:00 +1000", qty: 80 },
        { date: "2026-11-20 06:00:00 +1000", qty: 4 },
        { date: "20 November", qty: 80 },
      ]),
      timezone,
      today,
    );
    expect(result.weights).toEqual([]);
    expect(result.skipped).toEqual([
      { type: "weight", date: "2026-11-25", reason: "Dated after today." },
      {
        type: "weight",
        date: "2026-11-20",
        reason: "Weight is outside 20–500 kg.",
      },
      { type: "weight", date: null, reason: 'Unreadable date "20 November".' },
    ]);
  });
  test("counts other metrics and rejects unknown weight units", () => {
    const result = readHealthExport(
      {
        data: {
          metrics: [
            {
              name: "heart_rate",
              units: "count/min",
              data: [{ date: "x", Min: 50, Avg: 60, Max: 90 }],
            },
            { name: "step_count", units: "count", data: [] },
          ],
        },
      },
      timezone,
      today,
    );
    expect(result.ignored).toEqual({ metrics: 2, workouts: 0 });
    expect(() => readHealthExport(weights("oz", []), timezone, today)).toThrow(
      "data.metrics.0.units: Send weight in kg, lb or st.",
    );
  });
});

describe("Health export runs", () => {
  const run = (overrides: Record<string, unknown>) => ({
    data: {
      workouts: [
        {
          id: "A1B2",
          name: "Running",
          start: "2026-11-22 06:00:00 +1000",
          end: "2026-11-22 06:32:00 +1000",
          duration: 1815,
          distance: { qty: 5.2, units: "km" },
          location: "Outdoor",
          heartRateData: [{ date: "2026-11-22 06:01:00 +1000", qty: 140 }],
          ...overrides,
        },
      ],
    },
  });
  test("reads version 2 running workouts", () => {
    expect(readHealthExport(run({}), timezone, today).runs).toEqual([
      {
        date: "2026-11-22",
        start: "2026-11-21T20:00:00.000Z",
        minutes: 30.25,
        distanceKm: 5.2,
      },
    ]);
  });
  test("reads version 1 workouts from their start and end in miles", () => {
    const [entry] = readHealthExport(
      run({
        name: "Outdoor Run",
        duration: undefined,
        distance: { qty: 3.1, units: "mi" },
      }),
      timezone,
      today,
    ).runs;
    expect(entry?.minutes).toBe(32);
    expect(entry?.distanceKm).toBeCloseTo(4.989, 3);
  });
  test("records a run without distance as 0 km", () => {
    expect(
      readHealthExport(
        run({ name: "Indoor Run", distance: null }),
        timezone,
        today,
      ).runs[0]?.distanceKm,
    ).toBe(0);
  });
  test("counts other workouts and drops repeated starts", () => {
    const result = readHealthExport(
      {
        data: {
          workouts: [
            run({}).data.workouts[0],
            run({}).data.workouts[0],
            { name: "Traditional Strength Training", start: "x" },
            { name: "Walking", start: "2026-11-22 08:00:00 +1000" },
          ],
        },
      },
      timezone,
      today,
    );
    expect(result.runs).toHaveLength(1);
    expect(result.ignored).toEqual({ metrics: 0, workouts: 2 });
  });
  test("skips runs it cannot record with reasons", () => {
    const reasons = [
      run({ start: "2026-11-30 06:00:00 +1000" }),
      run({ duration: undefined, end: undefined }),
      run({ duration: 0 }),
      run({ distance: { qty: 5, units: "furlong" } }),
      run({ distance: { qty: 600, units: "km" } }),
      run({ start: "Sunday" }),
    ].map((body) => readHealthExport(body, timezone, today).skipped[0]?.reason);
    expect(reasons).toEqual([
      "Dated after today.",
      "The workout has no duration or end time.",
      "Duration is outside 0–1440 minutes.",
      "Send distance in km, m, mi or yd.",
      "Distance is outside 0–500 km.",
      'Unreadable start "Sunday".',
    ]);
  });
});

describe("Health export payloads", () => {
  test("rejects payloads in another shape", () => {
    expect(() => readHealthExport([], timezone, today)).toThrow(
      HealthImportError,
    );
    expect(() => readHealthExport({ metrics: [] }, timezone, today)).toThrow(
      'Send the Health Auto Export JSON format, with metrics or workouts under "data".',
    );
    expect(() =>
      readHealthExport(
        weights("kg", [{ date: "2026-11-20 06:00:00 +1000", qty: "80" }]),
        timezone,
        today,
      ),
    ).toThrow("data.metrics.0.data.0.qty");
  });
  test("limits the samples in one request", () => {
    const data = Array.from({ length: 2001 }, (_, i) => ({
      date: `2020-01-01 06:00:00 +1000`,
      qty: 80 + i / 1000,
    }));
    expect(() =>
      readHealthExport(weights("kg", data), timezone, today),
    ).toThrow("Send up to 2000 weigh-ins and runs per request.");
  });
});

describe("Run matching", () => {
  test("treats runs within 5% or 100 m as the same distance", () => {
    expect(sameRun({ distanceKm: 5 }, { distanceKm: 5.2 })).toBe(true);
    expect(sameRun({ distanceKm: 5 }, { distanceKm: 5.4 })).toBe(false);
    expect(sameRun({ distanceKm: 0 }, { distanceKm: 0.1 })).toBe(true);
    expect(sameRun({ distanceKm: 1 }, { distanceKm: 1.1 })).toBe(true);
    expect(sameRun({ distanceKm: 1 }, { distanceKm: 1.1001 })).toBe(false);
  });
});

describe("Health export edge values", () => {
  test("rejects calendar dates that do not exist and bad offsets", () => {
    expect(healthInstant("2026-02-30 06:00:00 +1000")).toBeNull();
    expect(healthInstant("2026-11-20 24:00:00 +1000")).toBeNull();
    expect(healthInstant("0001-01-01T00:00:00Z")).toBeNull();
    expect(healthInstant("2026-11-20T06:00:00+15:00")).toBeNull();
    expect(healthInstant("2026-11-20T06:00:00+10:60")).toBeNull();
    expect(healthInstant("2026-11-20T06:00Z")?.toISOString()).toBe(
      "2026-11-20T06:00:00.000Z",
    );
  });
  test("treats inherited property names as unknown units", () => {
    expect(() =>
      readHealthExport(weights("constructor", []), timezone, today),
    ).toThrow("Send weight in kg, lb or st.");
    const result = readHealthExport(
      {
        data: {
          workouts: [
            {
              name: "Running",
              start: "2026-11-22 06:00:00 +1000",
              duration: 1800,
              distance: { qty: 5, units: "toString" },
            },
          ],
        },
      },
      timezone,
      today,
    );
    expect(result.runs).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("Send distance in km, m, mi or yd.");
  });
  test("checks duration bounds before rounding", () => {
    const runOf = (duration: number) =>
      readHealthExport(
        {
          data: {
            workouts: [
              {
                name: "Running",
                start: "2026-11-22 06:00:00 +1000",
                duration,
                distance: { qty: 0, units: "km" },
              },
            ],
          },
        },
        timezone,
        today,
      );
    expect(runOf(0.25).runs[0]?.minutes).toBe(0.01);
    expect(runOf(86400).runs[0]?.minutes).toBe(1440);
    expect(runOf(86400.1).skipped[0]?.reason).toBe(
      "Duration is outside 0–1440 minutes.",
    );
  });
  test("lists every weigh-in sent for a date", () => {
    const [weight] = readHealthExport(
      weights("kg", [
        { date: "2026-11-20 19:00:00 +1000", qty: 81.2 },
        { date: "2026-11-20 06:10:00 +1000", qty: 80.4 },
        { date: "2026-11-20 06:10:00 +1000", qty: 80.4 },
      ]),
      timezone,
      today,
    ).weights;
    expect(weight).toEqual({
      date: "2026-11-20",
      samples: [
        { at: "2026-11-19T20:10:00.000Z", kg: 80.4 },
        { at: "2026-11-20T09:00:00.000Z", kg: 81.2 },
      ],
    });
  });
  test("counts the payload's weigh-ins and runs before dating them", () => {
    const result = readHealthExport(
      {
        data: {
          metrics: [
            {
              name: "weight_body_mass",
              units: "kg",
              data: [
                { date: "2026-11-20 06:00:00 +1000", qty: 80 },
                { date: "2026-11-20 07:00:00 +1000", qty: 80 },
                { date: "2026-11-30 06:00:00 +1000", qty: 80 },
              ],
            },
          ],
          workouts: [
            { name: "Walking", start: "2026-11-20 06:00:00 +1000" },
            {
              name: "Running",
              start: "2026-11-30 06:00:00 +1000",
              duration: 60,
            },
          ],
        },
      },
      timezone,
      today,
    );
    expect(result.sent).toEqual({ weights: 3, runs: 1 });
  });
});

describe("Run assignment", () => {
  const km = (...values: number[]) =>
    values.map((distanceKm) => ({ distanceKm }));
  test("matches as many runs as possible", () => {
    // 5.05 fits both entered runs; 5.30 fits only 5.30.
    expect(assignRuns(km(5.05, 5.3), km(5.3, 5))).toEqual([1, 0]);
  });
  test("prefers the smallest total distance difference", () => {
    expect(assignRuns(km(5, 5.2), km(5.2, 5))).toEqual([1, 0]);
  });
  test("leaves runs without a match unpaired", () => {
    expect(assignRuns(km(5, 10), km(5))).toEqual([0, null]);
    expect(assignRuns(km(5), [])).toEqual([null]);
  });
  test("pairs the closest runs first on very busy days", () => {
    const health = km(...Array.from({ length: 13 }, (_, i) => i + 1));
    const entered = km(...Array.from({ length: 13 }, (_, i) => 13 - i));
    expect(assignRuns(health, entered)).toEqual(
      Array.from({ length: 13 }, (_, i) => 12 - i),
    );
  });
});
