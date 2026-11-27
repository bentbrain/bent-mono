import { describe, expect, test } from "bun:test";
import type { Entity, RecordEntry } from "@bent/fitness-contracts/domain";
import {
  daySummary,
  editStatus,
  hasRegular,
  lastSevenDays,
  mealError,
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
  return { id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`, revision, data, updatedAt: "2026-11-20T08:00:00.000Z" };
}
const day = "2026-11-20";
const breakfast = record({ kind: "meal", date: day, name: "Porridge", calories: 420.4, protein: 18.6 });
const lunch = record({ kind: "meal", date: day, name: "Chicken wrap", calories: 610, protein: 42 });
const yesterday = record({ kind: "meal", date: "2026-11-19", name: "Soup", calories: 2600, protein: 30 });
const regular = record({ kind: "regular", name: "Yoghurt and berries", calories: 250, protein: 20 });
const records = [breakfast, lunch, yesterday, regular];
const targets = { calories: 2400, protein: 150 };

describe("meal form", () => {
  test("reads typed amounts, with a comma as the decimal mark", () => {
    expect(parseAmount(" 12.5 ")).toBe(12.5);
    expect(parseAmount("12,5")).toBe(12.5);
    expect(parseAmount("")).toBeNaN();
    expect(parseAmount("abc")).toBeNaN();
  });

  test("builds a meal for the day", () => {
    expect(parseMeal({ name: " Toast ", calories: "300", protein: "9" }, day)).toEqual({
      meal: { kind: "meal", date: day, name: "Toast", calories: 300, protein: 9 },
    });
    expect(parseMeal({ name: "Toast", calories: "0", protein: "0" }, day)).toHaveProperty("meal");
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
      expect(parseMeal(input, day)).toEqual({ error: mealError });
    expect(mealError).toBe("Enter a meal name, calories and protein.");
  });

  test("opens a saved meal as text", () => {
    expect(mealInput(undefined)).toEqual({ name: "", calories: "", protein: "" });
    expect(mealInput({ name: "Porridge", calories: 420.4, protein: 18.6 })).toEqual({ name: "Porridge", calories: "420.4", protein: "18.6" });
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
    expect(editStatus(opened, { revision: 1, data: { ...breakfast.data, kind: "meal", date: day, name: "Oats", calories: 1, protein: 1 } })).toBe("changed");
    expect(editStatus(opened, { revision: 2, data: null })).toBe("removed");
    expect(editStatus(opened, undefined)).toBe("removed");
  });
});

describe("saved meals", () => {
  test("match by name in any case, calories and protein", () => {
    expect(hasRegular(records, { name: "yoghurt AND berries", calories: 250, protein: 20 })).toBe(true);
    expect(hasRegular(records, { name: "Yoghurt and berries", calories: 251, protein: 20 })).toBe(false);
    expect(hasRegular(records, { name: "Porridge", calories: 420.4, protein: 18.6 })).toBe(false);
  });

  test("convert between meals and saved meals", () => {
    const meal = { kind: "meal" as const, date: day, name: "Toast", calories: 300, protein: 9 };
    expect(regularFor(meal)).toEqual({ kind: "regular", name: "Toast", calories: 300, protein: 9 });
    expect(mealFromRegular({ kind: "regular", name: "Toast", calories: 300, protein: 9 }, "2026-11-21")).toEqual({ ...meal, date: "2026-11-21" });
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
  test("read as text", () => {
    const week = lastSevenDays(records, day, 2400);
    const text = weekDescription(week.days, 2400);
    expect(text).toStartWith("Calories for the last 7 days against your 2400 kcal target: Sat 14 Nov, 0 kcal;");
    expect(text).toContain("Thu 19 Nov, 2600 kcal; Fri 20 Nov, 1030 kcal.");
    expect(text).toEndWith("1 day over target.");
  });
});
