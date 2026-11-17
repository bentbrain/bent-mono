import { describe, expect, test } from "bun:test";
import {
  addDays,
  createWorkout,
  defaultSettings,
  displayLoad,
  localDate,
  progression,
  scheduled,
  settingsSchema,
  toKg,
  totals,
  workoutSchema,
} from "../src/domain";
import type { RecordEntry } from "../src/domain";
describe("plan dates and snapshots", () => {
  const settings = defaultSettings("2026-01-05", "Australia/Brisbane");
  test("alternates A/B/A then B/A/B across weeks", () => {
    expect(
      [0, 2, 4, 7, 9, 11].map(
        (d) =>
          scheduled(settings, addDays(settings.startDate, d)).routine?.name,
      ),
    ).toEqual([
      "Strength A",
      "Strength B",
      "Strength A",
      "Strength B",
      "Strength A",
      "Strength B",
    ]);
  });
  test("respects timezone at midnight and DST and an edited start date", () => {
    expect(
      localDate("Australia/Brisbane", new Date("2026-01-05T14:01:00Z")),
    ).toBe("2026-01-06");
    expect(
      localDate("America/New_York", new Date("2026-03-08T06:59:00Z")),
    ).toBe("2026-03-08");
    const later = { ...settings, startDate: "2026-01-12" };
    expect(scheduled(later, "2026-01-05").routine?.name).toBe("Strength B");
  });
  test("two introductory weeks then standard sets, timed and sided results", () => {
    const r = settings.routines[0];
    if (!r) throw new Error("Missing template");
    const w = createWorkout(settings, r, "2026-01-05", true, []);
    expect(w.exercises.every((e) => e.sets.length === 2)).toBe(true);
    expect(
      w.exercises.find((e) => e.prescription.id === "plank")?.prescription.mode,
    ).toBe("seconds");
    expect(
      w.exercises.find((e) => e.prescription.id === "row")?.sets[0]?.right,
    ).toBe(10);
    expect(scheduled(settings, "2026-01-19").intro).toBe(false);
    r.exercises.splice(0, 1);
    expect(w.exercises).toHaveLength(6);
  });
  test("rejects incomplete finished workouts and invalid per-side sets", () => {
    const r = settings.routines[0];
    if (!r) throw new Error("Missing template");
    const w = createWorkout(settings, r, "2026-01-05", false, []);
    expect(
      workoutSchema.safeParse({ ...w, finishedAt: new Date().toISOString() })
        .success,
    ).toBe(false);
    w.exercises = w.exercises.map((e) => ({
      ...e,
      sets: e.sets.map((s) => ({
        ...s,
        done: true,
        right: e.prescription.side ? 0 : null,
      })),
    }));
    expect(workoutSchema.safeParse(w).success).toBe(false);
  });
  test("validates configuration", () => {
    expect(
      settingsSchema.safeParse({ ...settings, timezone: "Not/AZone" }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ ...settings, dumbbellsKg: [NaN] }).success,
    ).toBe(false);
  });
});
test("progression requires every side, control, reserve and the prescribed set count", () => {
  const settings = defaultSettings("2026-01-05", "UTC"),
    r = settings.routines[0];
  if (!r) throw new Error();
  const w = createWorkout(settings, r, "2026-01-20", false, []);
  const ex = w.exercises.find((e) => e.prescription.id === "row");
  if (!ex) throw new Error();
  const done = {
    ...ex,
    sets: ex.sets.map((s) => ({
      ...s,
      done: true,
      value: 15,
      right: 15,
      loadKg: 10,
      controlled: true,
      rir: 2,
    })),
  };
  expect(progression(ex.prescription, done, [10, 12.5, 15]).loadKg).toBe(12.5);
  expect(
    progression(
      ex.prescription,
      { ...done, sets: done.sets.slice(0, 2) },
      [12.5],
    ).loadKg,
  ).toBe(10);
  expect(
    progression(
      ex.prescription,
      { ...done, sets: done.sets.map((s) => ({ ...s, right: 14 })) },
      [12.5],
    ).loadKg,
  ).toBe(10);
  expect(
    progression(
      ex.prescription,
      { ...done, sets: done.sets.map((s) => ({ ...s, controlled: false })) },
      [12.5],
    ).loadKg,
  ).toBe(10);
  expect(progression(ex.prescription, done, []).loadKg).toBe(10);
});
test("unit round-trip and daily food totals", () => {
  expect(toKg(displayLoad(10, "lb"), "lb")).toBeCloseTo(10, 2);
  const records: RecordEntry[] = [
    {
      id: crypto.randomUUID(),
      revision: 1,
      updatedAt: "2026-01-05",
      data: {
        kind: "meal",
        name: "Synthetic lunch",
        date: "2026-01-05",
        calories: 550.5,
        protein: 35,
      },
    },
    {
      id: crypto.randomUUID(),
      revision: 1,
      updatedAt: "2026-01-06",
      data: {
        kind: "meal",
        name: "Synthetic breakfast",
        date: "2026-01-06",
        calories: 400,
        protein: 20,
      },
    },
  ];
  expect(totals(records, "2026-01-05")).toEqual({
    calories: 550.5,
    protein: 35,
  });
});
