import { z } from "zod";
import {
  catalogue,
  catalogueEntry,
  equipmentTypes,
  loadTypes,
} from "./catalogue";
import type { LoadType } from "./catalogue";

const finite = z.number().finite().nonnegative();
/** The heaviest load a set records, in kg. */
export const maximumLoadKg = 1000;
const daySchema = z.iso.date();
const label = z.string().trim().min(1).max(160);
const identifier = z.string().uuid();
export const experienceLevels = ["new", "returning", "experienced"] as const;
const exerciseSchema = z
  .object({
    id: label,
    name: label,
    sets: z.number().int().min(1).max(8),
    min: finite.max(600),
    max: finite.max(600),
    mode: z.enum(["reps", "seconds"]),
    side: z.boolean(),
    rest: z.number().int().min(15).max(600),
    /** Set for exercises outside the catalogue; catalogue entries carry their own. */
    load: z.enum(loadTypes).optional(),
  })
  .strict()
  .refine(
    (e) => e.max >= e.min && e.min > 0,
    "Use a positive ordered rep or time range.",
  );
export type Exercise = z.infer<typeof exerciseSchema>;
const routineSchema = z
  .object({
    id: identifier,
    name: label,
    exercises: z.array(exerciseSchema).min(1).max(15),
  })
  .strict();
