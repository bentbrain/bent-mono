/**
 * Account operations for connected agents. Every change goes through the
 * same validation, revision checks and record rules as the app. Each write
 * runs once per request ID, in one transaction with its result.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  addDays,
  displayLoad,
  localDate,
  mealSchema,
  regularSchema,
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
import { BatchConflict, changeOnce, loadRecords } from "./store";
import type { AccountChange } from "./store";
import type { AgentAccess } from "./auth";

export class AgentError extends Error {}

type Account = {
  records: RecordEntry[];
  settings: Settings | undefined;
  timezone: string;
  today: string;
};

function account(records: RecordEntry[]): Account {
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
  if (record.data.kind !== "meal") throw new Error("Expected a meal.");
  return {
    id: record.id,
    revision: record.revision,
    name: record.data.name,
    calories: record.data.calories,
    protein: record.data.protein,
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
    revision: record.revision,
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
            revision: r.revision,
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
  const a = account(await loadRecords(owner));
  const date = input.date ?? a.today;
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
  const a = account(await loadRecords(owner));
  const to = input.to ?? a.today;
  const span =
    Math.round(
      (Date.parse(to + "T00:00:00Z") - Date.parse(input.from + "T00:00:00Z")) /
        86400000,
    ) + 1;
  if (span < 1)
    throw new AgentError("Choose a start date on or before the end date.");
  if (span > historyLimit)
    throw new AgentError(`Choose a range of up to ${historyLimit} days.`);
  const days = [];
  for (let offset = 0; offset < span; offset++) {
    const date = addDays(input.from, offset);
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

function savedMealView(record: RecordEntry) {
  if (record.data.kind !== "regular") throw new Error("Expected a saved meal.");
  return {
    id: record.id,
    revision: record.revision,
    name: record.data.name,
    calories: record.data.calories,
    protein: record.data.protein,
  };
}

function savedMeals(records: RecordEntry[]) {
  return records.filter((r) => r.data.kind === "regular").map(savedMealView);
}

export async function listSavedMeals(owner: string) {
  return { savedMeals: savedMeals(await loadRecords(owner)) };
}

function created(data: Entity): Mutation {
  return {
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    revision: 0,
    data,
  };
}

function changed(
  record: RecordEntry,
  revision: number,
  data: Entity | null,
): Mutation {
  return { operationId: crypto.randomUUID(), id: record.id, revision, data };
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

/** Derives the stored receipt ID from the caller's request ID. */
function receiptId(requestId: string) {
  const hex = createHash("sha256")
    .update("fitness-agent:" + requestId)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const outcome = z.object({
  full: z.record(z.string(), z.json()),
  receipt: z.record(z.string(), z.json()),
});
/**
 * Runs a write tool once per request ID. A retry with the same input
 * returns the first result instead of saving again. The full result includes
 * the day's other entries and previous values, so only connections with read
 * access see it. Others get a receipt of what they submitted.
 */
async function once(
  owner: string,
  access: AgentAccess,
  tool: string,
  { requestId, ...input }: { requestId: string },
  work: (change: AccountChange) => Promise<{ full: object; receipt: object }>,
) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ tool, input }))
    .digest("hex");
  try {
    const result = outcome.parse(
      await changeOnce(owner, { id: receiptId(requestId), fingerprint }, work),
    );
    return access.read ? result.full : result.receipt;
  } catch (error) {
    if (error instanceof BatchConflict)
      throw new AgentError(
        "An entry changed while saving. Read the day again and retry with a new request ID.",
      );
    throw error;
  }
}

const kindNames: Partial<Record<Entity["kind"], string>> = {
  meal: "meal",
  regular: "saved meal",
  run: "run",
  weight: "weigh-in",
};

/**
 * Finds an entry to change at the revision the caller read. Without read
 * access, one error covers missing, other-kind and changed entries, so
 * failures do not show what the account holds.
 */
function find(
  account: Account,
  access: AgentAccess,
  entry: { id: string; revision: number },
  kinds: Entity["kind"][],
) {
  const record = account.records.find((r) => r.id === entry.id);
  const current =
    record && kinds.includes(record.data.kind) ? record : undefined;
  if (!access.read && current?.revision !== entry.revision)
    throw new AgentError(
      `No ${kinds.map((k) => kindNames[k] ?? k).join(", ")} entry has the ID ${entry.id} at revision ${entry.revision}. Use an ID and revision from this connection's latest receipt.`,
    );
  if (!current)
    throw new AgentError(
      `No ${kinds.map((k) => kindNames[k] ?? k).join(", ")} entry has the ID ${entry.id}. Read the entries again to find current IDs.`,
    );
  if (current.revision !== entry.revision)
    throw new AgentError(
      `Entry ${entry.id} changed after you read it. Read it again before changing it.`,
    );
  return current;
}

/** Matches the app: a saved meal with the same name, calories and protein is a duplicate. */
function sameMeal(
  a: { name: string; calories: number; protein: number },
  b: { name: string; calories: number; protein: number },
) {
  return (
    a.name.toLowerCase() === b.name.toLowerCase() &&
    a.calories === b.calories &&
    a.protein === b.protein
  );
}

