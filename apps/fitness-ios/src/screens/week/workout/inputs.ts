import { z } from "zod";
import { displayLoad, toKg, workoutSchema } from "@bent/fitness-contracts/domain";
import type { Exercise, Settings, Workout } from "@bent/fitness-contracts/domain";

/*
 * Typed workout values. Text typed into a set field stays on this iPhone
 * until the person leaves the set, presses a set action or finishes. It is
 * kept in the per-device drafts table, so it survives leaving the screen,
 * closing the app and restarting the iPhone.
 */

export type Units = Settings["units"];

/**
 * Text typed into a workout field. `units` is the weight unit shown when the
 * text was typed. `base` is the saved value the text started from, with
 * weights in kilograms, or null when the starting value is unknown.
 */
export type Buffered = {
  text: string;
  base: string | null;
  units: Units | null;
};
export type InputBuffer = Record<string, Buffered>;

const bufferSchema = z.record(
  z.string().max(40),
  z.object({
    text: z.string().max(2000),
    base: z.string().max(2000).nullable(),
    units: z.enum(["kg", "lb"]).nullable(),
  }),
);
/** Typed values kept before units were recorded with them. */
const legacyBufferSchema = z.record(z.string().max(40), z.object({ text: z.string().max(2000), base: z.string().max(2000) }));

const fieldPattern = /^(\d+):(\d+):(loadKg|value|right|rir)$/;
const isLoad = (key: string) => key.endsWith(":loadKg");

export type NumberField = "loadKg" | "value" | "right" | "rir";
export const fieldKey = (exercise: number, set: number, field: NumberField) => `${exercise}:${set}:${field}`;
export const setKeys = (exercise: number, set: number) =>
  (["loadKg", "value", "right", "rir"] satisfies NumberField[]).map((field) => fieldKey(exercise, set, field));

/** The saved value of a field as the editor displays it. */
export function savedText(workout: Workout, key: string, units: Units) {
  if (key === "notes") return workout.notes;
  const match = fieldPattern.exec(key);
  const set = match ? workout.exercises[Number(match[1])]?.sets[Number(match[2])] : undefined;
  if (!match || !set) return undefined;
  if (match[3] === "loadKg") return String(displayLoad(set.loadKg, units));
  if (match[3] === "right") return set.right === null ? "" : String(set.right);
  if (match[3] === "rir") return String(set.rir);
  return String(set.value);
}

/** The saved value of a field, with weights in kilograms at full precision. */
export function savedBase(workout: Workout, key: string) {
  const match = fieldPattern.exec(key);
  if (match?.[3] !== "loadKg") return savedText(workout, key, "kg");
  const set = workout.exercises[Number(match[1])]?.sets[Number(match[2])];
  return set ? String(set.loadKg) : undefined;
}

/** Typed text as it reads in the current units. */
export function shownText(key: string, entry: Buffered, units: Units) {
  if (!isLoad(key) || !entry.units || entry.units === units) return entry.text;
  const trimmed = entry.text.trim();
  const number = Number(trimmed);
  return trimmed && Number.isFinite(number) ? String(displayLoad(toKg(number, entry.units), units)) : entry.text;
}

/**
 * Applies typed text to a workout. Returns the updated workout, a message for
 * invalid text, or null when the field no longer exists in this workout.
 */
