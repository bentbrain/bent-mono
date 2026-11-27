import { addDays, formatDate, formatShortDate, mealSchema, regularSchema, sameData, totals } from "@bent/fitness-contracts/domain";
import type { Entity, RecordEntry, Settings } from "@bent/fitness-contracts/domain";

export type Meal = Extract<Entity, { kind: "meal" }>;
export type Regular = Extract<Entity, { kind: "regular" }>;

/** The version of a record an editor opened. Saving checks it is still current. */
export type Opened<T extends Entity> = { id: string; revision: number; data: T };

export type EditState = "current" | "changed" | "removed";

/** Whether the record still matches the version the editor opened. */
export function editStatus(
  opened: Opened<Entity> | undefined,
  current: { revision: number; data: Entity | null } | undefined,
): EditState {
  if (!opened) return "current";
  if (!current?.data) return "removed";
  return current.revision === opened.revision && sameData(current.data, opened.data) ? "current" : "changed";
}

/** The values typed into the meal form, kept as text while editing. */
export type MealInput = { name: string; calories: string; protein: string };

const emptyMeal: MealInput = { name: "", calories: "", protein: "" };

/** A number as typed. Empty text is not a number; a comma works as the decimal mark. */
export function parseAmount(text: string) {
  const value = text.trim().replace(",", ".");
  return value === "" ? Number.NaN : Number(value);
}

/** The form's text for a saved meal. */
export function mealInput(meal: Pick<Meal, "name" | "calories" | "protein"> | undefined): MealInput {
  return meal ? { name: meal.name, calories: String(meal.calories), protein: String(meal.protein) } : emptyMeal;
}

export const mealError = "Enter a meal name, calories and protein.";

/** Checks the typed values and builds the meal for `date`. */
export function parseMeal(input: MealInput, date: string): { meal: Meal } | { error: string } {
  const result = mealSchema.safeParse({
    kind: "meal",
    date,
    name: input.name,
    calories: parseAmount(input.calories),
    protein: parseAmount(input.protein),
  });
  return result.success ? { meal: result.data } : { error: mealError };
}

/** Whether a saved meal with the same name (any case), calories and protein exists. */
export function hasRegular(records: RecordEntry[], meal: Pick<Meal, "name" | "calories" | "protein">) {
  return records.some(
    (record) =>
      record.data.kind === "regular" &&
      record.data.name.toLowerCase() === meal.name.toLowerCase() &&
      record.data.calories === meal.calories &&
      record.data.protein === meal.protein,
  );
}

/** The saved meal to store for a meal. */
export function regularFor(meal: Meal): Regular {
  return regularSchema.parse({ kind: "regular", name: meal.name, calories: meal.calories, protein: meal.protein });
}

/** The message shown after a meal is saved. */
export function savedMessage(meal: Meal, updated: boolean, alreadySaved: boolean) {
  return `${updated ? "Updated" : "Added"} ${meal.name} for ${formatDate(meal.date)}.${alreadySaved ? " It is already in Saved meals." : ""}`;
}

/** "450 kcal · 30g protein" */
export function mealSummary(meal: Pick<Meal, "calories" | "protein">) {
  return `${Math.round(meal.calories)} kcal · ${Math.round(meal.protein)}g protein`;
}

/** The day's meals, in the order they were recorded. */
export function mealsOn(records: RecordEntry[], date: string) {
  return records.flatMap((record) =>
    record.data.kind === "meal" && record.data.date === date ? [{ id: record.id, revision: record.revision, data: record.data }] : [],
  );
}

/** Every saved meal. */
export function regulars(records: RecordEntry[]) {
  return records.flatMap((record) =>
    record.data.kind === "regular" ? [{ id: record.id, revision: record.revision, data: record.data }] : [],
  );
}

/** A saved meal recorded on `date`. */
export function mealFromRegular(regular: Regular, date: string): Meal {
  return { kind: "meal", date, name: regular.name, calories: regular.calories, protein: regular.protein };
}

/** The day's totals against the calorie and protein targets. */
export function daySummary(records: RecordEntry[], date: string, settings: Pick<Settings, "calories" | "protein">) {
  const total = totals(records, date);
  const left = {
    calories: Math.round(settings.calories - total.calories),
    protein: Math.round(settings.protein - total.protein),
  };
  return {
    calories: {
      value: Math.round(total.calories),
      target: settings.calories,
      progress: progress(total.calories, settings.calories),
      over: left.calories < 0,
      note: left.calories >= 0 ? `${left.calories} kcal left` : `${-left.calories} kcal over`,
    },
    protein: {
      value: Math.round(total.protein),
      target: settings.protein,
      progress: progress(total.protein, settings.protein),
      reached: left.protein <= 0,
      note: left.protein > 0 ? `${left.protein}g to go` : "Protein target reached",
    },
  };
}

function progress(value: number, target: number) {
  return target > 0 ? Math.min(value, target) / target : 0;
}

/** Calories for the seven days ending on `date`, oldest first. */
export function lastSevenDays(records: RecordEntry[], date: string, target: number) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(date, i - 6)).map((day) => {
    const eaten = totals(records, day);
    return {
      day,
      /** The weekday, such as "Mon"; unique within the seven days. */
      label: formatShortDate(day).split(" ")[0] ?? day,
      calories: Math.round(eaten.calories),
      protein: Math.round(eaten.protein),
      selected: day === date,
    };
  });
  const highest = Math.max(target, ...days.map((day) => day.calories));
  return { days, highest };
}

/** The popover for each day of the seven-day chart: calories, protein and the difference from the target. */
export function dayLabels(days: { day: string; calories: number; protein: number }[], target: number) {
  return days.map((day) => {
    const difference =
      day.calories === target
        ? "On target"
        : day.calories < target
          ? `${target - day.calories} kcal under target`
          : `${day.calories - target} kcal over target`;
    return {
      title: formatShortDate(day.day),
      detail: `${day.calories} kcal · ${day.protein} g protein\n${difference}`,
    };
  });
}

/** A sentence for VoiceOver that reads the seven-day chart. */
export function weekDescription(days: { day: string; calories: number }[], target: number) {
  const listed = days.map((day) => `${formatShortDate(day.day)}, ${day.calories} kcal`).join("; ");
  const over = days.filter((day) => day.calories > target).length;
  return `Calories for the last 7 days against your ${target} kcal target: ${listed}. ${over === 1 ? "1 day" : `${over} days`} over target.`;
}
