import type { Workout } from "@bent/fitness-contracts/domain";

/*
 * Session rules for the workout logger: set progress, the next set, rest
 * choices and the changes that set actions, rest controls and finishing make.
 */

export type SetEntry = Workout["exercises"][number]["sets"][number];

/** How long "Rest done" stays on screen after a rest ends. */
export const restNoticeSeconds = 10 * 60;

/** Set counts and the next set to handle. */
export function sessionProgress(workout: Workout) {
  const sets = workout.exercises.flatMap((exercise) =>
    exercise.sets.map((set, index) => ({ set, index, name: exercise.prescription.name })),
  );
  const next = sets.find((item) => !item.set.done && !item.set.skipped);
  const completed = sets.filter((item) => item.set.done).length;
  const skipped = sets.filter((item) => item.set.skipped).length;
  return {
    total: sets.length,
    completed,
    skipped,
    next: next ? { name: next.name, index: next.index } : undefined,
    /** Handled sets as a fraction from 0 to 1. */
    fraction: sets.length ? (completed + skipped) / sets.length : 0,
  };
}

/** "3/12 sets done · 1 skipped" */
export function progressText(progress: { total: number; completed: number; skipped: number }) {
  return `${progress.completed}/${progress.total} sets done${progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ""}`;
}

/** The first exercise with a set still to handle, or -1 when every set is handled. */
export function currentExercise(workout: Workout) {
  return workout.exercises.findIndex((exercise) => exercise.sets.some((set) => !set.done && !set.skipped));
}

/** The rest of the current exercise, else the last exercise's rest, else 2 minutes. */
export function suggestedRest(workout: Workout) {
  return (
    workout.exercises.find((exercise) => exercise.sets.some((set) => !set.done && !set.skipped))?.prescription.rest ??
    workout.exercises.at(-1)?.prescription.rest ??
    120
  );
}

/** Rest lengths to choose from: common lengths and every prescribed rest, shortest first. */
export function restChoices(workout: Workout) {
  return [...new Set([30, 60, 90, 120, 180, ...workout.exercises.map((exercise) => exercise.prescription.rest)])].sort((a, b) => a - b);
}

/** Whether the "Rest done" state shows for the rest that ended at `endedDeadline`. */
export function restDoneShowing(endedDeadline: number | null, restUntil: number | null, now: number) {
  return endedDeadline !== null && endedDeadline === restUntil && now - endedDeadline < restNoticeSeconds * 1000;
}

/** The announcement once a rest ends. */
export function restAnnouncement(next: { name: string; index: number } | undefined) {
  return `Rest done.${next ? ` Next: ${next.name}, set ${next.index + 1}.` : " Every set is handled."}`;
}

/**
 * Applies a set action (Controlled, Done or Skip). Marking a set Done starts
 * the exercise's rest when the logger runs the rest timer.
 */
export function applySetChange(
  workout: Workout,
  exerciseIndex: number,
  setIndex: number,
  change: Partial<SetEntry>,
  options: { startRest: boolean; now: number },
): Workout {
  const exercise = workout.exercises[exerciseIndex];
  const set = exercise?.sets[setIndex];
  const startsRest = options.startRest && change.done === true && set !== undefined && !set.done;
  return {
    ...workout,
    restUntil: startsRest && exercise ? options.now + exercise.prescription.rest * 1000 : workout.restUntil,
    exercises: workout.exercises.map((item, i) =>
      i !== exerciseIndex ? item : { ...item, sets: item.sets.map((value, j) => (j === setIndex ? { ...value, ...change } : value)) },
    ),
  };
}

/** The change that finishes a workout. */
export function finishChange(now: Date) {
  return (workout: Workout): Workout => ({ ...workout, finishedAt: now.toISOString(), restUntil: null });
}