export function applyText(workout: Workout, key: string, text: string, units: Units): Workout | string | null {
  if (key === "notes") return { ...workout, notes: text.slice(0, 2000) };
  const match = fieldPattern.exec(key);
  const exerciseIndex = Number(match?.[1]);
  const setIndex = Number(match?.[2]);
  const field = match?.[3];
  const exercise = workout.exercises[exerciseIndex];
  const set = exercise?.sets[setIndex];
  if (!match || !exercise || !set) return null;
  const prescription = exercise.prescription;
  const label = field === "loadKg" ? "weight" : field === "rir" ? "reps left" : prescription.mode === "seconds" ? "seconds" : "reps";
  const trimmed = text.trim();
  const number = Number(trimmed);
  if (!trimmed || !Number.isFinite(number) || number < 0) return `Enter ${label} as a number of 0 or more.`;
  const next = { ...set };
  if (field === "loadKg") {
    next.loadKg = toKg(number, units);
    if (next.loadKg > 1000) return "Enter a weight up to 1000 kg.";
  } else if (field === "rir") {
    if (!Number.isInteger(number) || number > 10) return "Enter reps left as a whole number from 0 to 10.";
    next.rir = number;
  } else {
    if (number > 600) return `Enter ${label} up to 600.`;
    if (prescription.mode === "reps" && !Number.isInteger(number)) return "Enter reps as a whole number.";
    if (field === "right") next.right = number;
    else next.value = number;
  }
  return {
    ...workout,
    exercises: workout.exercises.map((item, i) =>
      i === exerciseIndex ? { ...item, sets: item.sets.map((value, j) => (j === setIndex ? next : value)) } : item,
    ),
  };
}

/**
 * Moves values kept without units to the current format. Their weights have
 * an unknown starting point, so they wait for the person to confirm them.
 */
export function migrateLegacy(legacy: Record<string, { text: string; base: string }>): InputBuffer {
  return Object.fromEntries(
    Object.entries(legacy).map(([key, entry]) => [
      key,
      isLoad(key) ? { text: entry.text, base: null, units: null } : { text: entry.text, base: entry.base, units: null },
    ]),
  );
}

/** Whether a background save keeps the value for the person to review. */
export function holdInBackground(workout: Workout, key: string, entry: Buffered) {
  return entry.base === null || savedBase(workout, key) !== entry.base;
}

/** Weights kept without units, waiting for the person to confirm them. */
export function unconfirmedKeys(buffer: InputBuffer) {
  return Object.entries(buffer)
    .filter(([, entry]) => entry.base === null)
    .map(([key]) => key);
}

/** Per-device draft storage for one account: get, set and remove by key. */
export type DraftBackend = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

/** The draft keys for a workout's typed values, current and earlier format. */
export function workoutInputKeys(workoutId: string) {
  return { current: `workout-inputs:v2:${workoutId}`, legacy: `workout-inputs:v1:${workoutId}` };
}

