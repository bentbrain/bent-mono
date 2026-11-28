import { describe, expect, test } from "bun:test";
import {
  defaultSettings,
  foodSummary,
  isNutrient,
  mealEntryError,
  nutrientList,
  nutrientNote,
  mealNutrientValues,
  mealSchema,
  nutrientCoverage,
  nutrientTotals,
  regularSchema,
  sameNutrients,
  settingsSchema,
  totals,
  trackedNutrients,
  withNutrient,
} from "../src/domain";
import type { Entity, RecordEntry } from "../src/domain";

let next = 0;
function record(data: Entity): RecordEntry {
  next++;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    revision: 1,
    data,
    updatedAt: "2026-11-30T00:00:00.000Z",
  };
}

const meal = {
  kind: "meal" as const,
  date: "2026-11-30",
  name: "Oats",
  calories: 400,
  protein: 20,
};

describe("nutrients", () => {
  test("meals and saved meals record nutrients only when given", () => {
    expect(mealSchema.parse(meal)).toEqual(meal);
    expect(mealSchema.parse({ ...meal, carbs: 60, fat: 8, fibre: 0 })).toEqual(
      { ...meal, carbs: 60, fat: 8, fibre: 0 },
    );
    expect(
      regularSchema.parse({ kind: "regular", name: "Oats", calories: 400, protein: 20, fibre: 7 }),
    ).toEqual({ kind: "regular", name: "Oats", calories: 400, protein: 20, fibre: 7 });
    expect(mealSchema.safeParse({ ...meal, carbs: -1 }).success).toBe(false);
    expect(mealSchema.safeParse({ ...meal, fat: 501 }).success).toBe(false);
    expect(mealSchema.safeParse({ ...meal, fibre: 201 }).success).toBe(false);
    expect(mealSchema.safeParse({ ...meal, sugar: 4 }).success).toBe(false);
  });

  test("settings track nutrients with an optional target", () => {
    const settings = defaultSettings("2026-11-30", "Australia/Brisbane");
    expect(settings.nutrients).toBeUndefined();
    expect(trackedNutrients(settings)).toEqual([]);
    const tracked = withNutrient(withNutrient(settings, "fibre", 30), "carbs", null);
    expect(tracked.nutrients).toEqual({ fibre: { target: 30 }, carbs: { target: null } });
    expect(trackedNutrients(tracked)).toEqual(["carbs", "fibre"]);
    expect(settingsSchema.parse(tracked)).toEqual(tracked);
    const none = withNutrient(withNutrient(tracked, "fibre", false), "carbs", false);
    expect("nutrients" in none).toBe(false);
    expect(settingsSchema.parse(none)).toEqual(settings);
    expect(
      settingsSchema.safeParse(withNutrient(settings, "fat", 5)).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ ...settings, nutrients: { sugar: { target: 30 } } }).success,
    ).toBe(false);
  });

  test("totals count the meals that recorded each nutrient", () => {
    const records = [
      record({ ...meal, carbs: 60, fat: 8 }),
      record({ ...meal, name: "Chicken", carbs: 0 }),
      record({ ...meal, name: "Apple" }),
      record({ ...meal, date: "2026-12-01", fat: 90 }),
      record({ kind: "regular", name: "Oats", calories: 400, protein: 20, fat: 30 }),
    ];
    expect(totals(records, "2026-11-30")).toEqual({ calories: 1200, protein: 60 });
    const day = nutrientTotals(records, "2026-11-30");
    expect(day).toEqual({
      meals: 3,
      carbs: { grams: 60, recorded: 2 },
      fat: { grams: 8, recorded: 1 },
      fibre: { grams: 0, recorded: 0 },
    });
    expect(nutrientCoverage(day.carbs, day.meals)).toBe("from 2 of 3 meals");
    expect(nutrientCoverage({ grams: 0, recorded: 0 }, 1)).toBe("from 0 of 1 meal");
    expect(nutrientCoverage({ grams: 5, recorded: 2 }, 2)).toBe("");
    expect(nutrientTotals(records, "2026-12-02").meals).toBe(0);
  });

  test("compares and copies the values a meal records", () => {
    expect(mealNutrientValues({ ...meal, carbs: 10, fibre: 0 })).toEqual({ carbs: 10, fibre: 0 });
    expect(sameNutrients({ carbs: 10 }, { carbs: 10 })).toBe(true);
    expect(sameNutrients({ carbs: 10 }, { carbs: 10, fat: 0 })).toBe(false);
  });

  test("describes nutrients the same way on every screen", () => {
    expect(isNutrient("fibre")).toBe(true);
    expect(isNutrient("sugar")).toBe(false);
    expect(nutrientList(["carbs"])).toBe("carbs");
    expect(nutrientList(["carbs", "fibre"])).toBe("carbs and fibre");
    expect(nutrientList(["carbs", "fat", "fibre"])).toBe("carbs, fat and fibre");
    expect(nutrientNote("carbs", 210.4, 250)).toBe("40g left");
    expect(nutrientNote("fat", 82, 70)).toBe("12g over");
    expect(nutrientNote("fibre", 22, 30)).toBe("8g to go");
    expect(nutrientNote("fibre", 31, 30)).toBe("Fibre target reached");
    expect(foodSummary({ calories: 450.4, protein: 30, carbs: 40.2, fibre: 3 }, ["carbs", "fat"])).toBe(
      "450 kcal · 30g protein · 40g carbs",
    );
    expect(foodSummary({ calories: 450, protein: 30, carbs: 40 }, [])).toBe("450 kcal · 30g protein");
    expect(mealEntryError([])).toBe("Enter a meal name, calories and protein.");
    expect(mealEntryError(["fibre"])).toBe(
      "Enter a meal name, calories and protein. Fibre is optional: enter grams or leave it empty.",
    );
    expect(mealEntryError(["carbs", "fat"])).toBe(
      "Enter a meal name, calories and protein. Carbs and fat are optional: enter grams or leave them empty.",
    );
  });
});
