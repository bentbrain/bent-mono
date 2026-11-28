import { displayLoad, loadWording, toKg, workoutSchema } from "@bent/fitness-contracts/domain";
import type { Settings, Workout } from "@bent/fitness-contracts/domain";

type Units = Settings["units"];
type SetEntry = Workout["exercises"][number]["sets"][number];

/** Text typed into a correction field, with the weight unit shown when it was typed. */
export type Typed = Record<string, { text: string; units: Units }>;
export type InputField = "loadKg" | "value" | "right" | "rir";

const fieldPattern = /^(\d+):(\d+):(loadKg|value|right|rir)$/;
const isLoad = (key: string) => key.endsWith(":loadKg");

export const fieldKey = (exercise: number, set: number, field: InputField) => `${exercise}:${set}:${field}`;
export const setKeys = (exercise: number, set: number) =>
  (["loadKg", "value", "right", "rir"] satisfies InputField[]).map((field) => fieldKey(exercise, set, field));

/** The saved value of a field as the editor displays it. */
function savedText(workout: Workout, key: string, units: Units) {
  if (key === "notes") return workout.notes;
  const match = fieldPattern.exec(key);
  const set = match ? workout.exercises[Number(match[1])]?.sets[Number(match[2])] : undefined;
  if (!match || !set) return undefined;
  if (match[3] === "loadKg") return String(displayLoad(set.loadKg, units));
  if (match[3] === "right") return set.right === null ? "" : String(set.right);
  if (match[3] === "rir") return String(set.rir);
  return String(set.value);
}

/** Typed text as it reads in the current units. */
function shownText(key: string, entry: Typed[string], units: Units) {
  if (!isLoad(key) || entry.units === units) return entry.text;
  const trimmed = entry.text.trim();
  const number = Number(trimmed);
  return trimmed && Number.isFinite(number) ? String(displayLoad(toKg(number, entry.units), units)) : entry.text;
}

/** The text a field shows: typed text, or the saved value. */
export function fieldText(workout: Workout, typed: Typed, key: string, units: Units) {
  const entry = typed[key];
  return entry ? shownText(key, entry, units) : (savedText(workout, key, units) ?? "");
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
  // A weight typed for an exercise that records none, such as a band exercise, has no field to apply to.
  if (!match || !exercise || !set || (field === "loadKg" && !loadWording(exercise.prescription, units).weighed)) return null;
  const prescription = exercise.prescription;
  const label = field === "loadKg" ? "weight" : field === "rir" ? "reps left" : prescription.mode === "seconds" ? "seconds" : "reps";
  const trimmed = text.trim().replace(",", ".");
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

export type CommitResult =
  | { status: "invalid"; errors: Record<string, string> }
  | { status: "problem"; message: string }
  | { status: "saved"; workout: Workout; done: string[] };

/**
 * Applies typed values to the draft. Weights apply in the units they were
 * typed in. Invalid text blocks the commit unless `dropInvalid` is set, and
 * the result must still be a valid workout.
 */
export function commitTyped(
  workout: Workout,
  typed: Typed,
  options: { keys?: string[]; change?: (workout: Workout) => Workout; dropInvalid?: boolean } = {},
): CommitResult {
  let next = workout;
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(typed)) {
    if (options.keys && !options.keys.includes(key)) continue;
    const result = applyText(next, key, entry.text, entry.units);
    if (typeof result === "string") {
      if (options.dropInvalid) done.push(key);
      else failed[key] = result;
      continue;
    }
    if (result) next = result;
    done.push(key);
  }
  if (Object.keys(failed).length) return { status: "invalid", errors: failed };
  if (options.change) next = options.change(next);
  const parsed = workoutSchema.safeParse(next);
  if (!parsed.success) return { status: "problem", message: parsed.error.issues[0]?.message ?? "Check your results." };
  return { status: "saved", workout: parsed.data, done };
}

/** Changes one set of the workout. */
export function changeSet(workout: Workout, exercise: number, set: number, change: Partial<SetEntry>): Workout {
  return {
    ...workout,
    exercises: workout.exercises.map((item, i) =>
      i !== exercise ? item : { ...item, sets: item.sets.map((value, j) => (j === set ? { ...value, ...change } : value)) },
    ),
  };
}

/** Removes keys from a record of typed values or errors. */
export function without<T>(values: Record<string, T>, keys: string[]) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key)));
}
