/**
 * Account operations for connected agents. Every change goes through the
 * same validation, revision checks and request receipts as the app.
 */
import {
  addDays,
  displayLoad,
  localDate,
  mealSchema,
  runSchema,
  scheduled,
  settingsId,
  settingsSchema,
  toKg,
  totals,
  trainingRecords,
  weightSchema,
} from "../domain";
import type { Entity, Mutation, RecordEntry, Settings } from "../domain";
import type { z } from "zod";
import { BatchConflict, loadRecords, saveRecords } from "./store";

export class AgentError extends Error {}

type Meal = Extract<Entity, { kind: "meal" }>;
type Account = {
  records: RecordEntry[];
  settings: Settings | undefined;
  timezone: string;
  today: string;
};

async function account(owner: string): Promise<Account> {
  const records = await loadRecords(owner);
  const stored = records.find((r) => r.id === settingsId)?.data;
  const settings =
    stored?.kind === "settings" ? settingsSchema.parse(stored) : undefined;
  const timezone = settings?.timezone ?? "UTC";
  return { records, settings, timezone, today: localDate(timezone) };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function mealView(record: RecordEntry) {
  const data = record.data as Meal;
  return {
    id: record.id,
    name: data.name,
    calories: data.calories,
    protein: data.protein,
  };
}

function food(account: Account, date: string) {
  const meals = account.records
    .filter((r) => r.data.kind === "meal" && r.data.date === date)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map(mealView);
  const total = totals(account.records, date);
  const settings = account.settings;
  return {
    meals,
    totals: { calories: round(total.calories), protein: round(total.protein) },
    remaining: settings
      ? {
          calories: round(settings.calories - total.calories),
          protein: round(settings.protein - total.protein),
        }
      : null,
  };
}

function weightOn(account: Account, date: string) {
  const record = account.records.find(
    (r) => r.data.kind === "weight" && r.data.date === date,
  );
  if (record?.data.kind !== "weight") return null;
  const units = account.settings?.units ?? "kg";
  return {
    id: record.id,
    kg: round(record.data.kg),
    display: `${displayLoad(record.data.kg, units)} ${units}`,
  };
}

function training(account: Account, date: string) {
  const units = account.settings?.units ?? "kg";
  const projected = trainingRecords(account.records);
  const workouts = projected.flatMap((r) =>
    r.data.kind === "workout" && r.data.date === date
      ? [
          {
            id: r.id,
            name: r.data.name,
            status: r.data.finishedAt ? "completed" : "in progress",
            exercises: r.data.exercises.map((e) => ({
              name: e.prescription.name,
              mode: e.prescription.mode,
              sets: e.sets.map((s) =>
                s.skipped
                  ? "skipped"
                  : !s.done
                    ? "not done"
                    : e.prescription.mode === "seconds"
                      ? `${s.value}s${s.right === null ? "" : ` / ${s.right}s`}`
                      : `${displayLoad(s.loadKg, units)} ${units} × ${s.value}${s.right === null ? "" : ` / ${s.right}`}`,
              ),
            })),
            notes: r.data.notes,
          },
        ]
      : [],
  );
  const runs = projected.flatMap((r) =>
    r.data.kind === "run" && r.data.date === date
      ? [
          {
            id: r.id,
            minutes: r.data.minutes,
            distanceKm: r.data.distanceKm,
            notes: r.data.notes,
          },
        ]
      : [],
  );
  return { workouts, runs };
}

function plan(account: Account, date: string) {
  if (!account.settings) return null;
  const planned = scheduled(account.settings, date);
  return {
    type: planned.type,
    routine:
      planned.type === "strength" && planned.routine
        ? {
            name: planned.routine.name,
            exercises: planned.routine.exercises.map((e) => e.name),
          }
        : null,
  };
}

function dateOrToday(account: Account, date: string | undefined) {
  return date ?? account.today;
}

function summary(account: Account) {
  return {
    today: account.today,
    timezone: account.timezone,
    units: account.settings?.units ?? "kg",
    targets: account.settings
      ? {
          calories: account.settings.calories,
          protein: account.settings.protein,
        }
      : null,
    goal: account.settings?.goal ?? null,
  };
}

export async function getDay(owner: string, input: { date?: string }) {
  const a = await account(owner);
  const date = dateOrToday(a, input.date);
  return {
    ...summary(a),
    date,
    plan: plan(a, date),
    food: food(a, date),
    weight: weightOn(a, date),
    ...training(a, date),
  };
}

const historyLimit = 62;
export async function getHistory(
  owner: string,
  input: { from: string; to?: string },
) {
  const a = await account(owner);
  const to = dateOrToday(a, input.to);
  if (input.from > to)
    throw new AgentError("Choose a start date on or before the end date.");
  if (addDays(input.from, historyLimit - 1) < to)
    throw new AgentError(`Choose a range of up to ${historyLimit} days.`);
  const days = [];
  for (let date = input.from; date <= to; date = addDays(date, 1)) {
    const { workouts, runs } = training(a, date);
    const eaten = food(a, date);
    days.push({
      date,
      plan: plan(a, date)?.type ?? null,
      calories: eaten.totals.calories,
      protein: eaten.totals.protein,
      meals: eaten.meals.length,
      weight: weightOn(a, date)?.display ?? null,
      workouts: workouts.map((w) => `${w.name} (${w.status})`),
      runs: runs.map((r) => `${r.distanceKm} km in ${r.minutes} min`),
    });
  }
  return { ...summary(a), days };
}

export async function listSavedMeals(owner: string) {
  const records = await loadRecords(owner);
  return {
    savedMeals: records.flatMap((r) =>
      r.data.kind === "regular"
        ? [
            {
              id: r.id,
              name: r.data.name,
              calories: r.data.calories,
              protein: r.data.protein,
            },
          ]
        : [],
    ),
  };
}

function created(data: Entity): Mutation {
  return {
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    revision: 0,
    data,
  };
}

function changed(record: RecordEntry, data: Entity | null): Mutation {
  return {
    operationId: crypto.randomUUID(),
    id: record.id,
    revision: record.revision,
    data,
  };
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new AgentError(
    issue
      ? `${issue.path.length ? issue.path.join(".") + ": " : ""}${issue.message}`
      : "Check the values and try again.",
  );
}

async function commit(owner: string, changes: Mutation[]) {
  try {
    return await saveRecords(owner, changes);
  } catch (error) {
    if (error instanceof BatchConflict)
      throw new AgentError(
        "An entry changed while saving. Read the day again and retry.",
      );
    throw error;
  }
}

export async function addMeals(
  owner: string,
  input: {
    date?: string;
    meals: { name: string; calories: number; protein: number }[];
  },
) {
  const a = await account(owner);
  const date = dateOrToday(a, input.date);
  const changes = input.meals.map((meal) =>
    created(
      parsed(mealSchema, {
        kind: "meal",
        date,
        name: meal.name,
        calories: meal.calories,
        protein: meal.protein,
      }),
    ),
  );
  const saved = await commit(owner, changes);
  const after = await account(owner);
  return {
    date,
    added: saved.map(mealView),
    food: food(after, date),
  };
}

function find(account: Account, id: string, kinds: Entity["kind"][]) {
  const record = account.records.find((r) => r.id === id);
  if (!record || !kinds.includes(record.data.kind))
    throw new AgentError(
      `No ${kinds.join(", ")} entry has that ID. Read the day to find current IDs.`,
    );
  return record;
}

export async function updateMeal(
  owner: string,
  input: {
    id: string;
    name?: string;
    calories?: number;
    protein?: number;
    date?: string;
  },
) {
  const a = await account(owner);
  const record = find(a, input.id, ["meal"]);
  const before = record.data as Meal;
  const data = parsed(mealSchema, {
    ...before,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.calories === undefined ? {} : { calories: input.calories }),
    ...(input.protein === undefined ? {} : { protein: input.protein }),
    ...(input.date === undefined ? {} : { date: input.date }),
  });
  const [saved] = await commit(owner, [changed(record, data)]);
  const after = await account(owner);
  return {
    updated: saved ? mealView(saved) : null,
    food: food(after, data.date),
  };
}

