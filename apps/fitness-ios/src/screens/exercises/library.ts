import { exercises, lastExercise, loadWording, setResult } from "@bent/fitness-contracts/domain";
import type { Exercise, RecordEntry, Routine, Settings } from "@bent/fitness-contracts/domain";

/**
 * The exercise library in display order: exercises in the user's routines
 * first, in routine order, then the rest of the included exercises.
 */
export function libraryOrder(routines: Routine[]): Exercise[] {
  const ids = [...new Set([...routines.flatMap((routine) => routine.exercises.map((item) => item.id)), ...exercises.map((item) => item.id)])];
  return ids.flatMap((id) => exercises.filter((item) => item.id === id));
}

/** The names of the routines that include an exercise. */
export function routinesWith(routines: Routine[], id: string) {
  return routines.filter((routine) => routine.exercises.some((exercise) => exercise.id === id)).map((routine) => routine.name);
}

/** "In Strength A, Strength B", or a note that the exercise is in no routine. */
export function routinesText(names: string[]) {
  return names.length ? `In ${names.join(", ")}` : "Not in your routines";
}

/** Each routine's prescription for an exercise. */
export function planEntries(routines: Routine[], id: string) {
  return routines.flatMap((routine) =>
    routine.exercises.filter((exercise) => exercise.id === id).map((exercise) => ({ routine: routine.name, exercise })),
  );
}

/** The prescription that decides how to record an exercise: the first routine's, or the included default. */
export function measuredExercise(routines: Routine[], id: string) {
  return planEntries(routines, id)[0]?.exercise ?? exercises.find((exercise) => exercise.id === id);
}

/** The last completed workout's results for an exercise, or null when it has none. */
export function lastResult(records: RecordEntry[], id: string, units: Settings["units"]) {
  const previous = lastExercise(records, id);
  if (!previous) return null;
  return previous.sets.map((set) => setResult(set, previous.prescription, units)).join(" · ");
}

/** Short labels for how an exercise is measured. */
export function exerciseTags(exercise: Exercise) {
  return [
    exercise.mode === "seconds" ? "Timed hold" : "Reps",
    ...(exercise.side ? ["Each side"] : []),
    ...(exercise.mode === "reps" ? [loadWording(exercise, "kg").tag] : []),
  ];
}

/** The YouTube page for a guide's tutorial. */
export const tutorialUrl = (video: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(video)}`;
