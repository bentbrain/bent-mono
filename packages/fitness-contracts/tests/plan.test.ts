import { describe, expect, test } from "bun:test";
import { catalogue, catalogueEntry, missingEquipment } from "../src/catalogue";
import {
  createWorkout,
  defaultSettings,
  exercises,
  loadTypeOf,
  progression,
  settingsSchema,
} from "../src/domain";
import type { Exercise, Settings, Workout } from "../src/domain";
import { guides } from "../src/guides";
import {
  appContract,
  requestContract,
  requiredContract,
  ApiError,
} from "../src/index";
import { checkPlan } from "../src/plan";

const base = () => defaultSettings("2026-11-30", "Australia/Brisbane");

function completed(prescription: Exercise, loadKg: number) {
  return {
    prescription,
    sets: Array.from({ length: prescription.sets }, () => ({
      loadKg,
      value: prescription.max,
      right: prescription.side ? prescription.max : null,
      done: true,
      skipped: false,
      rir: 2,
      controlled: true,
    })),
  } satisfies Workout["exercises"][number];
}

describe("exercise catalogue", () => {
  test("has one entry per id, a guide for each and valid defaults", () => {
    const ids = catalogue.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of catalogue) {
      expect(guides.some((guide) => guide.id === item.id)).toBe(true);
      expect(item.max).toBeGreaterThanOrEqual(item.min);
    }
  });
  test("keeps catalogue prescriptions free of load types", () => {
    // Load types come from the catalogue, so plans built from it stay
    // readable by app builds that predate them.
    expect(exercises.every((item) => !("load" in item))).toBe(true);
    const settings = base();
    expect(
      settings.routines.every((routine) =>
        routine.exercises.every((item) => item.load === undefined),
      ),
    ).toBe(true);
    expect(Object.keys(settings)).not.toContain("availableEquipment");
  });
  test("reads each exercise's load type", () => {
    expect(loadTypeOf({ id: "bench" })).toBe("dumbbell");
    expect(loadTypeOf({ id: "plank" })).toBe("bodyweight");
    expect(loadTypeOf({ id: "custom-sled", load: "machine" })).toBe("machine");
    expect(loadTypeOf({ id: "custom-unknown" })).toBe("dumbbell");
    // The catalogue decides for its own exercises.
    expect(loadTypeOf({ id: "squat", load: "barbell" })).toBe("dumbbell");
  });
  test("counts an adjustable bench as a flat bench", () => {
    const bench = catalogueEntry("bench");
    if (!bench) throw new Error("Missing bench");
    expect(missingEquipment(bench, ["dumbbells", "adjustable-bench"])).toEqual(
      [],
    );
    expect(missingEquipment(bench, ["dumbbells"])).toEqual(["flat-bench"]);
  });
});

describe("settings profile", () => {
  test("accepts the planning profile and refuses repeated equipment", () => {
    const settings = {
      ...base(),
      experience: "returning",
      sessionMinutes: 45,
      limitations: "Sore left shoulder overhead",
      availableEquipment: ["barbell", "squat-rack", "flat-bench"],
      kettlebellsKg: [12, 16],
      incrementsKg: { barbell: 5 },
    };
    expect(settingsSchema.safeParse(settings).success).toBe(true);
    expect(
      settingsSchema.safeParse({
        ...settings,
        availableEquipment: ["barbell", "barbell"],
      }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ ...settings, availableEquipment: ["sled"] })
        .success,
    ).toBe(false);
  });
});