export async function deleteEntries(owner: string, input: { ids: string[] }) {
  const a = await account(owner);
  const ids = [...new Set(input.ids)];
  const records = ids.map((id) => find(a, id, ["meal", "run", "weight"]));
  await commit(
    owner,
    records.map((record) => changed(record, null)),
  );
  return {
    deleted: records.map((r) => ({
      id: r.id,
      kind: r.data.kind,
      date: "date" in r.data ? r.data.date : null,
    })),
  };
}

export async function logWeight(
  owner: string,
  input: { date?: string; weight: number; unit?: "kg" | "lb" },
) {
  const a = await account(owner);
  const date = dateOrToday(a, input.date);
  const unit = input.unit ?? a.settings?.units ?? "kg";
  const data = parsed(weightSchema, {
    kind: "weight",
    date,
    kg: toKg(input.weight, unit),
  });
  const existing = a.records.find(
    (r) => r.data.kind === "weight" && r.data.date === date,
  );
  await commit(owner, [existing ? changed(existing, data) : created(data)]);
  return {
    date,
    replaced: Boolean(existing),
    weight: weightOn(await account(owner), date),
  };
}

export async function logRun(
  owner: string,
  input: {
    date?: string;
    minutes: number;
    distanceKm: number;
    notes?: string;
  },
) {
  const a = await account(owner);
  const date = dateOrToday(a, input.date);
  const data = parsed(runSchema, {
    kind: "run",
    date,
    minutes: input.minutes,
    distanceKm: input.distanceKm,
    notes: input.notes ?? "",
  });
  const [saved] = await commit(owner, [created(data)]);
  return { date, run: { id: saved?.id, ...data } };
}