export function addMeals(
  owner: string,
  access: AgentAccess,
  input: {
    requestId: string;
    date?: string;
    meals: { name: string; calories: number; protein: number }[];
  },
) {
  return once(owner, access, "add_meals", input, async (change) => {
    const date = input.date ?? account(await change.records()).today;
    const added = [];
    for (const meal of input.meals) {
      const saved = await change.save(
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
      if (saved) added.push(mealView(saved));
    }
    return {
      full: { date, added, food: food(account(await change.records()), date) },
      receipt: { date, added },
    };
  });
}

export function updateMeal(
  owner: string,
  access: AgentAccess,
  input: {
    requestId: string;
    id: string;
    revision: number;
    name?: string;
    calories?: number;
    protein?: number;
    date?: string;
  },
) {
  return once(owner, access, "update_meal", input, async (change) => {
    const record = find(account(await change.records()), access, input, [
      "meal",
    ]);
    if (record.data.kind !== "meal") throw new Error("Expected a meal.");
    const data = parsed(mealSchema, {
      ...record.data,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.calories === undefined ? {} : { calories: input.calories }),
      ...(input.protein === undefined ? {} : { protein: input.protein }),
      ...(input.date === undefined ? {} : { date: input.date }),
    });
    const saved = await change.save(changed(record, input.revision, data));
    return {
      full: {
        updated: saved ? mealView(saved) : null,
        food: food(account(await change.records()), data.date),
      },
      receipt: {
        updated: saved ? { id: saved.id, revision: saved.revision } : null,
      },
    };
  });
}

export function deleteEntries(
  owner: string,
  access: AgentAccess,
  input: { requestId: string; entries: { id: string; revision: number }[] },
) {
  return once(owner, access, "delete_entries", input, async (change) => {
    const a = account(await change.records());
    if (new Set(input.entries.map((e) => e.id)).size !== input.entries.length)
      throw new AgentError("List each entry once.");
    const records = input.entries.map((entry) =>
      find(a, access, entry, ["meal", "regular", "run", "weight"]),
    );
    for (const record of records)
      await change.save(changed(record, record.revision, null));
    return {
      full: {
        deleted: records.map((r) => ({
          id: r.id,
          kind: r.data.kind === "regular" ? "savedMeal" : r.data.kind,
          date: "date" in r.data ? r.data.date : null,
        })),
      },
      receipt: { deleted: records.map((r) => ({ id: r.id })) },
    };
  });
}

export function logWeight(
  owner: string,
  access: AgentAccess,
  input: {
    requestId: string;
    date?: string;
    weight: number;
    unit?: "kg" | "lb";
  },
) {
  return once(owner, access, "log_weight", input, async (change) => {
    const a = account(await change.records());
    const date = input.date ?? a.today;
    const unit = input.unit ?? a.settings?.units ?? "kg";
    const data = parsed(weightSchema, {
      kind: "weight",
      date,
      kg: toKg(input.weight, unit),
    });
    const existing = a.records.find(
      (r) => r.data.kind === "weight" && r.data.date === date,
    );
    const saved = await change.save(
      existing ? changed(existing, existing.revision, data) : created(data),
    );
    return {
      full: {
        date,
        replacedKg:
          existing?.data.kind === "weight" ? round(existing.data.kg) : null,
        weight: weightOn(account(await change.records()), date),
      },
      receipt: {
        date,
        weight: saved
          ? { id: saved.id, revision: saved.revision, kg: round(data.kg) }
          : null,
      },
    };
  });
}

export function logRun(
  owner: string,
  access: AgentAccess,
  input: {
    requestId: string;
    date?: string;
    minutes: number;
    distanceKm: number;
    notes?: string;
  },
) {
  return once(owner, access, "log_run", input, async (change) => {
    const date = input.date ?? account(await change.records()).today;
    const data = parsed(runSchema, {
      kind: "run",
      date,
      minutes: input.minutes,
      distanceKm: input.distanceKm,
      notes: input.notes ?? "",
    });
    const saved = await change.save(created(data));
    const result = {
      date,
      run: saved ? { id: saved.id, revision: saved.revision, ...data } : null,
    };
    return { full: result, receipt: result };
  });
}

export function addSavedMeals(
  owner: string,
  access: AgentAccess,
  input: {
    requestId: string;
    savedMeals: { name: string; calories: number; protein: number }[];
  },
) {
  // Skipping meals already saved would show a write-only connection which
  // ones exist, so it checks only the meals in its own request. The grant is
  // part of the request, so a retry under the other grant is rejected.
  const tool = access.read ? "add_saved_meals" : "add_saved_meals_write_only";
  return once(owner, access, tool, input, async (change) => {
    const existing = access.read ? savedMeals(await change.records()) : [];
    const added = [];
    const alreadySaved = [];
    for (const meal of input.savedMeals) {
      const data = parsed(regularSchema, { kind: "regular", ...meal });
      const match = [...existing, ...added].find((m) => sameMeal(m, data));
      if (match) {
        alreadySaved.push(match);
        continue;
      }
      const saved = await change.save(created(data));
      if (saved) added.push(savedMealView(saved));
    }
    return {
      full: access.read
        ? {
            added,
            alreadySaved,
            savedMeals: savedMeals(await change.records()),
          }
        : { added },
      receipt: { added },
    };
  });
}

export function updateSavedMeal(
  owner: string,
  access: AgentAccess,
  input: {
    requestId: string;
    id: string;
    revision: number;
    name?: string;
    calories?: number;
    protein?: number;
  },
) {
  return once(owner, access, "update_saved_meal", input, async (change) => {
    const record = find(account(await change.records()), access, input, [
      "regular",
    ]);
    if (record.data.kind !== "regular")
      throw new Error("Expected a saved meal.");
    const data = parsed(regularSchema, {
      ...record.data,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.calories === undefined ? {} : { calories: input.calories }),
      ...(input.protein === undefined ? {} : { protein: input.protein }),
    });
    const saved = await change.save(changed(record, input.revision, data));
    return {
      full: { updated: saved ? savedMealView(saved) : null },
      receipt: {
        updated: saved ? { id: saved.id, revision: saved.revision } : null,
      },
    };
  });
}