describe("progression by load type", () => {
  const prescription = (id: string, load?: Exercise["load"]): Exercise => ({
    id,
    name: id,
    sets: 3,
    min: 8,
    max: 12,
    mode: "reps",
    side: false,
    rest: 120,
    ...(load ? { load } : {}),
  });
  test("adds the account's increment to barbell, machine and cable loads", () => {
    const p = prescription("custom-squat", "barbell");
    expect(progression(p, completed(p, 60), { dumbbellsKg: [] }).loadKg).toBe(
      62.5,
    );
    expect(
      progression(p, completed(p, 60), {
        dumbbellsKg: [],
        incrementsKg: { barbell: 5 },
      }).loadKg,
    ).toBe(65);
    const cable = prescription("custom-pushdown", "cable");
    expect(
      progression(cable, completed(cable, 20), { dumbbellsKg: [] }).loadKg,
    ).toBe(22.5);
  });
  test("uses kettlebell sizes and leaves bodyweight and band loads", () => {
    const bell = prescription("custom-swing", "kettlebell");
    expect(
      progression(bell, completed(bell, 16), {
        dumbbellsKg: [20],
        kettlebellsKg: [16, 24],
      }).loadKg,
    ).toBe(24);
    const dip = prescription("custom-dip", "bodyweight");
    const advice = progression(dip, completed(dip, 0), { dumbbellsKg: [] });
    expect(advice.loadKg).toBe(0);
    expect(advice.text).toContain("harder variation");
    const band = prescription("custom-pull-apart", "band");
    expect(
      progression(band, completed(band, 0), { dumbbellsKg: [] }).text,
    ).toContain("stronger band");
  });
  test("starts timed exercises at no weight, as the logger records none", () => {
    const hold: Exercise = {
      ...prescription("custom-hold", "dumbbell"),
      mode: "seconds",
      min: 20,
      max: 40,
    };
    const reps = { ...hold, mode: "reps" as const, max: 12 };
    // Recorded in reps with a weight, then changed to seconds.
    expect(
      progression(hold, completed(reps, 12), { dumbbellsKg: [14] }).loadKg,
    ).toBe(0);
  });
  test("starts afresh when history recorded the weight another way", () => {
    const machine = prescription("custom-press", "machine");
    const dumbbell = prescription("custom-press", "dumbbell");
    const advice = progression(dumbbell, completed(machine, 25), {
      dumbbellsKg: [30],
    });
    expect(advice.loadKg).toBeNull();
    expect(advice.text).toContain("Start light");
  });
  test("keeps suggestions within the heaviest load a set records", () => {
    const p = prescription("custom-sled", "machine");
    const advice = progression(p, completed(p, 998), { dumbbellsKg: [] });
    expect(advice.loadKg).toBe(998);
    expect(advice.text).toContain("heaviest load");
  });
  test("keeps the load until every set reaches the top of the range", () => {
    const p = prescription("custom-squat", "barbell");
    const short = completed(p, 60);
    short.sets[0] = { ...short.sets[0]!, value: 10 };
    expect(progression(p, short, { dumbbellsKg: [] }).loadKg).toBe(60);
  });
});

