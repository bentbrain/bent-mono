import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { displayLoad, toKg, workoutSchema } from "../domain";
import type { Settings, Workout } from "../domain";

type Units = Settings["units"];
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
type InputBuffer = Record<string, Buffered>;
const bufferSchema = z.record(
  z.string().max(40),
  z.object({
    text: z.string().max(2000),
    base: z.string().max(2000).nullable(),
    units: z.enum(["kg", "lb"]).nullable(),
  }),
);
/** Typed values kept before units were recorded with them. */
const legacyBufferSchema = z.record(
  z.string().max(40),
  z.object({ text: z.string().max(2000), base: z.string().max(2000) }),
);
const fieldPattern = /^(\d+):(\d+):(loadKg|value|right|rir)$/;
const isLoad = (key: string) => key.endsWith(":loadKg");
export type NumberField = "loadKg" | "value" | "right" | "rir";
export const fieldKey = (exercise: number, set: number, field: NumberField) =>
  `${exercise}:${set}:${field}`;
export const setKeys = (exercise: number, set: number) =>
  (["loadKg", "value", "right", "rir"] satisfies NumberField[]).map((field) =>
    fieldKey(exercise, set, field),
  );

/** The saved value of a field as the editor displays it. */
export function savedText(
  workout: Workout,
  key: string,
  units: Settings["units"],
) {
  if (key === "notes") return workout.notes;
  const match = fieldPattern.exec(key);
  const set = match
    ? workout.exercises[Number(match[1])]?.sets[Number(match[2])]
    : undefined;
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
  return trimmed && Number.isFinite(number)
    ? String(displayLoad(toKg(number, entry.units), units))
    : entry.text;
}

/**
 * Applies typed text to a workout. Returns the updated workout, a message for
 * invalid text, or null when the field no longer exists in this workout.
 */
export function applyText(
  workout: Workout,
  key: string,
  text: string,
  units: Settings["units"],
): Workout | string | null {
  if (key === "notes") return { ...workout, notes: text.slice(0, 2000) };
  const match = fieldPattern.exec(key);
  const exerciseIndex = Number(match?.[1]);
  const setIndex = Number(match?.[2]);
  const field = match?.[3];
  const exercise = workout.exercises[exerciseIndex];
  const set = exercise?.sets[setIndex];
  if (!match || !exercise || !set) return null;
  const prescription = exercise.prescription;
  const label =
    field === "loadKg"
      ? "weight"
      : field === "rir"
        ? "reps left"
        : prescription.mode === "seconds"
          ? "seconds"
          : "reps";
  const trimmed = text.trim();
  const number = Number(trimmed);
  if (!trimmed || !Number.isFinite(number) || number < 0)
    return `Enter ${label} as a number of 0 or more.`;
  const next = { ...set };
  if (field === "loadKg") {
    next.loadKg = toKg(number, units);
    if (next.loadKg > 1000) return "Enter a weight up to 1000 kg.";
  } else if (field === "rir") {
    if (!Number.isInteger(number) || number > 10)
      return "Enter reps left as a whole number from 0 to 10.";
    next.rir = number;
  } else {
    if (number > 600) return `Enter ${label} up to 600.`;
    if (prescription.mode === "reps" && !Number.isInteger(number))
      return "Enter reps as a whole number.";
    if (field === "right") next.right = number;
    else next.value = number;
  }
  return {
    ...workout,
    exercises: workout.exercises.map((item, i) =>
      i === exerciseIndex
        ? {
            ...item,
            sets: item.sets.map((value, j) => (j === setIndex ? next : value)),
          }
        : item,
    ),
  };
}

function readStored<T>(key: string, schema: z.ZodType<T>) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : schema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Reads typed values kept on this device. Weights kept without their units
 * wait for the person to confirm them instead of saving in the background.
 */
function readBuffer(
  storageKey: string | null,
  legacyKey: string | null,
): { buffer: InputBuffer; migrated: boolean } {
  if (!storageKey) return { buffer: {}, migrated: false };
  const stored = readStored(storageKey, bufferSchema) ?? {};
  const legacy = legacyKey
    ? readStored(legacyKey, legacyBufferSchema)
    : undefined;
  if (!legacy) return { buffer: stored, migrated: false };
  return { buffer: { ...migrateLegacy(legacy), ...stored }, migrated: true };
}

/**
 * Moves values kept without units to the current format. Their weights have
 * an unknown starting point, so they wait for the person to confirm them.
 */
export function migrateLegacy(
  legacy: Record<string, { text: string; base: string }>,
): InputBuffer {
  return Object.fromEntries(
    Object.entries(legacy).map(([key, entry]) => [
      key,
      isLoad(key)
        ? { text: entry.text, base: null, units: null }
        : { text: entry.text, base: entry.base, units: null },
    ]),
  );
}

/** Whether a background save keeps the value for the person to review. */
export function holdInBackground(
  workout: Workout,
  key: string,
  entry: Buffered,
) {
  return entry.base === null || savedBase(workout, key) !== entry.base;
}

