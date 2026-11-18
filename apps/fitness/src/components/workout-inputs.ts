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

/** Text typed into a workout field, with the saved value it started from. */
type Buffered = { text: string; base: string };
export type InputBuffer = Record<string, Buffered>;
const bufferSchema = z.record(
  z.string().max(40),
  z.object({ text: z.string().max(2000), base: z.string().max(2000) }),
);
const fieldPattern = /^(\d+):(\d+):(loadKg|value|right|rir)$/;
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

function readBuffer(storageKey: string | null): InputBuffer {
  if (!storageKey) return {};
  try {
    return bufferSchema.parse(
      JSON.parse(localStorage.getItem(storageKey) ?? "{}"),
    );
  } catch {
    return {};
  }
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
  save,
}: {
  workout: Workout;
  units: Settings["units"];
  storageKey: string | null;
  save: (workout: Workout) => boolean;
}) {
  const [buffer, setBuffer] = useState(() => readBuffer(storageKey));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [held, setHeld] = useState<string[]>([]);
  const [message, setMessage] = useState<{ place: string; text: string }>();
  const [storageError, setStorageError] = useState("");
  const latest = useRef({ workout, buffer, save, units });
  useLayoutEffect(() => {
    latest.current = { workout, buffer, save, units };
  });
  const write = useCallback(
    (next: InputBuffer) => {
      latest.current = { ...latest.current, buffer: next };
      setBuffer(next);
      if (!storageKey) return;
      try {
        if (Object.keys(next).length)
          localStorage.setItem(storageKey, JSON.stringify(next));
        else localStorage.removeItem(storageKey);
        setStorageError("");
      } catch {
        setStorageError(
          "Typed values could not be kept on this device. Leave the field to save them to your account.",
        );
      }
    },
    [storageKey],
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
        if (
          options.background &&
          savedText(current.workout, key, current.units) !== entry.base
        ) {
          kept.push(key);
          continue;
        }
        const result = applyText(next, key, entry.text, current.units);
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
    return buffer[key]?.text ?? savedText(workout, key, units) ?? "";
  }
  function setText(key: string, value: string) {
    const base =
      latest.current.buffer[key]?.base ??
      savedText(latest.current.workout, key, units) ??
      "";
    write({ ...latest.current.buffer, [key]: { text: value, base } });
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
    );
  }
  function clear() {
    write({});
    setErrors({});
    setHeld([]);
  }
  return {
    pending: Object.keys(buffer).length > 0,
    errors,
    held,
    message,
    storageError,
    text,
    setText,
    commit,
    clear,
  };
}
export type WorkoutInputs = ReturnType<typeof useWorkoutInputs>;
