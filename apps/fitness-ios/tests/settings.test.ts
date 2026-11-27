import { describe, expect, test } from "bun:test";
import { defaultSettings, settingsId, settingsSchema } from "@bent/fitness-contracts/domain";
import type { RecordEntry, Settings } from "@bent/fitness-contracts/domain";
import {
  addExercise,
  base64Bytes,
  base64Prefix,
  checkPhoto,
  checkSettings,
  describeIssue,
  exerciseChoices,
  formatDumbbells,
  move,
  newEquipment,
  newRoutine,
  numberText,
  parseDumbbells,
  parseNumberText,
  photoId,
  photoName,
  photoTypeOf,
  planSummary,
  queuedNotice,
  rotationPreview,
  saveStatus,
  settingsRevision,
  signOutMessage,
  unsavedNotice,
} from "../src/screens/settings/rules";

const uuid = "11111111-1111-4111-8111-111111111111";
const base = (): Settings => defaultSettings("2026-11-02", "Australia/Brisbane");
const bytes = (values: number[]) => Buffer.from(values).toString("base64");

describe("dumbbells", () => {
  test("format in the display unit", () => {
    expect(formatDumbbells([5, 7.5, 10], "kg")).toBe("5, 7.5, 10");
    expect(formatDumbbells([10], "lb")).toBe("22.05");
  });

  test("parse into sorted unique kilograms", () => {
    expect(parseDumbbells("10, 5, 7.5, 5,", "kg")).toEqual({ values: [5, 7.5, 10] });
    expect(parseDumbbells("", "kg")).toEqual({ values: [] });
    const pounds = parseDumbbells("22.05", "lb");
    expect(pounds.values?.[0]).toBeCloseTo(10, 2);
  });

  test("reject sizes that are not positive or too heavy", () => {
    expect(parseDumbbells("5, x", "kg").error).toBe(
      "Enter dumbbell sizes as positive numbers separated by commas, for example 5, 7.5, 10. Each size can be up to 200 kg.",
    );
    expect(parseDumbbells("0", "kg").error).toBeDefined();
    expect(parseDumbbells("500", "lb").error).toContain("up to 440 lb");
    expect(parseDumbbells(Array.from({ length: 61 }, (_, i) => i + 1).join(","), "kg").error).toBe("Enter up to 60 dumbbell sizes.");
  });
});

describe("validation messages", () => {
  test("name the field to fix", () => {
    const draft = { ...base(), calories: 100 };
    expect(checkSettings(draft).error).toEqual({
      id: "calories",
      text: "Daily calorie trial: enter a whole number from 800 to 10000 kcal.",
    });
    expect(checkSettings({ ...base(), age: 12 }).error?.id).toBe("age");
    expect(checkSettings({ ...base(), heightCm: Number.NaN }).error?.id).toBe("height");
    expect(checkSettings({ ...base(), timezone: "Nowhere/City" }).error?.id).toBe("timezone");
    expect(checkSettings({ ...base(), introductionWeeks: 9 }).error?.id).toBe("introduction");
    expect(checkSettings({ ...base(), goal: " " }).error?.id).toBe("goal");
    expect(checkSettings({ ...base(), protein: 5 }).error?.id).toBe("protein");
  });

  test("point at routine and exercise fields", () => {
    const draft = base();
    const [first] = draft.routines;
    if (!first) throw new Error("The default plan has routines.");
    const named = { ...draft, routines: [{ ...first, name: "" }] };
    expect(checkSettings(named).error).toEqual({ id: "routine-0", text: "Routine 1: enter a routine name of up to 160 characters." });
    const exercise = first.exercises[0];
    if (!exercise) throw new Error("The default routine has exercises.");
    const sets = { ...draft, routines: [{ ...first, exercises: [{ ...exercise, sets: 9 }] }] };
    expect(checkSettings(sets).error).toEqual({ id: "sets-0-0", text: `${first.name}, ${exercise.name}: enter 1 to 8 sets.` });
    const range = { ...draft, routines: [{ ...first, exercises: [{ ...exercise, min: 12, max: 8 }] }] };
    expect(checkSettings(range).error).toEqual({
      id: "min-0-0",
      text: `${first.name}, ${exercise.name}: use a minimum above 0 that is no larger than the maximum.`,
    });
    expect(checkSettings({ ...draft, routines: [{ ...first, exercises: [] }] }).error?.text).toBe(`${first.name}: keep 1 to 15 exercises.`);
    expect(checkSettings({ ...draft, routines: [] }).error?.text).toBe("Keep 1 to 8 routines.");
  });

  test("cover equipment and unknown issues", () => {
    const draft = { ...base(), equipment: [{ id: uuid, name: "", notes: "" }] };
    expect(checkSettings(draft).error).toEqual({
      id: "equipment-0",
      text: "Equipment: enter a name of up to 160 characters and notes of up to 500.",
    });
    expect(describeIssue(undefined, base())).toEqual({ text: "Check the highlighted settings and try again." });
  });

  test("valid settings come back parsed", () => {
    expect(checkSettings(base()).data).toEqual(settingsSchema.parse(base()));
  });
});

