import { describe, expect, test } from "bun:test";
import {
  addDays,
  completedActivity,
  correctionProblem,
  correctionReplacement,
  createWorkout,
  dateSearch,
  formatDate,
  formatShortDate,
  lastExercise,
  sameData,
  sessionMinutes,
  setResult,
  trainingRecords,
  defaultSettings,
  effectivePrescription,
  displayLoad,
  localDate,
  mondayOf,
  nextSession,
  progression,
  scheduled,
  reorganiseDays,
  settingsSchema,
  toKg,
  totals,
  workoutSchema,
} from "../src/domain";
import {
  dailyWeights,
  strengthSeries,
  weeklySummary,
  weightTrend,
} from "../src/progress";
import { elapsedSeconds, formatDuration, remainingRest } from "../src/timing";
import {
  type Buffered,
  applyText,
  holdInBackground,
  WorkoutInputStorage,
  migrateLegacy,
  savedBase,
  savedText,
  shownText,
} from "../src/components/workout-inputs";
import { correctionStatus, editStatus } from "../src/components/record-edit";
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

test("an all-rest schedule has no next session", () => {
  const settings = defaultSettings("2026-01-05", "UTC");
  settings.schedule = settings.schedule.map(() => "rest");
  expect(nextSession(settings, "2026-01-05", [])).toBeNull();
});

test("session and rest timers use saved deadlines across navigation and reload", () => {
  const start = "2026-01-05T08:00:00.000Z";
  const now = Date.parse(start);
  expect(elapsedSeconds(start, now + 7200500)).toBe(7200);
  expect(elapsedSeconds(start, now - 1000)).toBe(0);
  expect(remainingRest(now + 120000, now + 1001)).toBe(119);
  expect(remainingRest(now + 120000, now + 121000)).toBe(0);
  expect(remainingRest(null, now)).toBe(0);
  expect(formatDuration(0)).toBe("0:00");
  expect(formatDuration(75)).toBe("1:15");
  expect(formatDuration(3661)).toBe("1:01:01");
  expect(formatDuration(-1)).toBe("0:00");
});

test("introductory previews and workout snapshots respect one-set prescriptions", () => {
  const settings = defaultSettings("2026-01-05", "UTC");
  const routine = settings.routines[0];
  const first = routine?.exercises[0];
  if (!routine || !first) throw new Error("Missing template");
  first.sets = 1;
  const expected = routine.exercises.map((exercise) =>
    effectivePrescription(exercise, true),
  );
  const workout = createWorkout(settings, routine, "2026-01-05", true, []);
  expect(expected[0]?.sets).toBe(1);
  expect(workout.exercises.map((exercise) => exercise.prescription)).toEqual(
    expected,
  );
  expect(effectivePrescription({ ...first, sets: 3 }, false).sets).toBe(3);
});

function completedWorkout(date: string, routineIndex = 0, load = 10) {
  const settings = defaultSettings("2026-01-05", "UTC");
  const routine = settings.routines[routineIndex];
  if (!routine) throw new Error("Missing template");
  const workout = createWorkout(settings, routine, date, false, []);
  workout.startedAt = `${date}T07:00:00.000Z`;
  workout.finishedAt = `${date}T07:45:00.000Z`;
  for (const exercise of workout.exercises)
    for (const set of exercise.sets) {
      set.done = true;
      set.loadKg = exercise.prescription.mode === "seconds" ? 0 : load;
      set.value = exercise.prescription.max;
      set.right = exercise.prescription.side ? exercise.prescription.max : null;
      set.rir = 2;
    }
  return workoutSchema.parse(workout);
}
function entry(data: RecordEntry["data"], id = crypto.randomUUID()) {
  return { id, revision: 1, updatedAt: "2026-01-05T08:00:00.000Z", data };
}

