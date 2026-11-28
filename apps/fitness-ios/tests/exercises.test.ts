import { describe, expect, test } from "bun:test";
import { defaultSettings, exercises } from "@bent/fitness-contracts/domain";
import type { Exercise, RecordEntry, Routine, Workout } from "@bent/fitness-contracts/domain";
import {
  exerciseTags,
  lastResult,
  libraryOrder,
  measuredExercise,
  planEntries,
  routinesText,
  routinesWith,
  tutorialUrl,
} from "../src/screens/exercises/library";

const settings = defaultSettings("2026-01-05", "UTC");
const routines = settings.routines;
const base = (id: string) => {
  const exercise = exercises.find((item) => item.id === id);
  if (!exercise) throw new Error(`Unknown exercise ${id}`);
  return exercise;
};

function workout(
  id: string,
  finishedAt: string | null,
  prescription: Exercise,
  sets: Workout["exercises"][number]["sets"],
): RecordEntry {
  return {
    id,
    revision: 1,
    updatedAt: finishedAt ?? "2026-01-05T09:00:00.000Z",
    data: {
      kind: "workout",
      date: "2026-01-05",
      routineId: "00000000-0000-4000-8000-00000000000a",
      name: "Strength A",
      startedAt: "2026-01-05T09:00:00.000Z",
      finishedAt,
      exercises: [{ prescription, sets }],
      notes: "",
      restUntil: null,
    },
  };
}
const set = (loadKg: number, value: number, right: number | null = null, skipped = false) => ({
  loadKg,
  value,
  right,
  done: !skipped,
  skipped,
  rir: 2,
  controlled: true,
});

describe("library order", () => {
  test("lists routine exercises first, each once, then the rest", () => {
    expect(libraryOrder(routines).map((item) => item.id)).toEqual([
      "squat",
      "bench",
      "row",
      "rdl",
      "raise",
      "plank",
      "split",
      "incline",
      "press",
      "curl",
    ]);
  });

  test("follows a custom routine and skips exercises outside the library", () => {
    const custom: Routine[] = [
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        name: "Short",
        exercises: [
          { ...base("curl"), sets: 4 },
          { ...base("squat"), id: "custom-move", name: "Custom move" },
        ],
      },
    ];
    const order = libraryOrder(custom).map((item) => item.id);
    expect(order[0]).toBe("curl");
    expect(order).not.toContain("custom-move");
    expect(order).toHaveLength(exercises.length);
    expect(libraryOrder(custom)[0]?.sets).toBe(base("curl").sets);
  });

  test("shows every exercise when there are no routines", () => {
    expect(libraryOrder([]).map((item) => item.id)).toEqual(exercises.map((item) => item.id));
  });
});

describe("routines", () => {
  test("names the routines that include an exercise", () => {
    expect(routinesWith(routines, "row")).toEqual(["Strength A", "Strength B"]);
    expect(routinesWith(routines, "squat")).toEqual(["Strength A"]);
    expect(routinesWith([], "squat")).toEqual([]);
  });

  test("describe where an exercise is used", () => {
    expect(routinesText(["Strength A", "Strength B"])).toBe("In Strength A, Strength B");
    expect(routinesText([])).toBe("Not in your routines");
  });

  test("give each routine's prescription and prefer the first for recording", () => {
    const custom: Routine[] = [
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        name: "Heavy",
        exercises: [{ ...base("row"), sets: 5, min: 5, max: 8 }],
      },
      { id: "00000000-0000-4000-8000-0000000000c2", name: "Light", exercises: [base("row")] },
    ];
    expect(planEntries(custom, "row").map(({ routine, exercise }) => [routine, exercise.sets])).toEqual([
      ["Heavy", 5],
      ["Light", 3],
    ]);
    expect(measuredExercise(custom, "row")?.sets).toBe(5);
    expect(measuredExercise([], "plank")).toEqual(base("plank"));
    expect(measuredExercise(routines, "unknown")).toBeUndefined();
    expect(planEntries(routines, "curl")).toHaveLength(1);
  });
});

describe("last result", () => {
  test("is null before the exercise is recorded", () => {
    expect(lastResult([], "squat", "kg")).toBeNull();
    expect(
      lastResult([workout("00000000-0000-4000-8000-000000000101", null, base("squat"), [set(10, 8)])], "squat", "kg"),
    ).toBeNull();
  });

  test("uses the most recent finished workout and the shared set wording", () => {
    const records = [
      workout("00000000-0000-4000-8000-000000000101", "2026-01-05T10:00:00.000Z", base("squat"), [
        set(10, 8),
        set(10, 8),
        set(10, 7),
      ]),
      workout("00000000-0000-4000-8000-000000000102", "2026-01-07T10:00:00.000Z", base("squat"), [
        set(12, 9),
        set(12, 8),
        set(0, 0, null, true),
      ]),
    ];
    expect(lastResult(records, "squat", "kg")).toBe("12 kg × 9 reps · 12 kg × 8 reps · Skipped");
  });

  test("shows both sides and timed holds", () => {
    const row = workout("00000000-0000-4000-8000-000000000103", "2026-01-05T10:00:00.000Z", base("row"), [
      set(8, 10, 11),
      set(8, 10, 10),
      set(8, 9, 9),
    ]);
    expect(lastResult([row], "row", "kg")).toBe(
      "8 kg × 10 left / 11 right · 8 kg × 10 left / 10 right · 8 kg × 9 left / 9 right",
    );
    const plank = workout("00000000-0000-4000-8000-000000000104", "2026-01-05T10:00:00.000Z", base("plank"), [
      set(0, 30),
      set(0, 25),
    ]);
    expect(lastResult([plank], "plank", "kg")).toBe("30 seconds · 25 seconds");
  });
});

describe("tags and tutorial", () => {
  test("describe how an exercise is measured", () => {
    expect(exerciseTags(base("squat"))).toEqual(["Reps", "Per dumbbell"]);
    expect(exerciseTags(base("row"))).toEqual(["Reps", "Each side", "Per dumbbell"]);
    expect(exerciseTags(base("plank"))).toEqual(["Timed hold"]);
  });

  test("link to the YouTube tutorial", () => {
    expect(tutorialUrl("MeIiIdhvXT4")).toBe("https://www.youtube.com/watch?v=MeIiIdhvXT4");
  });
});