export type Routine = z.infer<typeof routineSchema>;
export const settingsSchema = z
  .object({
    kind: z.literal("settings"),
    timezone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Choose an IANA timezone."),
    units: z.enum(["kg", "lb"]),
    calories: z.number().int().min(800).max(10000),
    protein: finite.min(20).max(400),
    age: z.number().int().min(16).max(120).nullable().default(null),
    heightCm: finite.min(80).max(250).nullable().default(null),
    goal: label,
    startDate: daySchema,
    introductionWeeks: z.number().int().min(0).max(8),
    schedule: z.array(z.enum(["strength", "run", "rest"])).length(7),
    dayPlans: z
      .record(
        daySchema,
        z
          .object({
            type: z.enum(["strength", "run", "rest"]),
            routine: routineSchema.nullable(),
          })
          .strict()
          .refine(
            (plan) =>
              plan.type === "strength"
                ? plan.routine !== null
                : plan.routine === null,
            "Strength days need a routine; runs and rest days do not.",
          ),
      )
      .refine(
        (value) => Object.keys(value).length <= 180,
        "Keep up to 180 dated plans. Reset older weeks to the repeating schedule.",
      )
      .optional(),
    equipment: z
      .array(
        z
          .object({ id: identifier, name: label, notes: z.string().max(500) })
          .strict(),
      )
      .max(40),
    dumbbellsKg: z.array(finite.positive().max(200)).max(60),
    routines: z.array(routineSchema).min(1).max(8),
    /** Training experience, used when planning. */
    experience: z.enum(experienceLevels).optional(),
    /** The time available for one strength session, in minutes. */
    sessionMinutes: z.number().int().min(10).max(240).optional(),
    /** Injuries, conditions or movements to avoid, in the owner's words. */
    limitations: z.string().trim().max(1000).optional(),
    /** The kinds of equipment the account trains with. */
    availableEquipment: z
      .array(z.enum(equipmentTypes))
      .max(equipmentTypes.length)
      .refine(
        (items) => new Set(items).size === items.length,
        "List each kind of equipment once.",
      )
      .optional(),
    kettlebellsKg: z.array(finite.positive().max(100)).max(40).optional(),
    /** The smallest weight step for barbells, machines and cables. */
    incrementsKg: z
      .object({
        barbell: finite.positive().max(50),
        machine: finite.positive().max(50),
        cable: finite.positive().max(50),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
const setSchema = z
  .object({
    loadKg: finite.max(maximumLoadKg),
    value: finite.max(600),
    right: finite.max(600).nullable(),
    done: z.boolean(),
    skipped: z.boolean().default(false),
    rir: z.number().int().min(0).max(10),
    controlled: z.boolean(),
  })
  .strict();
export const workoutSchema = z
  .object({
    kind: z.literal("workout"),
    date: daySchema,
    routineId: identifier,
    name: label,
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    exercises: z
      .array(
        z
          .object({
            prescription: exerciseSchema,
            sets: z.array(setSchema).min(1).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(15),
    notes: z.string().max(2000),
    restUntil: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((w, ctx) => {
    for (const e of w.exercises) {
      if (e.sets.length !== e.prescription.sets)
        ctx.addIssue({
          code: "custom",
          message: "Set count must match the workout prescription.",
        });
      for (const s of e.sets) {
        if (s.done && s.skipped)
          ctx.addIssue({
            code: "custom",
            message: "A set can be completed or skipped, not both.",
          });
        if (
          e.prescription.mode === "reps" &&
          (!Number.isInteger(s.value) ||
            (s.right !== null && !Number.isInteger(s.right)))
        )
          ctx.addIssue({
            code: "custom",
            message: "Reps must be whole numbers.",
          });
        if (
          s.done &&
          (s.value <= 0 ||
            (e.prescription.side && (s.right === null || s.right <= 0)))
        )
          ctx.addIssue({
            code: "custom",
            message: "Enter a result for each completed set and both sides.",
          });
      }
    }
    if (
      w.finishedAt &&
      w.exercises.some((e) => e.sets.some((s) => !s.done && !s.skipped))
    )
      ctx.addIssue({
        code: "custom",
        message: "Complete or skip every set before finishing.",
      });
  });
export type Workout = z.infer<typeof workoutSchema>;
export const mealSchema = z
  .object({
    kind: z.literal("meal"),
    date: daySchema,
    name: label,
    calories: finite.max(10000),
    protein: finite.max(500),
  })
  .strict();
export const regularSchema = z
  .object({
    kind: z.literal("regular"),
    name: label,
    calories: finite.max(10000),
    protein: finite.max(500),
  })
  .strict();
export const weightSchema = z
  .object({
    kind: z.literal("weight"),
    date: daySchema,
    kg: finite.min(20).max(500),
  })
  .strict();
export const runSchema = z
  .object({
    kind: z.literal("run"),
    date: daySchema,
    minutes: finite.positive().max(1440),
    distanceKm: finite.max(500),
    notes: z.string().max(2000),
  })
  .strict();
const correctionSchema = z
  .object({
    kind: z.literal("workoutCorrection"),
    workoutId: identifier,
    replacement: workoutSchema.nullable(),
    reason: label,
  })
  .strict()
  .refine(
    (value) =>
      value.replacement === null || value.replacement.finishedAt !== null,
    "A correction must contain a completed workout.",
  );
const entitySchema = z.discriminatedUnion("kind", [
  settingsSchema,
  workoutSchema,
  mealSchema,
  regularSchema,
  weightSchema,
  runSchema,
  correctionSchema,
]);
export type Entity = z.infer<typeof entitySchema>;
export const recordSchema = z.object({
  id: identifier,
  revision: z.number().int().positive(),
  data: entitySchema,
  updatedAt: z.string(),
});
export type RecordEntry = z.infer<typeof recordSchema>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
/** Compares record data regardless of property order. */
export function sameData(a: unknown, b: unknown) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export const mutationSchema = z
  .object({
    operationId: identifier,
    id: identifier,
    revision: z.number().int().nonnegative(),
    data: entitySchema.nullable(),
  })
  .strict();
export type Mutation = z.infer<typeof mutationSchema>;
export const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), record: recordSchema.nullable() }),
  z.object({ status: z.literal("conflict"), current: recordSchema.nullable() }),
]);
export type SaveResult = z.infer<typeof resultSchema>;
export const settingsId = "00000000-0000-4000-8000-000000000001";
/** Catalogue prescriptions. Their load type comes from the catalogue entry. */
export const exercises: Exercise[] = catalogue.map(
  ({ id, name, sets, min, max, side, rest, mode }) => ({
    id,
    name,
    sets,
    min,
    max,
    side,
    rest,
    mode,
  }),
);
/**
 * How an exercise's load is recorded. The catalogue decides for its own
 * exercises; others use their `load`, or dumbbells when it is not set.
 */
export function loadTypeOf(exercise: Pick<Exercise, "id" | "load">): LoadType {
  return catalogueEntry(exercise.id)?.load ?? exercise.load ?? "dumbbell";
}
/** Default smallest steps, in kg, for loads that add plates or pins. */
export const defaultIncrementsKg = { barbell: 2.5, machine: 5, cable: 2.5 };
function selection(ids: string[]) {
  return ids.map((id) => {
    const e = exercises.find((e) => e.id === id);
    if (!e) throw new Error("Unknown exercise");
    return { ...e };
  });
}
export function defaultSettings(date: string, timezone: string): Settings {
  return settingsSchema.parse({
    kind: "settings",
    timezone,
    units: "kg",
    calories: 2400,
    protein: 120,
    goal: "Build strength consistently",
    startDate: date,
    introductionWeeks: 2,
    dayPlans: {},
    schedule: [
      "strength",
      "run",
      "strength",
      "rest",
      "strength",
      "run",
      "rest",
    ],
    equipment: [],
    dumbbellsKg: [],
    routines: [
      {
        id: "00000000-0000-4000-8000-00000000000a",
        name: "Strength A",
        exercises: selection([
          "squat",
          "bench",
          "row",
          "rdl",
          "raise",
          "plank",
        ]),
      },
      {
        id: "00000000-0000-4000-8000-00000000000b",
        name: "Strength B",
        exercises: selection([
          "split",
          "incline",
          "row",
          "rdl",
          "press",
          "curl",
        ]),
      },
    ],
  });
}
export function localDate(timezone: string, at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
export function addDays(date: string, days: number) {
  return new Date(Date.parse(date + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
/** The Monday that starts the week containing `date`. */
export function mondayOf(date: string) {
  return addDays(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7));
}
function dayDifference(a: string, b: string) {
  return Math.round(
    (Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 86400000,
  );
}
function repeatingPlan(settings: Settings, date: string) {
  const days = dayDifference(date, settings.startDate);
  const weekday = (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7;
  const type = settings.schedule[weekday] ?? "rest";
  let ordinal = 0;
  // Count a repeating weekly schedule in O(7), including dates before the anchor.
  const startWeekday =
    (new Date(settings.startDate + "T12:00:00Z").getUTCDay() + 6) % 7;
  const weekly = settings.schedule.filter((d) => d === "strength").length;
  const weeks = Math.floor(days / 7);
  ordinal = weeks * weekly;
  for (let i = 0; i < days - weeks * 7; i++)
    if (settings.schedule[(startWeekday + i) % 7] === "strength") ordinal++;
  const routine =
    settings.routines[
      ((ordinal % settings.routines.length) + settings.routines.length) %
        settings.routines.length
    ];
  return {
    type,
    routine,
    intro: days >= 0 && days < settings.introductionWeeks * 7,
  };
}
/** Date-specific plans preserve routine identity without shifting later weeks. */
export function scheduled(settings: Settings, date: string) {
  const repeating = repeatingPlan(settings, date);
  const override = settings.dayPlans?.[date];
  return override
    ? {
        ...repeating,
        type: override.type,
        routine: override.routine ?? undefined,
      }
    : repeating;
}

/** Swap planned sessions only. Activity records and the repeating week stay unchanged. */
export function reorganiseDays(
  settings: Settings,
  from: string,
  to: string,
  today: string,
  records: RecordEntry[],
): Settings {
  daySchema.parse(from);
  daySchema.parse(to);
  daySchema.parse(today);
  if (from === to) throw Error("Choose a different day.");
  if (from < today || to < today)
    throw Error("Choose today or an upcoming day.");
  if (mondayOf(from) !== mondayOf(to))
    throw Error("Choose a day in the same week.");
  if (
    records.some(
      ({ data }) =>
        (data.kind === "workout" || data.kind === "run") &&
        (data.date === from || data.date === to),
    )
  )
    throw Error(
      "A session has already been recorded or started on one of these days. Choose another day.",
    );
  const source = scheduled(settings, from);
  const destination = scheduled(settings, to);
  if (source.type === "rest")
    throw Error("Choose a planned workout or run to move.");
  return settingsSchema.parse({
    ...settings,
    dayPlans: {
      ...settings.dayPlans,
      [from]: {
        type: destination.type,
        routine:
          destination.type === "strength"
            ? (destination.routine ?? null)
            : null,
      },
      [to]: {
        type: source.type,
        routine: source.type === "strength" ? (source.routine ?? null) : null,
      },
    },
  });
}

export type DayActivity = { strength: boolean; run: boolean };
/** Completed training per date, using corrected workout results. */
export function completedActivity(records: RecordEntry[]) {
  const days = new Map<string, DayActivity>();
  for (const record of trainingRecords(records)) {
    const data = record.data;
    if (data.kind !== "run" && !(data.kind === "workout" && data.finishedAt))
      continue;
    const day = days.get(data.date) ?? { strength: false, run: false };
    if (data.kind === "run") day.run = true;
    else day.strength = true;
    days.set(data.date, day);
  }
  return days;
}
export function nextSession(
  settings: Settings,
  date: string,
  records: RecordEntry[],
) {
  const activity = completedActivity(records);
  for (let offset = 0; offset < 14; offset++) {
    const candidate = addDays(date, offset);
    const plan = scheduled(settings, candidate);
    if (plan.type === "rest") continue;
    const day = activity.get(candidate);
    const completed =
      plan.type === "strength"
        ? day?.strength
        : plan.type === "run" && day?.run;
    if (!completed) return { date: candidate, plan };
  }
  return null;
}
export function effectivePrescription(
  exercise: Exercise,
  intro: boolean,
): Exercise {
  return {
    ...exercise,
    sets: intro ? Math.min(2, exercise.sets) : exercise.sets,
  };
}
export function createWorkout(
  settings: Settings,
  routine: Routine,
  date: string,
  intro: boolean,
  history: RecordEntry[],
): Workout {
  return workoutSchema.parse({
    kind: "workout",
    date,
    routineId: routine.id,
    name: routine.name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    notes: "",
    restUntil: null,
    exercises: routine.exercises.map((p) => {
      const prescription = effectivePrescription(p, intro);
      const previous = lastExercise(history, p.id);
      const suggestion = progression(p, previous, settings);
      return {
        prescription,
        sets: Array.from({ length: prescription.sets }, () => ({
          loadKg: suggestion.loadKg ?? 0,
          value: p.min,
          right: p.side ? p.min : null,
          done: false,
          skipped: false,
          rir: 3,
          controlled: true,
        })),
      };
    }),
  });
}
export function lastExercise(history: RecordEntry[], id: string) {
  return trainingRecords(history)
    .flatMap((r) =>
      r.data.kind === "workout" && r.data.finishedAt ? [r.data] : [],
    )
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .flatMap((workout) => workout.exercises)
    .find((e) => e.prescription.id === id && e.sets.some((set) => set.done));
}
/** The weights an account can load, from its settings. */
export type LoadOptions = Pick<Settings, "dumbbellsKg"> &
  Partial<Pick<Settings, "kettlebellsKg" | "incrementsKg">>;
const nextAvailable = (available: number[] | undefined, load: number) =>
  [...new Set(available ?? [])].sort((a, b) => a - b).find((v) => v > load);
/**
 * The load and advice for an exercise's next session. A weight increase
 * needs every prescribed set done with control, at least two reps in
 * reserve and the top of the range on each side, at one load.
 */
export function progression(
  p: Exercise,
  previous: Workout["exercises"][number] | undefined,
  options: LoadOptions,
) {
  const type = loadTypeOf(p);
  // A weight recorded another way, such as on a machine, says nothing about
  // the load for this one.
  if (!previous || loadTypeOf(previous.prescription) !== type)
    return { text: "Start light. Keep 2–3 reps in reserve.", loadKg: null };
  const load =
    previous.sets.find((set) => set.done)?.loadKg ??
    previous.sets[0]?.loadKg ??
    0;
  const eligible =
    previous.prescription.mode === p.mode &&
    previous.prescription.side === p.side &&
    previous.sets.length >= p.sets &&
    previous.sets.every(
      (s) =>
        s.done &&
        s.controlled &&
        s.rir >= 2 &&
        s.value >= p.max &&
        (!p.side || (s.right ?? 0) >= p.max) &&
        s.loadKg === load,
    );
  // Timed sets record no weight: the logger has no weight field for them.
  if (p.mode === "seconds")
    return {
      text: eligible
        ? p.id === "plank"
          ? "Keep a straight line. Try a slightly harder plank variation."
          : "Top of range reached. Try a slightly harder variation."
        : "Build controlled hold time within the range.",
      loadKg: 0,
    };
  const repeat = {
    text: "Repeat the load and build controlled reps within the range.",
    loadKg: load,
  };
  if (!eligible) return repeat;
  const restart = `Return to ${p.min} reps; keep this load if the jump affects form.`;
  if (type === "dumbbell" || type === "kettlebell") {
    const item = type === "dumbbell" ? "dumbbell" : "kettlebell";
    const next = nextAvailable(
      type === "dumbbell" ? options.dumbbellsKg : options.kettlebellsKg,
      load,
    );
    return next
      ? { text: `Try the next available ${item}. ${restart}`, loadKg: next }
      : {
          text: `Top of range reached. Add an available ${item} size in Settings before increasing.`,
          loadKg: load,
        };
  }
  if (type === "barbell" || type === "machine" || type === "cable") {
    const step = options.incrementsKg?.[type] ?? defaultIncrementsKg[type];
    const next = Math.round((load + step) * 1000) / 1000;
    return next > maximumLoadKg
      ? {
          text: `Top of range reached at the heaviest load Fitness records. Keep ${p.max} reps with control.`,
          loadKg: load,
        }
      : { text: `Try the next weight up. ${restart}`, loadKg: next };
  }
  if (type === "band")
    return {
      text: `Top of range reached. Use a stronger band and return to ${p.min} reps.`,
      loadKg: 0,
    };
  return {
    text: "Top of range reached. Add a little weight or move to a harder variation.",
    loadKg: load,
  };
}
export function displayLoad(kg: number, units: Settings["units"]) {
  return Math.round((units === "lb" ? kg * 2.2046226218 : kg) * 100) / 100;
}
export function toKg(value: number, units: Settings["units"]) {
  return units === "lb" ? value / 2.2046226218 : value;
}
export function totals(records: RecordEntry[], date: string) {
  return records.reduce(
    (a, r) =>
      r.data.kind === "meal" && r.data.date === date
        ? {
            calories: a.calories + r.data.calories,
            protein: a.protein + r.data.protein,
          }
        : a,
    { calories: 0, protein: 0 },
  );
}

function dateParts(date: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).formatToParts(new Date(date + "T12:00:00Z"));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    weekday: part("weekday"),
    day: part("day"),
    month: part("month"),
    year: part("year"),
  };
}
/** "Fri 20 Nov 2026" */
export function formatDate(date: string) {
  const { weekday, day, month, year } = dateParts(date);
  return `${weekday} ${day} ${month} ${year}`;
}
/** "Fri 20 Nov" */
export function formatShortDate(date: string) {
  const { weekday, day, month } = dateParts(date);
  return `${weekday} ${day} ${month}`;
}
/** Omits the date from a URL when it is today, so saved links stay current. */
export function dateSearch(date: string, today: string) {
  return { date: date === today ? undefined : date };
}
export function sessionMinutes(routine: Routine, intro: boolean) {
  const seconds = routine.exercises.reduce((total, item) => {
    const e = effectivePrescription(item, intro);
    const work = e.mode === "seconds" ? e.max : e.max * 3 * (e.side ? 2 : 1);
    return total + e.sets * work + Math.max(0, e.sets - 1) * e.rest + 60;
  }, 300);
  return Math.ceil(seconds / 300) * 5;
}
export function setResult(
  set: Workout["exercises"][number]["sets"][number],
  exercise: Exercise,
  units: Settings["units"],
) {
  if (set.skipped) return "Skipped";
  if (exercise.mode === "seconds")
    return exercise.side
      ? `${set.value} s left / ${set.right ?? 0} s right`
      : `${set.value} seconds`;
  const load = `${displayLoad(set.loadKg, units)} ${units}`;
  return exercise.side
    ? `${load} × ${set.value} left / ${set.right ?? 0} right`
    : `${load} × ${set.value} reps`;
}

/**
 * Projects workout corrections over the original completed workouts.
 * Originals stay unchanged in storage and exports; history, schedules and
 * weight suggestions use the projected results.
 */
export function trainingRecords(records: RecordEntry[]): RecordEntry[] {
  const corrections = new Map<string, Workout | null>();
  for (const record of records)
    if (record.data.kind === "workoutCorrection")
      corrections.set(record.data.workoutId, record.data.replacement);
  return records.flatMap((record) => {
    if (record.data.kind === "workoutCorrection") return [];
    if (record.data.kind !== "workout" || !corrections.has(record.id))
      return [record];
    const replacement = corrections.get(record.id);
    return replacement ? [{ ...record, data: replacement }] : [];
  });
}

const prescriptionKeys = [
  "id",
  "name",
  "sets",
  "min",
  "max",
  "mode",
  "side",
  "rest",
  "load",
] satisfies (keyof Exercise)[];
/**
 * A correction can change a completed workout's date, set results and notes.
 * Returns a reason when the replacement changes anything else.
 */
export function correctionProblem(original: Workout, replacement: Workout) {
  const sameSession =
    replacement.routineId === original.routineId &&
    replacement.name === original.name &&
    replacement.startedAt === original.startedAt &&
    replacement.finishedAt === original.finishedAt &&
    replacement.restUntil === null &&
    replacement.exercises.length === original.exercises.length &&
    replacement.exercises.every((exercise, index) => {
      const before = original.exercises[index]?.prescription;
      return (
        before !== undefined &&
        prescriptionKeys.every(
          (key) => exercise.prescription[key] === before[key],
        )
      );
    });
  return sameSession
    ? null
    : "A correction can change the workout date, set results and notes only.";
}

/**
 * Builds the completed workout a correction saves from the edited results.
 * Returns a message instead when a set still needs Done or Skip, or when the
 * edit changes more than a correction can.
 */
export function correctionReplacement(
  original: Workout,
  draft: Workout,
  date: string,
): { replacement: Workout } | { problem: string } {
  const candidate = {
    ...draft,
    date,
    finishedAt: original.finishedAt,
    restUntil: null,
  };
  for (const exercise of candidate.exercises) {
    const index = exercise.sets.findIndex((set) => !set.done && !set.skipped);
    if (index >= 0)
      return {
        problem: `Mark ${exercise.prescription.name} set ${index + 1} Done or Skip it before saving the correction.`,
      };
  }
  const parsed = workoutSchema.safeParse(candidate);
  if (!parsed.success)
    return {
      problem:
        parsed.error.issues[0]?.message ?? "Check the corrected results.",
    };
  const problem = correctionProblem(original, parsed.data);
  return problem ? { problem } : { replacement: parsed.data };
}
