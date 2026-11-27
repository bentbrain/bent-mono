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
import { appContract, requestContract, ApiError } from "../src/index";
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
  test("keeps the message of an error code this build does not know", () => {
    expect(ApiError.parse({ error: "Update", code: "future_code" })).toEqual({
      error: "Update",
      code: undefined,
    });
  });
});
