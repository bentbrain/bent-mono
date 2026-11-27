import { displayLoad } from "@bent/fitness-contracts/domain";
import type { Settings, Workout } from "@bent/fitness-contracts/domain";
import { holdEndsAt, holdPhase, phaseTitle } from "./hold";
import type { Hold } from "./hold";
import { currentExercise, sessionProgress } from "./session";

/*
 * What the workout Live Activity shows. The Lock Screen and Dynamic Island
 * count the timers down themselves, so the app updates the activity only
 * when the content below changes: a set is handled, or a rest or hold starts,
 * moves to its next phase or ends.
 */

type ActivityPhase = "lift" | "rest" | "ready" | "hold";

/** The changing part of the activity. Times are epoch milliseconds. */
type ActivityState = {
  phase: ActivityPhase;
  /** "Rest", "Get ready", "Hold left" and so on, or the exercise for a lift. */
  title: string;
  /** The exercise, or the set to do next during a rest. */
  exercise: string;
  /** "Set 2 of 3 · 12 kg × 8–12 reps" */
  detail: string;
  /** Shown once a rest or hold has ended without the app updating it. */
  doneTitle: string;
  doneDetail: string;
  completed: number;
  total: number;
  /** The current phase's countdown. */
  timerStart: number | null;
  timerEnd: number | null;
  /**
   * When a whole hold ends, after its get-ready and switch phases. The
   * activity shows it beside the phase countdown, so it stays right while
   * the app is suspended and can't move the activity to the next phase.
   */
  finalEnd: number | null;
};

export type ActivityContent = {
  workoutId: string;
  workoutName: string;
  startedAt: number;
  state: ActivityState;
  /** When the content goes out of date: the end of the running rest or of the whole hold. */
  staleAt: number | null;
  /** A local notification for the end of the running rest or hold. */
  alert: { at: number; title: string; body: string } | null;
};

type Units = Settings["units"];

/** The next set to do: its exercise index, set index, name and target. */
function nextSet(workout: Workout, units: Units) {
  const ei = currentExercise(workout);
  const exercise = workout.exercises[ei];
  if (!exercise) return undefined;
  const si = exercise.sets.findIndex((set) => !set.done && !set.skipped);
  const set = exercise.sets[si];
  if (!set) return undefined;
  const p = exercise.prescription;
  const each = p.side ? " each side" : "";
  const target =
    p.mode === "seconds"
      ? `${set.value} s hold${each}`
      : `${set.loadKg > 0 ? `${displayLoad(set.loadKg, units)} ${units} × ` : ""}${p.min === p.max ? p.min : `${p.min}–${p.max}`} reps${each}`;
  return { ei, si, name: p.name, detail: `Set ${si + 1} of ${exercise.sets.length} · ${target}` };
}

/** The Live Activity for a workout in progress, or null once it is finished. */
export function activityContent(
  workoutId: string,
  workout: Workout,
  hold: Hold | null,
  units: Units,
  now: number,
): ActivityContent | null {
  if (workout.finishedAt) return null;
  const progress = sessionProgress(workout);
  const next = nextSet(workout, units);
  const base = {
    exercise: next?.name ?? "Every set is handled",
    detail: next?.detail ?? "Finish the workout in bent Fitness.",
    completed: progress.completed + progress.skipped,
    total: progress.total,
  };
  const content = (state: ActivityState, alert: ActivityContent["alert"]): ActivityContent => ({
    workoutId,
    workoutName: workout.name,
    startedAt: Date.parse(workout.startedAt),
    state,
    staleAt: state.finalEnd ?? state.timerEnd,
    alert,
  });

  const phase = hold ? holdPhase(hold, now) : null;
  if (hold && phase && phase.kind !== "done") {
    const exercise = workout.exercises[hold.exerciseIndex];
    const holding = phase.kind === "hold";
    const end = holdEndsAt(hold);
    return content(
      {
        ...base,
        phase: holding ? "hold" : "ready",
        title: phaseTitle(phase),
        exercise: hold.name,
        detail: `Set ${hold.setIndex + 1} of ${exercise?.sets.length ?? hold.setIndex + 1} · ${
          hold.right === null ? `${hold.seconds} s` : `${hold.seconds} s left, ${hold.right} s right`
        }`,
        doneTitle: "Hold done",
        doneDetail: `${hold.name}, set ${hold.setIndex + 1}. Open the workout to record it.`,
        timerStart: holding ? phase.startedAt : now,
        timerEnd: phase.endsAt,
        finalEnd: end,
      },
      { at: end, title: "Hold done", body: `${hold.name}, set ${hold.setIndex + 1}. Open the workout to record it.` },
    );
  }

  if (workout.restUntil !== null && workout.restUntil > now) {
    const nextText = next ? `Next: ${next.name}` : "Every set is handled.";
    return content(
      {
        ...base,
        phase: "rest",
        title: "Rest",
        exercise: next ? `Next: ${next.name}` : base.exercise,
        doneTitle: "Rest done",
        doneDetail: next ? `${nextText} · ${next.detail}` : nextText,
        timerStart: Math.min(now, workout.restUntil),
        timerEnd: workout.restUntil,
        finalEnd: null,
      },
      { at: workout.restUntil, title: "Rest done", body: next ? `${nextText}, set ${next.si + 1}.` : nextText },
    );
  }

  return content(
    { ...base, phase: "lift", title: base.exercise, doneTitle: "", doneDetail: "", timerStart: null, timerEnd: null, finalEnd: null },
    null,
  );
}

/**
 * Whether two contents differ in anything the activity shows. A countdown
 * started at another moment for the same deadline shows the same thing.
 */
export function sameActivity(a: ActivityContent | null, b: ActivityContent | null) {
  if (!a || !b) return a === b;
  const shown = (value: ActivityContent) => ({ ...value, state: { ...value.state, timerStart: null } });
  return JSON.stringify(shown(a)) === JSON.stringify(shown(b));
}