describe("skipped sets", () => {
  test("a workout can finish with skipped sets but not with unhandled sets", () => {
    const workout = completedWorkout("2026-01-05");
    const first = workout.exercises[0]?.sets[0];
    if (!first) throw new Error("Missing set");
    first.done = false;
    first.skipped = true;
    expect(workoutSchema.safeParse(workout).success).toBe(true);
    first.skipped = false;
    expect(workoutSchema.safeParse(workout).error?.issues[0]?.message).toBe(
      "Complete or skip every set before finishing.",
    );
    first.done = true;
    first.skipped = true;
    expect(workoutSchema.safeParse(workout).success).toBe(false);
  });
  test("skipped sets block a weight increase and keep the done set load", () => {
    const workout = completedWorkout("2026-01-05", 0, 10);
    const squat = workout.exercises.find((e) => e.prescription.id === "squat");
    if (!squat) throw new Error("Missing exercise");
    expect(progression(squat.prescription, squat, [10, 12]).loadKg).toBe(12);
    const skipped = {
      ...squat,
      sets: squat.sets.map((set, i) =>
        i === 0 ? { ...set, done: false, skipped: true, loadKg: 4 } : set,
      ),
    };
    const advice = progression(squat.prescription, skipped, [10, 12]);
    expect(advice.loadKg).toBe(10);
    expect(advice.text).toContain("Repeat the load");
  });
  test("last time ignores exercises that were skipped entirely", () => {
    const earlier = completedWorkout("2026-01-05", 0, 8);
    const later = completedWorkout("2026-01-07", 0, 10);
    for (const exercise of later.exercises)
      if (exercise.prescription.id === "squat")
        exercise.sets = exercise.sets.map((set) => ({
          ...set,
          done: false,
          skipped: true,
        }));
    const records = [entry(earlier), entry(later)];
    expect(lastExercise(records, "squat")?.sets[0]?.loadKg).toBe(8);
    expect(lastExercise(records, "bench")?.sets[0]?.loadKg).toBe(10);
  });
});

describe("workout corrections", () => {
  test("corrections replace or hide the original in history and progression", () => {
    const original = completedWorkout("2026-01-05", 0, 10);
    const id = crypto.randomUUID();
    const corrected = structuredClone(original);
    for (const set of corrected.exercises[0]?.sets ?? []) set.loadKg = 6;
    const records: RecordEntry[] = [
      entry(original, id),
      entry({
        kind: "workoutCorrection",
        workoutId: id,
        replacement: corrected,
        reason: "Entered the wrong weight",
      }),
    ];
    const projected = trainingRecords(records);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.id).toBe(id);
    expect(lastExercise(records, "squat")?.sets[0]?.loadKg).toBe(6);
    const removed: RecordEntry[] = [
      entry(original, id),
      entry({
        kind: "workoutCorrection",
        workoutId: id,
        replacement: null,
        reason: "Removed from history",
      }),
    ];
    expect(trainingRecords(removed)).toEqual([]);
    expect(lastExercise(removed, "squat")).toBeUndefined();
    expect(completedActivity(removed).size).toBe(0);
    expect(completedActivity(records).get("2026-01-05")).toEqual({
      strength: true,
      run: false,
    });
  });
  test("a correction can change the date, results and notes only", () => {
    const original = completedWorkout("2026-01-05");
    const allowed = structuredClone(original);
    allowed.date = "2026-01-04";
    allowed.notes = "Corrected";
    for (const set of allowed.exercises[1]?.sets ?? []) set.value = 9;
    expect(correctionProblem(original, allowed)).toBeNull();
    const changes: ((w: typeof original) => void)[] = [
      (w) => (w.routineId = "00000000-0000-4000-8000-00000000000b"),
      (w) => (w.startedAt = "2026-01-05T06:00:00.000Z"),
      (w) => (w.finishedAt = "2026-01-05T09:00:00.000Z"),
      (w) => (w.restUntil = 1),
      (w) => w.exercises.pop(),
      (w) => {
        const p = w.exercises[0]?.prescription;
        if (p) p.max = 30;
      },
    ];
    for (const change of changes) {
      const replacement = structuredClone(original);
      change(replacement);
      expect(correctionProblem(original, replacement)).toBe(
        "A correction can change the workout date, set results and notes only.",
      );
    }
  });
  test("a scheduled day is done only by matching training", () => {
    const settings = defaultSettings("2026-01-05", "UTC");
    const run = entry({
      kind: "run",
      date: "2026-01-05",
      minutes: 20,
      distanceKm: 3,
      notes: "",
    });
    expect(nextSession(settings, "2026-01-05", [run])?.date).toBe("2026-01-05");
    const workout = entry(completedWorkout("2026-01-05"));
    expect(nextSession(settings, "2026-01-05", [workout])?.date).toBe(
      "2026-01-06",
    );
  });
});