const sameEntry = (a: Buffered | undefined, b: Buffered | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.text === b.text &&
  a.base === b.base &&
  a.units === b.units;

/**
 * Merges one editor's buffer change into the values stored for the workout.
 * Other open tabs share the stored values, so an editor writes only the
 * fields it changed and removes a field only while it still holds the value
 * this editor typed. `ownAll` writes every field the editor holds, for values
 * moving from an earlier storage key.
 */
export function mergeStored(
  stored: InputBuffer,
  previous: InputBuffer,
  next: InputBuffer,
  ownAll = false,
): InputBuffer {
  const merged = { ...stored };
  for (const [key, entry] of Object.entries(next))
    if (ownAll || !sameEntry(previous[key], entry)) merged[key] = entry;
  for (const key of Object.keys(previous))
    if (!(key in next) && sameEntry(merged[key], previous[key]))
      delete merged[key];
  return merged;
}

type CommitOptions = {
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

/**
 * Keeps typed workout values on the device until the person leaves the set,
 * presses a set action or finishes. Valid values are also saved when the page
 * is hidden, the editor closes or a recovered draft opens.
 */
export function useWorkoutInputs({
  workout,
  units,
  storageKey,
  legacyStorageKey = null,
  save,
}: {
  workout: Workout;
  units: Units;
  storageKey: string | null;
  /** An earlier storage key whose values move to `storageKey`. */
  legacyStorageKey?: string | null;
  save: (workout: Workout) => boolean;
}) {
  const [initial] = useState(() => readBuffer(storageKey, legacyStorageKey));
  const [buffer, setBuffer] = useState(initial.buffer);
  const legacyKept = useRef(initial.migrated);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [held, setHeld] = useState<string[]>([]);
  const [message, setMessage] = useState<{ place: string; text: string }>();
  const [storageError, setStorageError] = useState("");
  const latest = useRef({ workout, buffer, save, units });
  useLayoutEffect(() => {
    latest.current = { workout, buffer, save, units };
  });
  const write = useCallback(
    (next: InputBuffer, replace = false) => {
      const previous = latest.current.buffer;
      latest.current = { ...latest.current, buffer: next };
      setBuffer(next);
      if (!storageKey) return;
      try {
        const merged = replace
          ? next
          : mergeStored(
              readStored(storageKey, bufferSchema) ?? {},
              previous,
              next,
              legacyKept.current,
            );
        if (Object.keys(merged).length)
          localStorage.setItem(storageKey, JSON.stringify(merged));
        else localStorage.removeItem(storageKey);
        // The values now live under the current key.
        if (legacyKept.current && legacyStorageKey) {
          localStorage.removeItem(legacyStorageKey);
          legacyKept.current = false;
        }
        setStorageError("");
      } catch {
        setStorageError(
          "Typed values could not be kept on this device. Leave the field to save them to your account.",
        );
      }
    },
    [legacyStorageKey, storageKey],
  );
  const commit = useCallback(
    (options: CommitOptions = {}) => {
      const current = latest.current;
      let next = current.workout;
      const done: string[] = [];
      const failed: Record<string, string> = {};
      const kept: string[] = [];
      for (const [key, entry] of Object.entries(current.buffer)) {
        if (options.keys && !options.keys.includes(key)) continue;
        // Background saves keep values whose starting point changed or is unknown.
        if (
          options.background &&
          holdInBackground(current.workout, key, entry)
        ) {
          kept.push(key);
          continue;
        }
        // Weights save in the units they were typed in. A value without
        // recorded units is saved in the units shown next to it.
        const result = applyText(
          next,
          key,
          entry.text,
          entry.units ?? current.units,
        );
        if (typeof result === "string") {
          if (options.dropInvalid) done.push(key);
          else failed[key] = result;
          continue;
        }
        if (result) next = result;
        done.push(key);
      }
      if (options.background) {
        setHeld(kept);
        setErrors(failed);
      } else if (Object.keys(failed).length) {
        setErrors((value) => ({ ...value, ...failed }));
        return false;
      }
      if (options.change) next = options.change(next);
      const parsed = workoutSchema.safeParse(next);
      if (!parsed.success) {
        if (!options.background)
          setMessage({
            place: options.place ?? "finish",
            text: parsed.error.issues[0]?.message ?? "Check your results.",
          });
        return false;
      }
      if (
        JSON.stringify(parsed.data) !== JSON.stringify(current.workout) &&
        !current.save(parsed.data)
      )
        return false;
      setMessage(undefined);
      setErrors((value) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => !done.includes(key)),
        ),
      );
      setHeld((value) => value.filter((key) => !done.includes(key)));
      if (done.length)
        write(
          Object.fromEntries(
            Object.entries(latest.current.buffer).filter(
              ([key]) => !done.includes(key),
            ),
          ),
        );
      return true;
    },
    [write],
  );
  useEffect(() => {
    const flush = () => {
      if (Object.keys(latest.current.buffer).length)
        commit({ background: true });
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    // Recovered text from an earlier visit is saved once the draft opens.
    flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, [commit]);
  function text(key: string) {
    const entry = buffer[key];
    return entry
      ? shownText(key, entry, units)
      : (savedText(workout, key, units) ?? "");
  }
  function setText(key: string, value: string) {
    const previous = latest.current.buffer[key];
    const base = previous
      ? previous.base
      : (savedBase(latest.current.workout, key) ?? "");
    write({
      ...latest.current.buffer,
      [key]: { text: value, base, units: latest.current.units },
    });
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
    );
  }
  /** Removes every typed value for this workout, in every tab. */
  function clear() {
    write({}, true);
    setErrors({});
    setHeld([]);
  }
  return {
    pending: Object.keys(buffer).length > 0,
    errors,
    held,
    /** Weights kept without units, waiting for the person to confirm them. */
    unconfirmed: Object.entries(buffer)
      .filter(([, entry]) => entry.base === null)
      .map(([key]) => key),
    units,
    message,
    storageError,
    text,
    setText,
    commit,
    clear,
  };
}
export type WorkoutInputs = ReturnType<typeof useWorkoutInputs>;
