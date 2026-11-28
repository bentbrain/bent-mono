import { expect, test } from "bun:test";
import {
  createWorkout,
  defaultSettings,
  loadNote,
  loadWording,
  progression,
  setResult,
} from "../src/domain";
import type { Exercise, RecordEntry, Workout } from "../src/domain";
import { strengthSeries } from "../src/progress";

const custom = (load: Exercise["load"], mode: Exercise["mode"] = "reps") =>
  ({
    id: `custom-${load ?? "none"}`,
    name: "Custom",
    sets: 3,
    min: 8,
    max: 12,
    mode,
    side: false,
    rest: 90,
    ...(load ? { load } : {}),
  }) satisfies Exercise;

test("each load type reads its own way", () => {
  expect(loadWording(custom(undefined), "kg")).toEqual({
    weighed: true,
    heading: "kg / dumbbell",
    unit: "kg per dumbbell",
    note: "Weight is for one dumbbell.",
    tag: "Per dumbbell",
  });
  expect(loadWording(custom("barbell"), "lb")).toMatchObject({
    weighed: true,
    heading: "lb on bar",
    unit: "lb on the bar",
    tag: "Whole bar",
  });
  expect(loadWording(custom("machine"), "kg").unit).toBe("kg on the stack");
  expect(loadWording(custom("kettlebell"), "kg").heading).toBe(
    "kg / kettlebell",
  );
  expect(loadWording(custom("bodyweight"), "kg").heading).toBe("Added kg");
  // Bands and timed sets record no weight.
  expect(loadWording(custom("band"), "kg").weighed).toBe(false);
  expect(loadWording(custom("barbell", "seconds"), "kg").weighed).toBe(false);
  // Catalogue exercises take their own load type.
  const squat = { id: "squat", mode: "reps" as const };
  expect(loadWording(squat, "kg").tag).toBe("Per dumbbell");
});

test("a routine's weight note is shared only when every weight reads alike", () => {
  const settings = defaultSettings("2026-11-02", "UTC");
  const routine = settings.routines[0]?.exercises ?? [];
  expect(loadNote(routine, "kg")).toBe("Weight is for one dumbbell.");
  expect(loadNote([...routine, custom("barbell")], "kg")).toBe(
    "Each exercise shows how its weight is measured.",
  );
  expect(loadNote([custom("band"), custom("barbell", "seconds")], "kg")).toBe(
    "",
  );
});

test("band sets show reps without a weight", () => {
  const set = {
    loadKg: 0,
    value: 12,
    right: null,
    done: true,
    skipped: false,
    rir: 2,
    controlled: true,
  };
  expect(setResult(set, custom("band"), "kg")).toBe("12 reps");
  expect(setResult({ ...set, loadKg: 20 }, custom("barbell"), "kg")).toBe(
    "20 kg × 12 reps",
  );
});

test("strength series carry their load type and keep untyped keys", () => {
  const settings = defaultSettings("2026-11-02", "UTC");
  const routine = settings.routines[0];
  if (!routine) throw new Error("Expected a routine.");
  const records: RecordEntry[] = [
    routine,
    { ...routine, exercises: [custom("barbell")] },
  ].map((r, index) => {
    const workout: Workout = createWorkout(
      settings,
      r,
      "2026-11-02",
      false,
      [],
    );
    workout.finishedAt = `2026-11-02T0${index + 1}:00:00.000Z`;
    for (const exercise of workout.exercises)
      for (const set of exercise.sets)
        Object.assign(set, { done: true, value: 10 });
    return {
      id: crypto.randomUUID(),
      revision: 1,
      updatedAt: workout.finishedAt,
      data: workout,
    };
  });
  const series = strengthSeries(records);
  expect(series.find((s) => s.key === "squat:reps:single")?.load).toBe(
    "dumbbell",
  );
  expect(
    series.find((s) => s.key === "custom-barbell:reps:single:barbell")?.load,
  ).toBe("barbell");
});

const done = (value: number, loadKg = 0) => ({
  loadKg,
  value,
  right: null,
  done: true,
  skipped: false,
  rir: 2,
  controlled: true,
});
const previous = (exercise: Exercise, sets: ReturnType<typeof done>[]) => ({
  prescription: exercise,
  sets,
});

test("band progression ignores stored weight and starts sets at zero", () => {
  const band = custom("band");
  const top = progression(
    band,
    previous(band, [done(12, 2), done(12, 0), done(12, 0)]),
    {
      dumbbellsKg: [],
    },
  );
  expect(top).toEqual({
    text: "Top of range reached. Use a stronger band and return to 8 reps.",
    loadKg: 0,
  });
  expect(
    progression(band, previous(band, [done(10, 4), done(9, 4), done(9, 4)]), {
      dumbbellsKg: [],
    }),
  ).toEqual({
    text: "Repeat this band and build controlled reps within the range.",
    loadKg: 0,
  });
});

test("band charts rank by reps, and naming the implicit load type keeps the chart", () => {
  const settings = defaultSettings("2026-11-02", "UTC");
  const routine = settings.routines[0];
  if (!routine) throw new Error("Expected a routine.");
  const session = (
    exercise: Exercise,
    sets: ReturnType<typeof done>[],
    hour: number,
  ) => {
    const workout = createWorkout(
      settings,
      { ...routine, exercises: [exercise] },
      "2026-11-02",
      false,
      [],
    );
    workout.finishedAt = `2026-11-02T0${hour}:00:00.000Z`;
    workout.exercises[0]!.sets = sets;
    return {
      id: crypto.randomUUID(),
      revision: 1,
      updatedAt: workout.finishedAt,
      data: workout,
    } satisfies RecordEntry;
  };
  const band = custom("band");
  const [bandSeries] = strengthSeries([
    session(band, [done(12, 0), done(8, 4)], 1),
  ]);
  expect(bandSeries?.points).toEqual([
    { date: "2026-11-02", loadKg: 0, value: 12 },
  ]);
  const press = { ...custom(undefined), id: "custom-press" };
  const series = strengthSeries([
    session(press, [done(10, 10)], 1),
    session({ ...press, load: "dumbbell" }, [done(10, 12)], 2),
  ]);
  expect(series.map((s) => [s.key, s.points.length])).toEqual([
    ["custom-press:reps:single", 2],
  ]);
});