test("dates, set results and session estimates read plainly", () => {
  expect(formatDate("2026-11-20")).toBe("Fri 20 Nov 2026");
  expect(formatShortDate("2026-11-20")).toBe("Fri 20 Nov");
  expect(dateSearch("2026-11-18", "2026-11-18")).toEqual({ date: undefined });
  expect(dateSearch("2026-11-20", "2026-11-18")).toEqual({
    date: "2026-11-20",
  });
  const settings = defaultSettings("2026-01-05", "UTC");
  const [a] = settings.routines;
  if (!a) throw new Error("Missing template");
  const plank = a.exercises.find((e) => e.id === "plank");
  const row = a.exercises.find((e) => e.id === "row");
  if (!plank || !row) throw new Error("Missing exercise");
  const set = {
    loadKg: 0,
    value: 40,
    right: null,
    done: true,
    skipped: false,
    rir: 2,
    controlled: true,
  };
  expect(setResult(set, plank, "kg")).toBe("40 seconds");
  expect(
    setResult({ ...set, loadKg: 10, value: 12, right: 11 }, row, "kg"),
  ).toBe("10 kg × 12 left / 11 right");
  expect(setResult({ ...set, skipped: true, done: false }, row, "kg")).toBe(
    "Skipped",
  );
  const intro = sessionMinutes(a, true);
  const full = sessionMinutes(a, false);
  expect(intro % 5).toBe(0);
  expect(intro).toBeLessThan(full);
  expect(intro).toBeGreaterThanOrEqual(20);
  expect(full).toBeLessThanOrEqual(90);
});

describe("typed workout values", () => {
  const settings = defaultSettings("2026-01-05", "UTC");
  const routine = settings.routines[0];
  if (!routine) throw new Error("Missing template");
  const workout = createWorkout(settings, routine, "2026-01-05", false, []);
  test("valid text updates only its own field", () => {
    const next = applyText(workout, "0:1:value", "12", "kg");
    if (!next || typeof next === "string") throw new Error("Expected update");
    expect(next.exercises[0]?.sets[1]?.value).toBe(12);
    expect(next.exercises[0]?.sets[0]?.value).toBe(
      workout.exercises[0]?.sets[0]?.value,
    );
    const pounds = applyText(workout, "0:0:loadKg", "22.05", "lb");
    if (!pounds || typeof pounds === "string")
      throw new Error("Expected update");
    expect(pounds.exercises[0]?.sets[0]?.loadKg).toBeCloseTo(10, 1);
    expect(savedText(pounds, "0:0:loadKg", "lb")).toBe("22.05");
  });
  test("empty, partial and out-of-range text is kept as an error", () => {
    expect(applyText(workout, "0:0:value", "", "kg")).toBe(
      "Enter reps as a number of 0 or more.",
    );
    expect(applyText(workout, "0:0:value", "9.5", "kg")).toBe(
      "Enter reps as a whole number.",
    );
    expect(applyText(workout, "0:0:rir", "11", "kg")).toBe(
      "Enter reps left as a whole number from 0 to 10.",
    );
    expect(applyText(workout, "0:0:loadKg", "1001", "kg")).toBe(
      "Enter a weight up to 1000 kg.",
    );
    expect(applyText(workout, "40:0:value", "9", "kg")).toBeNull();
  });
  test("recovered weights keep the units they were typed in", () => {
    const empty = applyText(workout, "0:0:loadKg", "0", "kg");
    if (!empty || typeof empty === "string") throw new Error("Expected update");
    const base = savedBase(empty, "0:0:loadKg");
    expect(base).toBe("0");
    // 10 kg typed against 0 kg, restored after the display units became lb.
    const kilograms = { text: "10", base: "0", units: "kg" as const };
    expect(holdInBackground(empty, "0:0:loadKg", kilograms)).toBe(false);
    expect(shownText("0:0:loadKg", kilograms, "lb")).toBe("22.05");
    const fromKg = applyText(empty, "0:0:loadKg", kilograms.text, "kg");
    if (!fromKg || typeof fromKg === "string")
      throw new Error("Expected update");
    expect(fromKg.exercises[0]?.sets[0]?.loadKg).toBe(10);
    // 22 lb typed against 0, restored after the display units became kg.
    const pounds = { text: "22", base: "0", units: "lb" as const };
    expect(holdInBackground(empty, "0:0:loadKg", pounds)).toBe(false);
    expect(shownText("0:0:loadKg", pounds, "kg")).toBe("9.98");
    const fromLb = applyText(empty, "0:0:loadKg", pounds.text, "lb");
    if (!fromLb || typeof fromLb === "string")
      throw new Error("Expected update");
    expect(fromLb.exercises[0]?.sets[0]?.loadKg).toBeCloseTo(9.979, 3);
    // The starting point is compared in kilograms, whatever the display units.
    expect(savedBase(fromLb, "0:0:loadKg")).toBe(
      String(fromLb.exercises[0]?.sets[0]?.loadKg),
    );
    expect(holdInBackground(fromKg, "0:0:loadKg", kilograms)).toBe(true);
  });
  test("values kept without units hold weights for confirmation", () => {
    const migrated = migrateLegacy({
      "0:0:loadKg": { text: "10", base: "0" },
      "0:0:value": { text: "9", base: "8" },
    });
    expect(migrated["0:0:loadKg"]).toEqual({
      text: "10",
      base: null,
      units: null,
    });
    expect(migrated["0:0:value"]).toEqual({
      text: "9",
      base: "8",
      units: null,
    });
    const load = migrated["0:0:loadKg"];
    if (!load) throw new Error("Expected weight");
    expect(holdInBackground(workout, "0:0:loadKg", load)).toBe(true);
    expect(shownText("0:0:loadKg", load, "lb")).toBe("10");
  });
});

