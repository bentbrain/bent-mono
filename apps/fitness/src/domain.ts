import { z } from "zod";

const finite = z.number().finite().nonnegative();
const daySchema = z.iso.date();
const label = z.string().trim().min(1).max(160);
const identifier = z.string().uuid();
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
    equipment: z
      .array(
        z
          .object({ id: identifier, name: label, notes: z.string().max(500) })
          .strict(),
      )
      .max(40),
    dumbbellsKg: z.array(finite.positive().max(200)).max(60),
    routines: z.array(routineSchema).min(1).max(8),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
const setSchema = z
  .object({
    loadKg: finite.max(1000),
    value: finite.max(600),
    right: finite.max(600).nullable(),
    done: z.boolean(),
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
    if (w.finishedAt && w.exercises.some((e) => e.sets.some((s) => !s.done)))
      ctx.addIssue({
        code: "custom",
        message: "Complete every set before finishing.",
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
const entitySchema = z.discriminatedUnion("kind", [
  settingsSchema,
  workoutSchema,
  mealSchema,
  regularSchema,
  weightSchema,
  runSchema,
]);
export type Entity = z.infer<typeof entitySchema>;
export const recordSchema = z.object({
  id: identifier,
  revision: z.number().int().positive(),
  data: entitySchema,
  updatedAt: z.string(),
});
export type RecordEntry = z.infer<typeof recordSchema>;
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
const makeExercise = (
  id: string,
  name: string,
  sets: number,
  min: number,
  max: number,
  side = false,
  rest = 120,
  mode: Exercise["mode"] = "reps",
): Exercise => ({ id, name, sets, min, max, side, rest, mode });
export const exercises = [
  makeExercise("squat", "Goblet squat", 3, 8, 12),
  makeExercise("bench", "Flat dumbbell bench press", 3, 8, 12),
  makeExercise("row", "Supported one-arm row", 3, 10, 15, true),
  makeExercise("rdl", "Dumbbell Romanian deadlift", 3, 8, 12),
  makeExercise("raise", "Lateral raise", 2, 12, 20, false, 75),
  makeExercise("plank", "Forearm plank", 2, 20, 40, false, 75, "seconds"),
  makeExercise("split", "Stationary split squat", 3, 8, 12, true),
  makeExercise("incline", "Low-incline dumbbell press", 3, 8, 12),
  makeExercise("press", "Seated dumbbell shoulder press", 2, 8, 12),
  makeExercise("curl", "Hammer curl", 2, 10, 15, false, 75),
];
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
function dayDifference(a: string, b: string) {
  return Math.round(
    (Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 86400000,
  );
}
export function scheduled(settings: Settings, date: string) {
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
      const prescription = { ...p, sets: intro ? Math.min(2, p.sets) : p.sets };
      const previous = lastExercise(history, p.id);
      const suggestion = progression(p, previous, settings.dumbbellsKg);
      return {
        prescription,
        sets: Array.from({ length: prescription.sets }, () => ({
          loadKg: suggestion.loadKg ?? 0,
          value: p.min,
          right: p.side ? p.min : null,
          done: false,
          rir: 3,
          controlled: true,
        })),
      };
    }),
  });
}
export function lastExercise(history: RecordEntry[], id: string) {
  return history
    .filter((r) => r.data.kind === "workout" && r.data.finishedAt)
    .sort((a, b) =>
      b.data.kind === "workout" && a.data.kind === "workout"
        ? (b.data.finishedAt ?? "").localeCompare(a.data.finishedAt ?? "")
        : 0,
    )
    .flatMap((r) => (r.data.kind === "workout" ? r.data.exercises : []))
    .find((e) => e.prescription.id === id);
}
export function progression(
  p: Exercise,
  previous: Workout["exercises"][number] | undefined,
  available: number[],
) {
  if (!previous)
    return { text: "Start light. Keep 2–3 reps in reserve.", loadKg: null };
  const load = previous.sets[0]?.loadKg ?? 0;
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
  if (p.mode === "seconds")
    return {
      text: eligible
        ? "Keep a straight line. Try a slightly harder plank variation."
        : "Build controlled hold time within the range.",
      loadKg: 0,
    };
  const next = [...new Set(available)]
    .sort((a, b) => a - b)
    .find((v) => v > load);
  return {
    text: eligible
      ? next
        ? `Try the next available dumbbell. Return to ${p.min} reps; keep this load if the jump affects form.`
        : "Top of range reached. Add an available dumbbell size in Settings before increasing."
      : "Repeat the load and build controlled reps within the range.",
    loadKg: eligible && next ? next : load,
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
