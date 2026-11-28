import { describe, expect, test } from "bun:test";
import type { Entity, RecordEntry } from "@bent/fitness-contracts/domain";
import {
  dayLabels,
  daySummary,
  editStatus,
  hasRegular,
  lastSevenDays,
  mealFromRegular,
  mealInput,
  mealSummary,
  mealsOn,
  parseAmount,
  parseMeal,
  regularFor,
  regulars,
  savedMessage,
  weekDescription,
} from "../src/screens/food/meals";

let next = 0;
function record(data: Entity, revision = 1): RecordEntry {
  next += 1;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    revision,
    data,
    updatedAt: "2026-11-20T08:00:00.000Z",
  };
}
const day = "2026-11-20";
const breakfast = record({ kind: "meal", date: day, name: "Porridge", calories: 420.4, protein: 18.6 });
const lunch = record({ kind: "meal", date: day, name: "Chicken wrap", calories: 610, protein: 42 });
const yesterday = record({ kind: "meal", date: "2026-11-19", name: "Soup", calories: 2600, protein: 30 });
const regular = record({ kind: "regular", name: "Yoghurt and berries", calories: 250, protein: 20 });
const records = [breakfast, lunch, yesterday, regular];
const targets = { calories: 2400, protein: 150 };
const typed = (values: {
  name: string;
  calories: string;
  protein: string;
  carbs?: string;
  fat?: string;
  fibre?: string;
}) => ({
  carbs: "",
  fat: "",
  fibre: "",
  ...values,
});
const plainError = "Enter a meal name, calories and protein.";

describe("meal form", () => {
  test("reads typed amounts, with a comma as the decimal mark", () => {
    expect(parseAmount(" 12.5 ")).toBe(12.5);
    expect(parseAmount("12,5")).toBe(12.5);
    expect(parseAmount("")).toBeNaN();
    expect(parseAmount("abc")).toBeNaN();
  });

  test("builds a meal for the day", () => {
    expect(parseMeal(typed({ name: " Toast ", calories: "300", protein: "9" }), day)).toEqual({
      meal: { kind: "meal", date: day, name: "Toast", calories: 300, protein: 9 },
    });
    expect(parseMeal(typed({ name: "Toast", calories: "0", protein: "0" }), day)).toHaveProperty("meal");
  });

  test("records the tracked nutrients typed, and keeps the others", () => {
    const previous = {
      kind: "meal" as const,
      date: day,
      name: "Toast",
      calories: 300,
      protein: 9,
      carbs: 40,
      fat: 6,
      fibre: 3,
    };
    expect(
      parseMeal(
        typed({ name: "Toast", calories: "300", protein: "9", carbs: "45,5", fat: "" }),
        day,
        ["carbs", "fat"],
        previous,
      ),
    ).toEqual({
      meal: { ...previous, carbs: 45.5, fat: undefined, fibre: 3 },
    });
    // Values typed for nutrients the account doesn't track are left out.
    expect(parseMeal(typed({ name: "Toast", calories: "300", protein: "9", carbs: "45" }), day)).toEqual({
      meal: { kind: "meal", date: day, name: "Toast", calories: 300, protein: 9 },
    });
    expect(parseMeal(typed({ name: "Toast", calories: "300", protein: "9", fibre: "-1" }), day, ["fibre"])).toEqual({
      error: "Enter a meal name, calories and protein. Fibre is optional: enter grams or leave it empty.",
    });
  });

  test("asks for a name, calories and protein", () => {
    for (const input of [
      { name: "", calories: "300", protein: "9" },
      { name: "  ", calories: "300", protein: "9" },
      { name: "Toast", calories: "", protein: "9" },
      { name: "Toast", calories: "300", protein: "" },
      { name: "Toast", calories: "-1", protein: "9" },
      { name: "Toast", calories: "10001", protein: "9" },
      { name: "Toast", calories: "300", protein: "501" },
      { name: "x".repeat(161), calories: "300", protein: "9" },
    ])
      expect(parseMeal(typed(input), day)).toEqual({ error: plainError });
  });

  test("opens a saved meal as text", () => {
    expect(mealInput(undefined)).toEqual(typed({ name: "", calories: "", protein: "" }));
    expect(mealInput({ name: "Porridge", calories: 420.4, protein: 18.6 })).toEqual(
      typed({ name: "Porridge", calories: "420.4", protein: "18.6" }),
    );
    expect(mealInput({ name: "Porridge", calories: 420, protein: 18, carbs: 60.5, fibre: 0 })).toEqual(
      typed({ name: "Porridge", calories: "420", protein: "18", carbs: "60.5", fibre: "0" }),
    );
  });
});