describe("editor state", () => {
  test("number text keeps empty and invalid values apart", () => {
    expect(parseNumberText("", true)).toBeNull();
    expect(parseNumberText("")).toBeNaN();
    expect(parseNumberText("62,5")).toBe(62.5);
    expect(parseNumberText("abc")).toBeNaN();
    expect(numberText(null)).toBe("");
    expect(numberText(Number.NaN)).toBe("");
    expect(numberText(2400)).toBe("2400");
  });

  test("settings revision", () => {
    const record: RecordEntry = { id: settingsId, revision: 4, data: base(), updatedAt: "2026-11-02T00:00:00.000Z" };
    expect(settingsRevision([record])).toBe(4);
    expect(settingsRevision([])).toBe(0);
  });

  test("status line follows the queue", () => {
    const idle = { error: "", pending: 0, saving: false };
    expect(saveStatus("", idle)).toBe("");
    expect(saveStatus(unsavedNotice, idle)).toBe("Unsaved settings");
    expect(saveStatus(queuedNotice, idle)).toBe("Settings saved.");
    expect(saveStatus(queuedNotice, { ...idle, pending: 1 })).toBe("Settings pending sync.");
    expect(saveStatus(queuedNotice, { ...idle, error: "Offline" })).toBe("Settings need attention. See the save error below.");
  });
});