describe("record editors", () => {
  const meal = {
    kind: "meal" as const,
    date: "2026-01-05",
    name: "Synthetic oats",
    calories: 350,
    protein: 12,
  };
  const opened = { id: "a", revision: 2, data: meal };
  test("compare record data regardless of property order", () => {
    const { kind, date, name, calories, protein } = meal;
    expect(sameData(meal, { protein, calories, name, date, kind })).toBe(true);
    expect(sameData(meal, { ...meal, calories: 777 })).toBe(false);
  });
  test("report changed and removed records", () => {
    expect(editStatus(opened, { revision: 2, data: { ...meal } })).toBe(
      "current",
    );
    expect(
      editStatus(opened, { revision: 3, data: { ...meal, calories: 777 } }),
    ).toBe("changed");
    // The same revision with other data, as after loading the cloud version.
    expect(
      editStatus(opened, { revision: 2, data: { ...meal, name: "Other" } }),
    ).toBe("changed");
    expect(editStatus(opened, { revision: 3, data: null })).toBe("removed");
    expect(editStatus(opened, undefined)).toBe("removed");
    expect(editStatus(undefined, undefined)).toBe("current");
  });
});

describe("correction saves", () => {
  const original = completedWorkout("2026-01-05");
  const draft = { ...structuredClone(original), finishedAt: null };
  test("a set without Done or Skip explains what to fix instead of saving", () => {
    const unhandled = structuredClone(draft);
    const set = unhandled.exercises[0]?.sets[1];
    if (!set) throw new Error("Missing set");
    set.done = false;
    expect(correctionReplacement(original, unhandled, "2026-01-05")).toEqual({
      problem:
        "Mark Goblet squat set 2 Done or Skip it before saving the correction.",
    });
    set.skipped = true;
    const result = correctionReplacement(original, unhandled, "2026-01-04");
    if (!("replacement" in result)) throw new Error(result.problem);
    expect(result.replacement.finishedAt).toBe(original.finishedAt);
    expect(result.replacement.date).toBe("2026-01-04");
    expect(workoutSchema.safeParse(result.replacement).success).toBe(true);
  });
  test("a correction keeps the original prescription", () => {
    const changed = structuredClone(draft);
    const prescription = changed.exercises[0]?.prescription;
    if (!prescription) throw new Error("Missing exercise");
    prescription.max = 30;
    expect(correctionReplacement(original, changed, "2026-01-05")).toEqual({
      problem:
        "A correction can change the workout date, set results and notes only.",
    });
  });
  test("a cloud version at the same revision blocks a stale correction save", () => {
    const workoutId = crypto.randomUUID();
    const local = {
      kind: "workoutCorrection" as const,
      workoutId,
      replacement: original,
      reason: "Offline edit",
    };
    const cloud = { ...local, reason: "Other device", replacement: draft };
    // Opened while the offline edit was pending as revision 2.
    const opened = { id: "c", revision: 2, data: local };
    expect(
      correctionStatus(opened, { revision: 2, data: local }, undefined),
    ).toBe("current");
    // After choosing the cloud version, revision 2 holds other results.
    expect(
      correctionStatus(opened, { revision: 2, data: cloud }, undefined),
    ).toBe("changed");
    expect(
      correctionStatus(opened, { revision: 3, data: null }, undefined),
    ).toBe("removed");
    const fresh = { id: "n", revision: 0, data: null };
    expect(
      correctionStatus(fresh, { revision: 0, data: null }, undefined),
    ).toBe("current");
    // Another device corrected the same workout under its own ID.
    expect(
      correctionStatus(fresh, { revision: 0, data: null }, { id: "c" }),
    ).toBe("changed");
  });
});