function parse<T>(raw: string | null, schema: z.ZodType<T>) {
  if (raw === null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The typed values for one workout on this iPhone. Values kept in the
 * earlier format are read once and move to the current key on the next
 * successful write. An unreadable entry is ignored rather than blocking
 * the editor.
 */
export class WorkoutInputStore {
  readonly buffer: InputBuffer;
  private legacyPending: boolean;
  private readonly keys: { current: string; legacy: string };
  constructor(
    private backend: DraftBackend,
    workoutId: string,
  ) {
    this.keys = workoutInputKeys(workoutId);
    const current = parse(backend.get(this.keys.current), bufferSchema);
    const legacy = parse(backend.get(this.keys.legacy), legacyBufferSchema);
    this.legacyPending = legacy !== undefined;
    this.buffer = { ...(legacy ? migrateLegacy(legacy) : {}), ...current };
  }
  /** Replaces the kept values. Throws when the iPhone's storage refuses the write. */
  write(next: InputBuffer) {
    if (Object.keys(next).length) this.backend.set(this.keys.current, JSON.stringify(next));
    else this.backend.remove(this.keys.current);
    if (this.legacyPending) {
      this.backend.remove(this.keys.legacy);
      this.legacyPending = false;
    }
  }
  /** Removes every kept value for this workout. */
  clear() {
    this.backend.remove(this.keys.current);
    this.backend.remove(this.keys.legacy);
    this.legacyPending = false;
  }
}

/** Removes a workout's typed values, for example once it is finished. */
export function forgetWorkoutInputs(backend: DraftBackend, workoutId: string) {
  const keys = workoutInputKeys(workoutId);
  backend.remove(keys.current);
  backend.remove(keys.legacy);
}

export type CommitOptions = {
  /** Keys to save. Every buffered key is saved when omitted. */
  keys?: string[];
  change?: (workout: Workout) => Workout;
  /** Save valid fields and keep invalid or changed ones for the person to review. */
  background?: boolean;
  /** Drop invalid text in the selected keys instead of blocking the save. */
  dropInvalid?: boolean;
  /** Where to show a message when the save is blocked. */
  place?: string;
};

export type CommitPlan =
  /** Typed text is invalid; nothing is saved. */
  | { status: "invalid"; failed: Record<string, string>; kept: string[]; done: string[] }
  /** The resulting workout breaks a workout rule; nothing is saved. */
  | { status: "rejected"; message: string; failed: Record<string, string>; kept: string[]; done: string[] }
  /** The workout to save, and whether it differs from the saved one. */
  | { status: "ready"; workout: Workout; changed: boolean; failed: Record<string, string>; kept: string[]; done: string[] };

/**
 * Works out what a save of typed values would do. `done` lists the keys the
 * save consumes, `failed` the keys with invalid text and `kept` the keys a
 * background save leaves for the person to review.
 */
export function planCommit(workout: Workout, buffer: InputBuffer, units: Units, options: CommitOptions = {}): CommitPlan {
  let next = workout;
  const done: string[] = [];
  const failed: Record<string, string> = {};
  const kept: string[] = [];
  for (const [key, entry] of Object.entries(buffer)) {
    if (options.keys && !options.keys.includes(key)) continue;
    // Background saves keep values whose starting point changed or is unknown.
    if (options.background && holdInBackground(workout, key, entry)) {
      kept.push(key);
      continue;
    }
    // Weights save in the units they were typed in. A value without
    // recorded units is saved in the units shown next to it.
    const result = applyText(next, key, entry.text, entry.units ?? units);
    if (typeof result === "string") {
      if (options.dropInvalid) done.push(key);
      else failed[key] = result;
      continue;
    }
    if (result) next = result;
    done.push(key);
  }
  if (!options.background && Object.keys(failed).length) return { status: "invalid", failed, kept, done };
  if (options.change) next = options.change(next);
  const parsed = workoutSchema.safeParse(next);
  if (!parsed.success)
    return { status: "rejected", message: parsed.error.issues[0]?.message ?? "Check your results.", failed, kept, done };
  return {
    status: "ready",
    workout: parsed.data,
    changed: JSON.stringify(parsed.data) !== JSON.stringify(workout),
    failed,
    kept,
    done,
  };
}

/** One number input in a set row. */
export type SetInput = {
  field: NumberField;
  /** The short heading above the input. */
  heading: string;
  /** What VoiceOver reads after the set name, such as "weight". */
  spoken: string;
  /** Whole numbers only, which shows the number pad without a decimal point. */
  integer: boolean;
};

/** The inputs a set of this exercise records, in display order. */
export function setInputs(prescription: Exercise, units: Units): SetInput[] {
  const seconds = prescription.mode === "seconds";
  const amount = seconds ? "seconds" : "reps";
  const inputs: SetInput[] = [];
  if (!seconds) inputs.push({ field: "loadKg", heading: `${units} / dumbbell`, spoken: "weight", integer: false });
  inputs.push({
    field: "value",
    heading: seconds ? (prescription.side ? "Left seconds" : "Seconds") : prescription.side ? "Left reps" : "Reps",
    spoken: amount,
    integer: !seconds,
  });
  if (prescription.side)
    inputs.push({ field: "right", heading: seconds ? "Right seconds" : "Right reps", spoken: `right ${amount}`, integer: !seconds });
  if (!seconds) inputs.push({ field: "rir", heading: "Reps left", spoken: "reps in reserve", integer: true });
  return inputs;
}