describe("edit checks", () => {
  const opened = { id: breakfast.id, revision: 1, data: breakfast.data };
  test("a closed editor is current", () => {
    expect(editStatus(undefined, undefined)).toBe("current");
  });
  test("compare the saved version with the opened one", () => {
    expect(editStatus(opened, { revision: 1, data: breakfast.data })).toBe("current");
    expect(editStatus(opened, { revision: 2, data: breakfast.data })).toBe("changed");
    expect(
      editStatus(opened, {
        revision: 1,
        data: { ...breakfast.data, kind: "meal", date: day, name: "Oats", calories: 1, protein: 1 },
      }),
    ).toBe("changed");
    expect(editStatus(opened, { revision: 2, data: null })).toBe("removed");
    expect(editStatus(opened, undefined)).toBe("removed");
  });
});

describe("saved meals", () => {
  test("match by name in any case, calories and protein", () => {
    expect(hasRegular(records, { name: "yoghurt AND berries", calories: 250, protein: 20 })).toBe(true);
    expect(hasRegular(records, { name: "Yoghurt and berries", calories: 251, protein: 20 })).toBe(false);
    expect(hasRegular(records, { name: "Porridge", calories: 420.4, protein: 18.6 })).toBe(false);
    expect(hasRegular(records, { name: "Yoghurt and berries", calories: 250, protein: 20, carbs: 30 })).toBe(false);
  });

  test("convert between meals and saved meals", () => {
    const meal = { kind: "meal" as const, date: day, name: "Toast", calories: 300, protein: 9 };
    expect(regularFor(meal)).toEqual({ kind: "regular", name: "Toast", calories: 300, protein: 9 });
    expect(mealFromRegular({ kind: "regular", name: "Toast", calories: 300, protein: 9 }, "2026-11-21")).toEqual({
      ...meal,
      date: "2026-11-21",
    });
    expect(regularFor({ ...meal, fat: 4 })).toEqual({
      kind: "regular",
      name: "Toast",
      calories: 300,
      protein: 9,
      fat: 4,
    });
    expect(mealFromRegular({ kind: "regular", name: "Toast", calories: 300, protein: 9, fibre: 2 }, day)).toEqual({
      ...meal,
      fibre: 2,
    });
  });

  test("list saved meals and the day's meals", () => {
    expect(regulars(records).map((item) => item.data.name)).toEqual(["Yoghurt and berries"]);
    expect(mealsOn(records, day).map((item) => item.data.name)).toEqual(["Porridge", "Chicken wrap"]);
    expect(mealsOn(records, "2026-11-18")).toEqual([]);
  });
});

describe("messages", () => {
  const meal = { kind: "meal" as const, date: day, name: "Toast", calories: 300.4, protein: 9.6 };
  test("say what was saved and for which day", () => {
    expect(savedMessage(meal, false, false)).toBe("Added Toast for Fri 20 Nov 2026.");
    expect(savedMessage(meal, true, false)).toBe("Updated Toast for Fri 20 Nov 2026.");
    expect(savedMessage(meal, false, true)).toBe("Added Toast for Fri 20 Nov 2026. It is already in Saved meals.");
  });
  test("summarise rounded amounts", () => {
    expect(mealSummary(meal)).toBe("300 kcal · 10g protein");
    expect(mealSummary({ ...meal, carbs: 30.4, fat: 2 }, ["carbs", "fibre"])).toBe(
      "300 kcal · 10g protein · 30g carbs",
    );
  });
});

