import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { Workout } from "@bent/fitness-contracts/domain";
import { drafts } from "../../../data/storage";
import { WorkoutInputStore, planCommit, savedBase, savedText, shownText, unconfirmedKeys } from "./inputs";
import type { CommitOptions, DraftBackend, InputBuffer, Units } from "./inputs";

/** The drafts table for one account, as the input store uses it. */
export function draftBackend(owner: string): DraftBackend {
  return {
    get: (key) => drafts.get(owner, key),
    set: (key, value) => drafts.set(owner, key, value),
    remove: (key) => drafts.remove(owner, key),
  };
}

const storageMessage = "Typed values could not be kept on this device. Leave the field to save them to your account.";

/**
 * Keeps typed workout values on this iPhone until the person leaves the set,
 * presses a set action or finishes. Valid values are also saved when the
 * screen loses focus, the app moves to the background, the editor closes or
 * a recovered draft opens. With `workoutId` null the values stay in memory.
 */
export function useWorkoutInputs({
  workout,
  units,
  owner,
  workoutId,
  save,
}: {
  workout: Workout;
  units: Units;
  owner: string;
  /** The workout whose typed values persist on this iPhone, or null to keep them in memory. */
  workoutId: string | null;
  save: (workout: Workout) => boolean;
}) {
  const [storage] = useState(() => {
    if (!workoutId) return undefined;
    try {
      return new WorkoutInputStore(draftBackend(owner), workoutId);
    } catch {
      return undefined;
    }
  });
  const [buffer, setBuffer] = useState<InputBuffer>(() => storage?.buffer ?? {});
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
      latest.current = { ...latest.current, buffer: next };
      setBuffer(next);
      if (!workoutId) return;
      try {
        if (!storage) throw Error("Device storage is unavailable");
        if (replace) storage.clear();
        else storage.write(next);
        setStorageError("");
      } catch {
        setStorageError(storageMessage);
      }
    },
    [storage, workoutId],
  );

  const commit = useCallback(
    (options: CommitOptions = {}) => {
      const current = latest.current;
      const plan = planCommit(current.workout, current.buffer, current.units, options);
      if (options.background) {
        setHeld(plan.kept);
        setErrors(plan.failed);
      }
      if (plan.status === "invalid") {
        setErrors((value) => ({ ...value, ...plan.failed }));
        return false;
      }
      if (plan.status === "rejected") {
        if (!options.background) setMessage({ place: options.place ?? "finish", text: plan.message });
        return false;
      }
      if (plan.changed && !current.save(plan.workout)) return false;
      const done = plan.done;
      setMessage(undefined);
      setErrors((value) => Object.fromEntries(Object.entries(value).filter(([key]) => !done.includes(key))));
      setHeld((value) => value.filter((key) => !done.includes(key)));
      if (done.length)
        write(Object.fromEntries(Object.entries(latest.current.buffer).filter(([key]) => !done.includes(key))));
      return true;
    },
    [write],
  );

  const flush = useCallback(() => {
    if (Object.keys(latest.current.buffer).length) commit({ background: true });
  }, [commit]);

  // Recovered text from an earlier visit is saved once the editor is shown,
  // and typed text is saved when the person leaves the screen.
  useFocusEffect(
    useCallback(() => {
      flush();
      return flush;
    }, [flush]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") flush();
    });
    return () => subscription.remove();
  }, [flush]);

  function text(key: string) {
    const entry = buffer[key];
    return entry ? shownText(key, entry, units) : (savedText(workout, key, units) ?? "");
  }
  function setText(key: string, value: string) {
    const previous = latest.current.buffer[key];
    const base = previous ? previous.base : (savedBase(latest.current.workout, key) ?? "");
    write({ ...latest.current.buffer, [key]: { text: value, base, units: latest.current.units } });
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)));
  }
  /** Removes every typed value for this workout from this iPhone. */
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
    unconfirmed: unconfirmedKeys(buffer, workout),
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