describe("routines", () => {
  test("move swaps neighbours and ignores the ends", () => {
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(move(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    const list = ["a", "b"];
    expect(move(list, 0, -1)).toBe(list);
  });

  test("an exercise is added once with its default prescription", () => {
    const routine = newRoutine(uuid);
    expect(routine.name).toBe("New routine");
    expect(routine.exercises.map((e) => e.id)).toEqual(["squat"]);
    expect(addExercise(routine, "squat")).toBe(routine);
    expect(addExercise(routine, "unknown")).toBe(routine);
    const added = addExercise(routine, "curl");
    expect(added.exercises.at(-1)).toEqual({ id: "curl", name: "Hammer curl", sets: 2, min: 10, max: 15, side: false, rest: 75, mode: "reps" });
    const choices = exerciseChoices(added);
    expect(choices.find((c) => c.id === "curl")).toEqual({ id: "curl", label: "Hammer curl · already in this routine", included: true });
    expect(choices.find((c) => c.id === "bench")?.included).toBe(false);
  });

  test("new equipment", () => {
    expect(newEquipment(uuid)).toEqual({ id: uuid, name: "New equipment", notes: "" });
  });
});

describe("rotation preview", () => {
  test("shows this week and next from Monday", () => {
    const plan = base();
    const weeks = rotationPreview(plan, "2026-11-04");
    expect(weeks?.map((w) => w.label)).toEqual(["Week of Mon 2 Nov", "Week of Mon 9 Nov"]);
    expect(weeks?.[0]?.days).toHaveLength(7);
    expect(weeks?.[0]?.days[0]).toMatchObject({ day: "2026-11-02", weekday: "Mon", type: "strength" });
    expect(weeks?.[0]?.days[1]).toMatchObject({ type: "run", title: "Run" });
    const strength = weeks?.flatMap((w) => w.days).filter((d) => d.type === "strength") ?? [];
    expect(new Set(strength.map((d) => d.title)).size).toBeGreaterThan(1);
  });

  test("needs a start date and a routine", () => {
    expect(rotationPreview({ ...base(), startDate: "" }, "2026-11-04")).toBeNull();
    expect(rotationPreview({ ...base(), routines: [] }, "2026-11-04")).toBeNull();
  });
});

describe("photos", () => {
  const jpeg = bytes([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]);
  const png = bytes([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  const webp = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ").toString("base64");

  test("decode the leading bytes and size", () => {
    expect(base64Prefix(bytes([1, 2, 3, 4, 5]), 4)).toEqual([1, 2, 3, 4]);
    expect(base64Bytes(bytes([1]))).toBe(1);
    expect(base64Bytes(bytes([1, 2]))).toBe(2);
    expect(base64Bytes(bytes([1, 2, 3]))).toBe(3);
  });

  test("recognise the accepted types by their bytes", () => {
    expect(photoTypeOf(jpeg)).toBe("image/jpeg");
    expect(photoTypeOf(png)).toBe("image/png");
    expect(photoTypeOf(webp)).toBe("image/webp");
    expect(photoTypeOf(bytes([71, 73, 70, 56, 57, 97]))).toBeNull();
  });

  test("check type, size and count before upload", () => {
    expect(checkPhoto(jpeg, 0)).toEqual({ type: "image/jpeg" });
    expect(checkPhoto(jpeg, 20).error).toBe("Keep up to 20 equipment photos. Remove a photo before adding another.");
    expect(checkPhoto(null, 0).error).toBe("Upload failed. Choose the photo again to retry.");
    expect(checkPhoto(bytes([1, 2, 3]), 0).error).toBe("Choose a JPEG, PNG or WebP photo.");
    const large = jpeg + "A".repeat(Math.ceil((2 * 1024 * 1024 * 4) / 3));
    expect(checkPhoto(large, 0).error).toBe("Choose a photo under 2 MB.");
  });

  test("an ID from the content digest is a version 4 UUID", () => {
    const id = photoId("ab".repeat(32));
    expect(id).toBe("abababab-abab-4bab-abab-abababababab");
    expect(photoId("00".repeat(32))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("names carry the uploaded type", () => {
    expect(photoName("IMG_0001.HEIC", "image/jpeg")).toBe("IMG_0001.jpg");
    expect(photoName(null, "image/png")).toBe("Equipment photo.png");
    expect(photoName("x".repeat(200), "image/webp")).toHaveLength(160);
  });
});

describe("account copy", () => {
  test("sign out explains what stays and what goes", () => {
    expect(signOutMessage(0)).toBe(
      "Your saved data stays in your Fitness account. Apple Health sync stays connected until you disconnect it under Apple Health.",
    );
    expect(signOutMessage(1)).toContain("1 change on this iPhone has not synced and will be deleted. Export pending changes first to keep it.");
    expect(signOutMessage(3)).toContain("3 changes on this iPhone have not synced");
  });

  test("onboarding summarises the starting plan", () => {
    const summary = planSummary(base());
    expect(summary.strength).toMatch(/^3 days · .+ take turns$/);
    expect(summary.runs).toBe("2 easy runs");
    expect(summary.food).toBe("2400 kcal · 120 g protein");
    expect(summary.introduction).toContain("The first 2 weeks use up to two sets per exercise.");
  });
});