describe("day totals", () => {
  test("show what is left against the targets", () => {
    const summary = daySummary(records, day, targets);
    expect(summary.calories).toMatchObject({ value: 1030, target: 2400, over: false, note: "1370 kcal left" });
    expect(summary.calories.progress).toBeCloseTo(1030.4 / 2400);
    expect(summary.protein).toMatchObject({ value: 61, target: 150, reached: false, note: "89g to go" });
  });
  test("show calories over and protein reached", () => {
    const summary = daySummary(records, "2026-11-19", { calories: 2400, protein: 30 });
    expect(summary.calories).toMatchObject({ over: true, note: "200 kcal over", progress: 1 });
    expect(summary.protein).toMatchObject({ reached: true, note: "Protein target reached", progress: 1 });
  });
  test("show tracked nutrients against their targets", () => {
    const day2 = "2026-11-22";
    const meals = [
      record({ kind: "meal", date: day2, name: "Oats", calories: 400, protein: 20, carbs: 60, fat: 80, fibre: 31 }),
      record({ kind: "meal", date: day2, name: "Apple", calories: 95, protein: 0, carbs: 25 }),
    ];
    const settings = { ...targets, nutrients: { fibre: { target: 30 }, carbs: { target: null }, fat: { target: 70 } } };
    expect(daySummary(meals, day2, settings).nutrients).toEqual([
      {
        nutrient: "carbs",
        label: "Carbs",
        value: 85,
        target: null,
        progress: null,
        tone: "default",
        note: "",
        coverage: "",
      },
      {
        nutrient: "fat",
        label: "Fat",
        value: 80,
        target: 70,
        progress: 1,
        tone: "missed",
        note: "10g over",
        coverage: "from 1 of 2 meals",
      },
      {
        nutrient: "fibre",
        label: "Fibre",
        value: 31,
        target: 30,
        progress: 1,
        tone: "done",
        note: "Fibre target reached",
        coverage: "from 1 of 2 meals",
      },
    ]);
    expect(daySummary(meals, day2, targets).nutrients).toEqual([]);
  });
  test("an empty day starts at zero", () => {
    expect(daySummary([], day, targets).calories).toMatchObject({ value: 0, progress: 0, note: "2400 kcal left" });
  });
});

describe("last seven days", () => {
  test("end on the chosen day", () => {
    const week = lastSevenDays(records, day, 2400);
    expect(week.days.map((item) => item.day)).toEqual([
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
    ]);
    expect(new Set(week.days.map((item) => item.label)).size).toBe(7);
    expect(week.days.at(-1)).toMatchObject({ label: "Fri", calories: 1030, selected: true });
    expect(week.days.at(-2)).toMatchObject({ calories: 2600, selected: false });
    expect(week.highest).toBe(2600);
    expect(lastSevenDays([], day, 2400).highest).toBe(2400);
  });
  test("each day's popover shows calories, protein and the target difference", () => {
    const week = lastSevenDays(records, day, 2400);
    expect(week.days.at(-1)).toMatchObject({ calories: 1030, protein: 61 });
    const labels = dayLabels(week.days, 2400);
    expect(labels).toHaveLength(7);
    expect(labels.at(-1)).toEqual({ title: "Fri 20 Nov", detail: "1030 kcal · 61 g protein\n1370 kcal under target" });
    expect(labels.at(-2)?.detail).toEndWith("\n200 kcal over target");
    expect(dayLabels([{ day, calories: 2400, protein: 0 }], 2400)[0]?.detail).toBe(
      "2400 kcal · 0 g protein\nOn target",
    );
  });
  test("read as text", () => {
    const week = lastSevenDays(records, day, 2400);
    const text = weekDescription(week.days, 2400);
    expect(text).toStartWith("Calories for the last 7 days against your 2400 kcal target: Sat 14 Nov, 0 kcal;");
    expect(text).toContain("Thu 19 Nov, 2600 kcal; Fri 20 Nov, 1030 kcal.");
    expect(text).toEndWith("1 day over target.");
  });
});
