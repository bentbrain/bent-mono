import { describe, expect, test } from "bun:test";
import { createWorkout, defaultSettings, lastExercise, progression, workoutSchema } from "@bent/fitness-contracts/domain";
import type { RecordEntry, Workout } from "@bent/fitness-contracts/domain";
import { elapsedSeconds, formatDuration, remainingRest } from "@bent/fitness-contracts/timing";
import {
  WorkoutInputStore,
  applyText,
  fieldKey,
  forgetWorkoutInputs,
  holdInBackground,
  migrateLegacy,
  planCommit,
  savedBase,
  savedText,
  setInputs,
  setKeys,
  shownText,
  unconfirmedKeys,
  workoutInputKeys,
} from "../src/screens/week/workout/inputs";
import type { DraftBackend } from "../src/screens/week/workout/inputs";
import {
  applySetChange,
  currentExercise,
  finishChange,
  progressText,
  restAnnouncement,
  restChoices,
  restDoneShowing,
  restNoticeSeconds,
  sessionProgress,
  suggestedRest,
} from "../src/screens/week/workout/session";

const settings = defaultSettings("2026-01-05", "UTC");
function template() {
  const routine = settings.routines[0];
  if (!routine) throw new Error("Missing template");
  return routine;
}
const fresh = () => createWorkout(settings, template(), "2026-01-05", false, []);