describe("typed values shared by open tabs", () => {
  const invalid = { text: "", base: "8", units: "kg" } satisfies Buffered;
  function memoryStorage() {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      key: (index: number) => Array.from(data.keys())[index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
  }
  test("overlapping writes retain both fields and each tab removes only its observed entries", () => {
    const storage = memoryStorage();
    const a = new WorkoutInputStorage(storage, "workout");
    const b = new WorkoutInputStorage(storage, "workout");
    const original = storage.setItem;
    let overlap = true;
    storage.setItem = (key, value) => {
      if (overlap) {
        overlap = false;
        b.write({ "0:1:value": invalid });
      }
      original(key, value);
    };
    a.write({ "0:0:value": invalid });
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({
      "0:0:value": invalid,
      "0:1:value": invalid,
    });
    b.write({});
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({
      "0:0:value": invalid,
    });
  });
  test("an overlapping removal cannot delete another tab's new value for the same field", () => {
    const storage = memoryStorage();
    const a = new WorkoutInputStorage(storage, "workout");
    a.write({ "0:0:value": invalid });
    const b = new WorkoutInputStorage(storage, "workout");
    const original = storage.removeItem;
    let overlap = true;
    const newer = { ...invalid, text: "13" };
    storage.removeItem = (key) => {
      if (overlap) {
        overlap = false;
        b.write({ "0:0:value": newer });
      }
      original(key);
    };
    a.write({});
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({
      "0:0:value": newer,
    });
  });
  test("explicit clearing preserves an update appended after its snapshot", () => {
    const storage = memoryStorage();
    const a = new WorkoutInputStorage(storage, "workout");
    a.write({ "0:0:value": invalid });
    const b = new WorkoutInputStorage(storage, "workout");
    const original = storage.removeItem;
    let overlap = true;
    storage.removeItem = (key) => {
      if (overlap) {
        overlap = false;
        b.write({ "0:1:value": invalid });
      }
      original(key);
    };
    a.clear();
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({
      "0:1:value": invalid,
    });
  });
  test("shared and unitless legacy snapshots migrate without losing retained text", () => {
    const storage = memoryStorage();
    storage.setItem("workout", JSON.stringify({ "0:0:value": invalid }));
    storage.setItem(
      "legacy",
      JSON.stringify({ "0:1:loadKg": { text: "12", base: "10" } }),
    );
    const a = new WorkoutInputStorage(storage, "workout", "legacy");
    a.write(a.buffer);
    expect(storage.getItem("workout")).toBeNull();
    expect(storage.getItem("legacy")).toBeNull();
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({
      "0:0:value": invalid,
      "0:1:loadKg": { text: "12", base: null, units: null },
    });
  });
  test("partially migrated entries stay owned when later appends fail, then disappear after removal", () => {
    const storage = memoryStorage();
    storage.setItem(
      "workout",
      JSON.stringify({
        "0:0:value": invalid,
        "0:1:value": invalid,
      }),
    );
    const a = new WorkoutInputStorage(storage, "workout");
    const original = storage.setItem;
    let writes = 0;
    storage.setItem = (key, value) => {
      if (++writes === 2) throw Error("Quota exceeded");
      original(key, value);
    };
    expect(() => a.write(a.buffer)).toThrow("Quota exceeded");
    // Saving or skipping the retained fields removes them without another append.
    a.write({});
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({});
    expect(storage.length).toBe(0);
  });
  test("a partial multi-field write retains ownership through retry and removal", () => {
    const storage = memoryStorage();
    const a = new WorkoutInputStorage(storage, "workout");
    const original = storage.setItem;
    let writes = 0;
    storage.setItem = (key, value) => {
      if (++writes === 2) throw Error("Quota exceeded");
      original(key, value);
    };
    const next = { "0:0:value": invalid, "0:1:value": invalid };
    expect(() => a.write(next)).toThrow("Quota exceeded");
    storage.setItem = original;
    a.write(next);
    a.write({});
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({});
    expect(storage.length).toBe(0);
  });
  test("a later cleanup failure keeps successful replacements owned", () => {
    const storage = memoryStorage();
    const a = new WorkoutInputStorage(storage, "workout");
    a.write({ "0:0:value": invalid, "0:1:value": invalid });
    const original = storage.removeItem;
    let removals = 0;
    storage.removeItem = (key) => {
      if (++removals === 2) throw Error("Storage unavailable");
      original(key);
    };
    expect(() =>
      a.write({
        "0:0:value": { ...invalid, text: "12" },
        "0:1:value": { ...invalid, text: "13" },
      }),
    ).toThrow("Storage unavailable");
    storage.removeItem = original;
    a.write({});
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({});
    expect(storage.length).toBe(0);
  });
  test("returning to the previous text after failed cleanup reconciles storage", () => {
    const storage = memoryStorage();
    const a = new WorkoutInputStorage(storage, "workout");
    const previous = { "0:0:value": invalid };
    a.write(previous);
    const original = storage.removeItem;
    storage.removeItem = () => {
      throw Error("Storage unavailable");
    };
    expect(() => a.write({ "0:0:value": { ...invalid, text: "13" } })).toThrow(
      "Storage unavailable",
    );
    storage.removeItem = original;
    a.write(previous);
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual(
      previous,
    );
    expect(storage.length).toBe(1);
  });
  test("recovery converges to the requested text after each partial storage failure", () => {
    const values: Record<string, Buffered>[] = [
      {},
      { "0:0:value": invalid },
      { "0:0:value": { ...invalid, text: "13" } },
      { "0:0:value": invalid, "0:1:value": invalid },
      { "0:0:value": { ...invalid, text: "13" }, "0:1:value": invalid },
    ];
    for (const migrate of [false, true])
      for (const initial of values)
        for (const attempted of values)
          for (const desired of values)
            for (let failure = 1; failure <= 6; failure++) {
              const storage = memoryStorage();
              if (migrate) storage.setItem("workout", JSON.stringify(initial));
              const a = new WorkoutInputStorage(storage, "workout");
              if (!migrate) a.write(initial);
              const set = storage.setItem;
              const remove = storage.removeItem;
              let operations = 0;
              const maybeFail = () => {
                if (++operations === failure)
                  throw Error("Simulated storage failure");
              };
              storage.setItem = (key, value) => {
                maybeFail();
                set(key, value);
              };
              storage.removeItem = (key) => {
                maybeFail();
                remove(key);
              };
              try {
                a.write(attempted);
              } catch (error) {
                expect(error instanceof Error && error.message).toBe(
                  "Simulated storage failure",
                );
              }
              storage.setItem = set;
              storage.removeItem = remove;
              a.write(desired);
              expect(
                new WorkoutInputStorage(storage, "workout").buffer,
              ).toEqual(desired);
              a.write({});
              expect(storage.length).toBe(0);
            }
  });
  test("a failed storage write keeps predecessors and can retry", () => {
    const storage = memoryStorage();
    const a = new WorkoutInputStorage(storage, "workout");
    a.write({ "0:0:value": invalid });
    const original = storage.setItem;
    storage.setItem = () => {
      throw Error("Quota exceeded");
    };
    const next = { "0:0:value": { ...invalid, text: "12" } };
    expect(() => a.write(next)).toThrow("Quota exceeded");
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual({
      "0:0:value": invalid,
    });
    storage.setItem = original;
    a.write(next);
    expect(new WorkoutInputStorage(storage, "workout").buffer).toEqual(next);
  });
});

describe("progress", () => {
  const settings = defaultSettings("2026-01-05", "UTC");
  test("weeks count planned sessions from the plan start and skip removed workouts", () => {
    const kept = entry(completedWorkout("2026-01-05"));
    const removedId = crypto.randomUUID();
    const records: RecordEntry[] = [
      kept,
      entry(completedWorkout("2026-01-07", 1), removedId),
      entry({
        kind: "workoutCorrection",
        workoutId: removedId,
        replacement: null,
        reason: "Removed from history",
      }),
      entry({
        kind: "run",
        date: "2026-01-06",
        minutes: 20,
        distanceKm: 3,
        notes: "",
      }),
    ];
    expect(mondayOf("2026-01-07")).toBe("2026-01-05");
    expect(mondayOf("2026-01-11")).toBe("2026-01-05");
    expect(weeklySummary(settings, records, "2026-01-08", 2)).toEqual([
      {
        monday: "2025-12-29",
        strength: { done: 0, planned: 0 },
        runs: { done: 0, planned: 0 },
      },
      {
        monday: "2026-01-05",
        strength: { done: 1, planned: 3 },
        runs: { done: 1, planned: 2 },
      },
    ]);
  });
  test("weekly progress counts separate sessions recorded on the same day", () => {
    const records: RecordEntry[] = [
      entry(completedWorkout("2026-01-05")),
      entry(completedWorkout("2026-01-05", 1)),
      entry({
        kind: "run",
        date: "2026-01-06",
        minutes: 20,
        distanceKm: 3,
        notes: "Morning",
      }),
      entry({
        kind: "run",
        date: "2026-01-06",
        minutes: 15,
        distanceKm: 2,
        notes: "Evening",
      }),
    ];
    expect(weeklySummary(settings, records, "2026-01-08", 1)[0]).toEqual({
      monday: "2026-01-05",
      strength: { done: 2, planned: 3 },
      runs: { done: 2, planned: 2 },
    });
  });
  test("strength series keep exercise variants apart and use the weaker side", () => {
    const first = completedWorkout("2026-01-05", 0, 8);
    const later = completedWorkout("2026-01-07", 0, 10);
    const row = later.exercises.find((e) => e.prescription.id === "row");
    const set = row?.sets[0];
    if (!set) throw new Error("Missing row");
    set.right = 9;
    // A plank logged as reps after a settings change is a separate variant.
    const variant = structuredClone(later);
    variant.date = "2026-01-09";
    variant.finishedAt = "2026-01-09T07:45:00.000Z";
    for (const exercise of variant.exercises)
      if (exercise.prescription.id === "plank")
        exercise.prescription.mode = "reps";
    const series = strengthSeries([entry(variant), entry(later), entry(first)]);
    const rows = series.find((s) => s.key === "row:reps:sides");
    expect(rows?.points.map((p) => [p.date, p.loadKg, p.value])).toEqual([
      ["2026-01-05", 8, 15],
      ["2026-01-07", 10, 15],
      ["2026-01-09", 10, 15],
    ]);
    const timed = series.find((s) => s.key === "plank:seconds:single");
    const counted = series.find((s) => s.key === "plank:reps:single");
    expect(timed?.points).toHaveLength(2);
    expect(counted?.points).toHaveLength(1);
    // At equal loads the set with more reps on its weaker side counts.
    expect(
      strengthSeries([entry(later)]).find((s) => s.key === "row:reps:sides")
        ?.points[0]?.value,
    ).toBe(15);
    // A heavier set counts, with the reps of its weaker side.
    set.loadKg = 12;
    expect(
      strengthSeries([entry(later)]).find((s) => s.key === "row:reps:sides")
        ?.points[0],
    ).toEqual({ date: "2026-01-07", loadKg: 12, value: 9 });
  });
  test("bodyweight compares averages only with earlier weigh-ins", () => {
    const weights = (count: number) =>
      dailyWeights(
        Array.from({ length: count }, (_, i) =>
          entry({ kind: "weight", date: addDays("2026-01-01", i), kg: 70 + i }),
        ),
      );
    expect(weightTrend([])).toEqual({
      average: null,
      count: 0,
      change: null,
      comparedCount: 0,
    });
    expect(weightTrend(weights(3))).toMatchObject({
      average: 71,
      change: null,
    });
    // Latest 7: 73..79 (avg 76). The 3 before: 70..72 (avg 71).
    expect(weightTrend(weights(10))).toEqual({
      average: 76,
      count: 7,
      change: 5,
      comparedCount: 3,
    });
  });
});

describe("manual day reorganisation", () => {
  test("moves into rest and preserves A/B identity in this and later weeks", () => {
    const settings = defaultSettings("2026-01-05", "UTC");
    const next = reorganiseDays(
      settings,
      "2026-01-05",
      "2026-01-08",
      "2026-01-05",
      [],
    );
    expect(scheduled(next, "2026-01-05").type).toBe("rest");
    expect(scheduled(next, "2026-01-08").routine?.id).toBe(
      scheduled(settings, "2026-01-05").routine?.id,
    );
    expect(scheduled(next, "2026-01-07").routine?.id).toBe(
      scheduled(settings, "2026-01-07").routine?.id,
    );
    expect(scheduled(next, "2026-01-12")).toEqual(
      scheduled(settings, "2026-01-12"),
    );
    expect(next.schedule).toEqual(settings.schedule);
    expect(settings.dayPlans).toEqual({});
  });
  test("swaps a run and a strength day without changing their count", () => {
    const settings = defaultSettings("2026-01-05", "UTC");
    const next = reorganiseDays(
      settings,
      "2026-01-05",
      "2026-01-06",
      "2026-01-05",
      [],
    );
    expect(scheduled(next, "2026-01-05").type).toBe("run");
    expect(scheduled(next, "2026-01-06").type).toBe("strength");
    const back = reorganiseDays(
      next,
      "2026-01-06",
      "2026-01-05",
      "2026-01-05",
      [],
    );
    expect(scheduled(back, "2026-01-05")).toEqual(
      scheduled(settings, "2026-01-05"),
    );
  });
  test("rejects past, other-week and started activity moves", () => {
    const settings = defaultSettings("2026-01-05", "UTC");
    expect(() =>
      reorganiseDays(settings, "2026-01-05", "2026-01-06", "2026-01-06", []),
    ).toThrow("upcoming");
    expect(() =>
      reorganiseDays(settings, "2026-01-05", "2026-01-12", "2026-01-05", []),
    ).toThrow("same week");
    const routine = settings.routines[0];
    if (!routine) throw Error("Missing fixture routine");
    const record = {
      id: crypto.randomUUID(),
      revision: 1,
      updatedAt: new Date().toISOString(),
      data: createWorkout(settings, routine, "2026-01-05", false, []),
    };
    expect(() =>
      reorganiseDays(settings, "2026-01-05", "2026-01-06", "2026-01-05", [
        record,
      ]),
    ).toThrow("started");
  });
  test("old settings parse with empty dated plans and malformed overrides fail", () => {
    const settings = defaultSettings("2026-01-05", "UTC");
    const { dayPlans, ...legacy } = settings;
    expect(settingsSchema.parse(legacy).dayPlans).toBeUndefined();
    expect(dayPlans).toEqual({});
    expect(JSON.stringify(settingsSchema.parse(legacy))).not.toContain(
      "dayPlans",
    );
    expect(
      settingsSchema.safeParse({
        ...settings,
        dayPlans: { oops: { type: "rest", routine: null } },
      }).success,
    ).toBe(false);
  });
});