describe("plan check", () => {
  test("accepts the default plan", () => {
    const result = checkPlan(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual([]);
  });
  test("reports schema problems with their paths", () => {
    const result = checkPlan({ ...base(), calories: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe("calories");
  });
  test("refuses exercises outside the catalogue unless the account defines them", () => {
    const settings = base();
    const routine = settings.routines[0]!;
    const sled: Exercise = {
      id: "custom-sled",
      name: "Sled push",
      sets: 3,
      min: 20,
      max: 30,
      mode: "seconds",
      side: false,
      rest: 120,
      load: "machine",
    };
    const plan: Settings = {
      ...settings,
      routines: [
        { ...routine, exercises: [...routine.exercises, sled] },
        ...settings.routines.slice(1),
      ],
    };
    const refused = checkPlan(plan);
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.errors[0]?.message).toContain(
        "not in the exercise catalogue",
      );
    expect(
      checkPlan(plan, [
        { id: "custom-sled", mode: "seconds", side: false, load: "machine" },
      ]).ok,
    ).toBe(true);
  });
  test("refuses a prescription that records differently from its catalogue entry", () => {
    const settings = base();
    const routine = settings.routines[0]!;
    const result = checkPlan({
      ...settings,
      routines: [
        {
          ...routine,
          exercises: routine.exercises.map((item) =>
            item.id === "row" ? { ...item, side: false } : item,
          ),
        },
        ...settings.routines.slice(1),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]?.message).toContain("for each side");
  });
  test("refuses load types that differ from the catalogue or the account's definition", () => {
    const settings = base();
    const routine = settings.routines[0]!;
    const withExercises = (exercises: Exercise[]) => ({
      ...settings,
      routines: [{ ...routine, exercises }, ...settings.routines.slice(1)],
    });
    const squat = routine.exercises[0]!;
    const explicit = checkPlan(withExercises([{ ...squat, load: "dumbbell" }]));
    expect(explicit.ok).toBe(false);
    if (!explicit.ok)
      expect(explicit.errors[0]?.message).toContain("catalogue sets it");
    const deadlift: Exercise = {
      id: "custom-deadlift",
      name: "Trap bar deadlift",
      sets: 3,
      min: 5,
      max: 8,
      mode: "reps",
      side: false,
      rest: 180,
    };
    const defined = [
      {
        id: "custom-deadlift",
        mode: "reps" as const,
        side: false,
        load: "barbell" as const,
      },
    ];
    expect(checkPlan(withExercises([deadlift]), defined).ok).toBe(false);
    expect(
      checkPlan(withExercises([{ ...deadlift, load: "barbell" }]), defined).ok,
    ).toBe(true);
  });
  test("checks dated strength routines", () => {
    const settings = base();
    const routine = settings.routines[0]!;
    const result = checkPlan({
      ...settings,
      dayPlans: {
        "2026-11-28": {
          type: "strength",
          routine: {
            ...routine,
            exercises: [{ ...routine.exercises[0]!, id: "mystery" }],
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]?.path).toBe(
        "dayPlans.2026-11-28.routine.exercises.0.id",
      );
  });
  test("refuses rep ranges that are not whole numbers", () => {
    const settings = base();
    const routine = settings.routines[0]!;
    const result = checkPlan({
      ...settings,
      routines: [
        {
          ...routine,
          exercises: [{ ...routine.exercises[0]!, min: 8.5 }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]?.message).toContain("whole numbers");
  });
  test("warns about missing equipment, long sessions and empty weeks", () => {
    const result = checkPlan({
      ...base(),
      availableEquipment: ["dumbbells"],
      sessionMinutes: 20,
      schedule: ["run", "rest", "rest", "rest", "rest", "run", "rest"],
    });
    expect(result.ok).toBe(true);
    const messages = result.warnings.map((warning) => warning.message);
    expect(messages.some((m) => m.includes("needs flat bench"))).toBe(true);
    expect(messages.some((m) => m.includes("longer than the 20"))).toBe(true);
    expect(messages).toContain("The repeating week has no strength days.");
  });
  test("keeps workouts created from checked plans valid", () => {
    const result = checkPlan(base());
    if (!result.ok) throw new Error("Expected a valid plan");
    const routine = result.settings.routines[0]!;
    expect(() =>
      createWorkout(result.settings, routine, "2026-11-30", false, []),
    ).not.toThrow();
  });
});

describe("app contract", () => {
  test("reads the declared contract and treats a missing one as 1", () => {
    expect(appContract).toBeGreaterThanOrEqual(2);
    expect(requestContract(null)).toBe(1);
    expect(requestContract("2")).toBe(2);
    expect(requestContract("two")).toBe(1);
    expect(requestContract("-3")).toBe(1);
  });
  test("names the oldest contract that can read a record", () => {
    const settings = base();
    expect(requiredContract(settings)).toBe(1);
    expect(requiredContract({ ...settings, sessionMinutes: 45 })).toBe(2);
    const routine = settings.routines[0]!;
    const loaded = {
      ...routine,
      exercises: [{ ...routine.exercises[0]!, load: "barbell" as const }],
    };
    expect(requiredContract({ ...settings, routines: [loaded] })).toBe(2);
    expect(
      requiredContract({
        ...settings,
        dayPlans: { "2026-12-01": { type: "strength", routine: loaded } },
      }),
    ).toBe(2);
    const workout = createWorkout(settings, routine, "2026-11-30", false, []);
    expect(requiredContract(workout)).toBe(1);
    const first = workout.exercises[0]!;
    expect(
      requiredContract({
        ...workout,
        exercises: [
          {
            ...first,
            prescription: { ...first.prescription, load: "barbell" },
          },
        ],
      }),
    ).toBe(2);
  });
  test("keeps the message of an error code this build does not know", () => {
    expect(ApiError.parse({ error: "Update", code: "future_code" })).toEqual({
      error: "Update",
      code: undefined,
    });
  });
});