function completedWorkout(date: string, load = 10) {
  const workout = createWorkout(settings, template(), date, false, []);
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
const entry = (data: RecordEntry["data"], id = crypto.randomUUID()): RecordEntry => ({
  id,
  revision: 1,
  updatedAt: "2026-01-05T08:00:00.000Z",
  data,
});

/** An in-memory drafts table, standing in for the iPhone's SQLite drafts. */
function memoryBackend() {
  const rows = new Map<string, string>();
  const backend: DraftBackend & { rows: Map<string, string>; failing: boolean } = {
    rows,
    failing: false,
    get: (key) => rows.get(key) ?? null,
    set: (key, value) => {
      if (backend.failing) throw new Error("disk full");
      rows.set(key, value);
    },
    remove: (key) => {
      if (backend.failing) throw new Error("disk full");
      rows.delete(key);
    },
  };
  return backend;
}

/** Marks every set handled with valid results, as a finished session would be. */
function handleEverySet(workout: Workout): Workout {
  return {
    ...workout,
    exercises: workout.exercises.map((exercise) => ({
      ...exercise,
      sets: exercise.sets.map((set, i) =>
        i === 0
          ? { ...set, done: false, skipped: true }
          : { ...set, done: true, value: exercise.prescription.max, right: exercise.prescription.side ? exercise.prescription.max : null },
      ),
    })),
  };
}

describe("typed workout values", () => {
  const workout = fresh();
  test("valid text updates only its own field", () => {
    const next = applyText(workout, "0:1:value", "12", "kg");
    if (!next || typeof next === "string") throw new Error("Expected update");
    expect(next.exercises[0]?.sets[1]?.value).toBe(12);
    expect(next.exercises[0]?.sets[0]?.value).toBe(workout.exercises[0]?.sets[0]?.value);
    const pounds = applyText(workout, "0:0:loadKg", "22.05", "lb");
    if (!pounds || typeof pounds === "string") throw new Error("Expected update");
    expect(pounds.exercises[0]?.sets[0]?.loadKg).toBeCloseTo(10, 1);
    expect(savedText(pounds, "0:0:loadKg", "lb")).toBe("22.05");
  });
  test("empty, partial and out-of-range text is kept as an error", () => {
    expect(applyText(workout, "0:0:value", "", "kg")).toBe("Enter reps as a number of 0 or more.");
    expect(applyText(workout, "0:0:value", "9.5", "kg")).toBe("Enter reps as a whole number.");
    expect(applyText(workout, "0:0:value", "601", "kg")).toBe("Enter reps up to 600.");
    expect(applyText(workout, "0:0:rir", "11", "kg")).toBe("Enter reps left as a whole number from 0 to 10.");
    expect(applyText(workout, "0:0:loadKg", "-1", "kg")).toBe("Enter weight as a number of 0 or more.");
    expect(applyText(workout, "0:0:loadKg", "1001", "kg")).toBe("Enter a weight up to 1000 kg.");
    expect(applyText(workout, "40:0:value", "9", "kg")).toBeNull();
  });
  test("notes keep up to 2000 characters", () => {
    const next = applyText(workout, "notes", "x".repeat(2100), "kg");
    if (!next || typeof next === "string") throw new Error("Expected update");
    expect(next.notes).toHaveLength(2000);
    expect(savedText(next, "notes", "kg")).toHaveLength(2000);
  });
  test("recovered weights keep the units they were typed in", () => {
    const empty = applyText(workout, "0:0:loadKg", "0", "kg");
    if (!empty || typeof empty === "string") throw new Error("Expected update");
    expect(savedBase(empty, "0:0:loadKg")).toBe("0");
    const kilograms = { text: "10", base: "0", units: "kg" as const };
    expect(holdInBackground(empty, "0:0:loadKg", kilograms)).toBe(false);
    expect(shownText("0:0:loadKg", kilograms, "lb")).toBe("22.05");
    const fromKg = applyText(empty, "0:0:loadKg", kilograms.text, "kg");
    if (!fromKg || typeof fromKg === "string") throw new Error("Expected update");
    expect(fromKg.exercises[0]?.sets[0]?.loadKg).toBe(10);
    const pounds = { text: "22", base: "0", units: "lb" as const };
    expect(shownText("0:0:loadKg", pounds, "kg")).toBe("9.98");
    const fromLb = applyText(empty, "0:0:loadKg", pounds.text, "lb");
    if (!fromLb || typeof fromLb === "string") throw new Error("Expected update");
    expect(fromLb.exercises[0]?.sets[0]?.loadKg).toBeCloseTo(9.979, 3);
    expect(savedBase(fromLb, "0:0:loadKg")).toBe(String(fromLb.exercises[0]?.sets[0]?.loadKg));
    expect(holdInBackground(fromKg, "0:0:loadKg", kilograms)).toBe(true);
  });
  test("values kept without units hold weights for confirmation", () => {
    const migrated = migrateLegacy({ "0:0:loadKg": { text: "10", base: "0" }, "0:0:value": { text: "9", base: "8" } });
    expect(migrated["0:0:loadKg"]).toEqual({ text: "10", base: null, units: null });
    expect(migrated["0:0:value"]).toEqual({ text: "9", base: "8", units: null });
    const load = migrated["0:0:loadKg"];
    if (!load) throw new Error("Expected weight");
    expect(holdInBackground(workout, "0:0:loadKg", load)).toBe(true);
    expect(shownText("0:0:loadKg", load, "lb")).toBe("10");
    expect(unconfirmedKeys(migrated)).toEqual(["0:0:loadKg"]);
  });
  test("set keys cover each number field of a set", () => {
    expect(setKeys(1, 2)).toEqual(["1:2:loadKg", "1:2:value", "1:2:right", "1:2:rir"]);
    expect(fieldKey(0, 3, "rir")).toBe("0:3:rir");
  });
  test("set rows show the inputs each exercise records", () => {
    const base = workout.exercises[0]?.prescription;
    if (!base) throw new Error("Missing exercise");
    expect(setInputs({ ...base, mode: "reps", side: false }, "lb").map((i) => i.heading)).toEqual(["lb / dumbbell", "Reps", "Reps left"]);
    expect(setInputs({ ...base, mode: "reps", side: true }, "kg").map((i) => i.heading)).toEqual([
      "kg / dumbbell",
      "Left reps",
      "Right reps",
      "Reps left",
    ]);
    const hold = setInputs({ ...base, mode: "seconds", side: true }, "kg");
    expect(hold.map((i) => i.heading)).toEqual(["Left seconds", "Right seconds"]);
    expect(hold.map((i) => i.spoken)).toEqual(["seconds", "right seconds"]);
    expect(hold.every((i) => !i.integer)).toBe(true);
    expect(setInputs({ ...base, mode: "reps", side: false }, "kg").map((i) => i.integer)).toEqual([false, true, true]);
  });
});

describe("saving typed values", () => {
  test("leaving a set saves its valid values and keeps other sets typed", () => {
    const workout = fresh();
    const buffer = {
      "0:0:value": { text: "9", base: "0", units: "kg" as const },
      "0:1:value": { text: "7", base: "0", units: "kg" as const },
    };
    const plan = planCommit(workout, buffer, "kg", { keys: setKeys(0, 0), place: "0:0" });
    if (plan.status !== "ready") throw new Error("Expected a save");
    expect(plan.changed).toBe(true);
    expect(plan.done).toEqual(["0:0:value"]);
    expect(plan.workout.exercises[0]?.sets[0]?.value).toBe(9);
    expect(plan.workout.exercises[0]?.sets[1]?.value).toBe(workout.exercises[0]?.sets[1]?.value);
  });
  test("invalid text blocks the save and reports the field", () => {
    const plan = planCommit(fresh(), { "0:0:value": { text: "9.5", base: "0", units: "kg" } }, "kg", { keys: setKeys(0, 0) });
    expect(plan).toMatchObject({ status: "invalid", failed: { "0:0:value": "Enter reps as a whole number." } });
  });
  test("Skip drops invalid text in the set and saves the skip", () => {
    const plan = planCommit(fresh(), { "0:0:value": { text: "", base: "0", units: "kg" } }, "kg", {
      keys: setKeys(0, 0),
      dropInvalid: true,
      change: (w) => applySetChange(w, 0, 0, { skipped: true, done: false }, { startRest: true, now: 0 }),
    });
    if (plan.status !== "ready") throw new Error("Expected a save");
    expect(plan.done).toEqual(["0:0:value"]);
    expect(plan.workout.exercises[0]?.sets[0]?.skipped).toBe(true);
    expect(plan.workout.restUntil).toBeNull();
  });
  test("a weight typed in another unit saves in the unit it was typed in", () => {
    const plan = planCommit(fresh(), { "0:0:loadKg": { text: "22.05", base: "0", units: "lb" } }, "kg");
    if (plan.status !== "ready") throw new Error("Expected a save");
    expect(plan.workout.exercises[0]?.sets[0]?.loadKg).toBeCloseTo(10, 1);
  });
  test("background saves keep values changed elsewhere and values without units", () => {
    const workout = fresh();
    const plan = planCommit(
      workout,
      {
        "0:0:value": { text: "9", base: savedBase(workout, "0:0:value") ?? "", units: "kg" },
        "0:1:value": { text: "7", base: "999", units: "kg" },
        "0:2:loadKg": { text: "10", base: null, units: null },
        "1:0:value": { text: "x", base: savedBase(workout, "1:0:value") ?? "", units: "kg" },
      },
      "kg",
      { background: true },
    );
    if (plan.status !== "ready") throw new Error("Expected a save");
    expect(plan.done).toEqual(["0:0:value"]);
    expect(plan.kept).toEqual(["0:1:value", "0:2:loadKg"]);
    expect(Object.keys(plan.failed)).toEqual(["1:0:value"]);
  });
  test("a save that breaks a workout rule is rejected with its message", () => {
    const workout = fresh();
    const plan = planCommit(workout, {}, "kg", {
      change: (w) => applySetChange({ ...w, exercises: w.exercises.map((e) => ({ ...e, sets: e.sets.map((s) => ({ ...s, value: 0 })) })) }, 0, 0, { done: true }, { startRest: true, now: 0 }),
    });
    expect(plan).toMatchObject({ status: "rejected", message: "Enter a result for each completed set and both sides." });
  });
  test("an unchanged workout is not saved again", () => {
    const workout = fresh();
    const plan = planCommit(workout, {}, "kg", { keys: setKeys(0, 0) });
    expect(plan).toMatchObject({ status: "ready", changed: false });
  });
});

describe("typed values kept on this iPhone", () => {
  test("values survive a restart and clear once saved", () => {
    const backend = memoryBackend();
    const store = new WorkoutInputStore(backend, "w1");
    expect(store.buffer).toEqual({});
    store.write({ "0:0:value": { text: "9", base: "0", units: "kg" } });
    const reopened = new WorkoutInputStore(backend, "w1");
    expect(reopened.buffer).toEqual({ "0:0:value": { text: "9", base: "0", units: "kg" } });
    reopened.write({});
    expect(backend.rows.size).toBe(0);
  });
  test("each workout and earlier-format values have their own keys", () => {
    expect(workoutInputKeys("w1")).toEqual({ current: "workout-inputs:v2:w1", legacy: "workout-inputs:v1:w1" });
    const backend = memoryBackend();
    new WorkoutInputStore(backend, "w1").write({ notes: { text: "a", base: "", units: "kg" } });
    expect(new WorkoutInputStore(backend, "w2").buffer).toEqual({});
  });
  test("earlier-format values move to the current key on the next write", () => {
    const backend = memoryBackend();
    backend.rows.set("workout-inputs:v1:w1", JSON.stringify({ "0:0:loadKg": { text: "10", base: "0" } }));
    backend.rows.set("workout-inputs:v2:w1", JSON.stringify({ "0:0:value": { text: "9", base: "8", units: "kg" } }));
    const store = new WorkoutInputStore(backend, "w1");
    expect(store.buffer).toEqual({
      "0:0:loadKg": { text: "10", base: null, units: null },
      "0:0:value": { text: "9", base: "8", units: "kg" },
    });
    store.write(store.buffer);
    expect(backend.rows.has("workout-inputs:v1:w1")).toBe(false);
    expect(new WorkoutInputStore(backend, "w1").buffer["0:0:loadKg"]).toEqual({ text: "10", base: null, units: null });
  });
  test("unreadable entries are ignored", () => {
    const backend = memoryBackend();
    backend.rows.set("workout-inputs:v2:w1", "{not json");
    backend.rows.set("workout-inputs:v1:w1", JSON.stringify({ "0:0:value": { text: 5 } }));
    expect(new WorkoutInputStore(backend, "w1").buffer).toEqual({});
  });
  test("a refused write reports failure and keeps the earlier values", () => {
    const backend = memoryBackend();
    const store = new WorkoutInputStore(backend, "w1");
    store.write({ "0:0:value": { text: "9", base: "0", units: "kg" } });
    backend.failing = true;
    expect(() => store.write({ "0:0:value": { text: "10", base: "0", units: "kg" } })).toThrow();
    backend.failing = false;
    expect(new WorkoutInputStore(backend, "w1").buffer["0:0:value"]?.text).toBe("9");
  });
  test("discarding or finishing removes every kept value", () => {
    const backend = memoryBackend();
    backend.rows.set("workout-inputs:v1:w1", JSON.stringify({ "0:0:value": { text: "9", base: "8" } }));
    const store = new WorkoutInputStore(backend, "w1");
    store.write({ "0:1:value": { text: "7", base: "0", units: "kg" } });
    store.clear();
    expect(backend.rows.size).toBe(0);
    backend.rows.set("workout-inputs:v2:w2", "{}");
    backend.rows.set("workout-inputs:v1:w2", "{}");
    forgetWorkoutInputs(backend, "w2");
    expect(backend.rows.size).toBe(0);
  });
});

describe("skipped sets", () => {
  test("a workout can finish with skipped sets but not with unhandled sets", () => {
    const handled = handleEverySet(fresh());
    const finished = planCommit(handled, {}, "kg", { change: finishChange(new Date("2026-01-05T08:00:00.000Z")) });
    if (finished.status !== "ready") throw new Error("Expected a save");
    expect(finished.workout.finishedAt).toBe("2026-01-05T08:00:00.000Z");
    expect(finished.workout.restUntil).toBeNull();
    const open = planCommit(fresh(), {}, "kg", { change: finishChange(new Date()) });
    expect(open).toMatchObject({ status: "rejected", message: "Complete or skip every set before finishing." });
  });
  test("Done and Skip replace each other", () => {
    const workout = fresh();
    const done = applySetChange(workout, 0, 0, { done: true, skipped: false }, { startRest: false, now: 0 });
    const skipped = applySetChange(done, 0, 0, { skipped: true, done: false }, { startRest: false, now: 0 });
    expect(skipped.exercises[0]?.sets[0]).toMatchObject({ done: false, skipped: true });
  });
  test("skipped sets block a weight increase", () => {
    const workout = completedWorkout("2026-01-05", 10);
    const squat = workout.exercises.find((e) => e.prescription.id === "squat");
    if (!squat) throw new Error("Missing exercise");
    const skipped = { ...squat, sets: squat.sets.map((set, i) => (i === 0 ? { ...set, done: false, skipped: true, loadKg: 4 } : set)) };
    expect(progression(squat.prescription, skipped, { dumbbellsKg: [10, 12] }).loadKg).toBe(10);
  });
  test("last time ignores exercises that were skipped entirely", () => {
    const earlier = completedWorkout("2026-01-05", 8);
    const later = completedWorkout("2026-01-07", 10);
    for (const exercise of later.exercises)
      if (exercise.prescription.id === "squat") exercise.sets = exercise.sets.map((set) => ({ ...set, done: false, skipped: true }));
    expect(lastExercise([entry(earlier), entry(later)], "squat")?.sets[0]?.loadKg).toBe(8);
  });
  test("progress counts done and skipped sets and finds the next set", () => {
    const workout = fresh();
    const first = applySetChange(workout, 0, 0, { done: true }, { startRest: false, now: 0 });
    const second = applySetChange(first, 0, 1, { skipped: true }, { startRest: false, now: 0 });
    const progress = sessionProgress(second);
    expect(progress.completed).toBe(1);
    expect(progress.skipped).toBe(1);
    expect(progress.next).toEqual({ name: workout.exercises[0]?.prescription.name ?? "", index: 2 });
    expect(progressText(progress)).toBe(`1/${progress.total} sets done · 1 skipped`);
    expect(progressText({ total: 4, completed: 0, skipped: 0 })).toBe("0/4 sets done");
    const all = sessionProgress(handleEverySet(workout));
    expect(all.next).toBeUndefined();
    expect(all.fraction).toBe(1);
    expect(currentExercise(handleEverySet(workout))).toBe(-1);
  });
});

describe("session and rest timers", () => {
  test("timers use saved deadlines across navigation and restarts", () => {
    const start = "2026-01-05T08:00:00.000Z";
    const now = Date.parse(start);
    expect(elapsedSeconds(start, now + 7200500)).toBe(7200);
    expect(elapsedSeconds(start, now - 1000)).toBe(0);
    expect(remainingRest(now + 120000, now + 1001)).toBe(119);
    expect(remainingRest(now + 120000, now + 121000)).toBe(0);
    expect(remainingRest(null, now)).toBe(0);
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3661)).toBe("1:01:01");
  });
  test("marking a set Done starts that exercise's rest once", () => {
    const workout = fresh();
    const rest = workout.exercises[0]?.prescription.rest ?? 0;
    const done = applySetChange(workout, 0, 0, { done: true, skipped: false }, { startRest: true, now: 1000 });
    expect(done.restUntil).toBe(1000 + rest * 1000);
    const again = applySetChange({ ...done, restUntil: 5 }, 0, 0, { done: true }, { startRest: true, now: 9000 });
    expect(again.restUntil).toBe(5);
    const controlled = applySetChange(workout, 0, 1, { controlled: true }, { startRest: true, now: 1000 });
    expect(controlled.restUntil).toBe(workout.restUntil);
    const corrections = applySetChange(workout, 0, 0, { done: true }, { startRest: false, now: 1000 });
    expect(corrections.restUntil).toBe(workout.restUntil);
  });
  test("rest choices include common lengths and every prescribed rest", () => {
    const workout = fresh();
    const choices = restChoices(workout);
    expect(choices).toEqual([...choices].sort((a, b) => a - b));
    for (const seconds of [30, 60, 90, 120, 180, ...workout.exercises.map((e) => e.prescription.rest)])
      expect(choices).toContain(seconds);
    expect(new Set(choices).size).toBe(choices.length);
    expect(suggestedRest(workout)).toBe(workout.exercises[0]?.prescription.rest ?? 0);
    expect(suggestedRest(handleEverySet(workout))).toBe(workout.exercises.at(-1)?.prescription.rest ?? 0);
  });
  test("Rest done shows for ten minutes after the rest that ended", () => {
    expect(restDoneShowing(1000, 1000, 1000 + restNoticeSeconds * 1000 - 1)).toBe(true);
    expect(restDoneShowing(1000, 1000, 1000 + restNoticeSeconds * 1000)).toBe(false);
    expect(restDoneShowing(1000, 2000, 1500)).toBe(false);
    expect(restDoneShowing(null, null, 0)).toBe(false);
    expect(restAnnouncement({ name: "Goblet squat", index: 1 })).toBe("Rest done. Next: Goblet squat, set 2.");
    expect(restAnnouncement(undefined)).toBe("Rest done. Every set is handled.");
  });
});
