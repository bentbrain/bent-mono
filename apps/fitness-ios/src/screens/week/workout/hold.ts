import type { Workout } from "@bent/fitness-contracts/domain";
import { formatDuration } from "@bent/fitness-contracts/timing";
import type { SetEntry } from "./session";

/*
 * The hold timer for timed exercises such as planks. A hold starts with a
 * short countdown to get into position, then counts down the set's target.
 * Exercises held on each side run left, a pause to switch, then right. Every
 * phase is worked out from the start time, so the timer keeps its place
 * while the app is in the background.
 */

/** Seconds to get into position before a hold, and to switch sides. */
export const readySeconds = 5;

type Side = "left" | "right" | null;

/** A hold in progress on this iPhone. */
export type Hold = {
  exerciseIndex: number;
  setIndex: number;
  name: string;
  /** When the get-ready countdown started, in epoch milliseconds. */
  startedAt: number;
  /** Target seconds for the only side, or the left side. */
  seconds: number;
  /** Target seconds for the right side, or null for exercises held once. */
  right: number | null;
};

export type HoldPhase =
  | { kind: "ready"; side: Side; endsAt: number }
  | { kind: "hold"; side: Side; startedAt: number; endsAt: number }
  | { kind: "done" };

type Segment = { kind: "ready" | "hold"; side: Side; start: number; end: number };

function segments(hold: Hold): Segment[] {
  const first: Side = hold.right === null ? null : "left";
  const list: Segment[] = [];
  let at = hold.startedAt;
  const add = (kind: Segment["kind"], side: Side, seconds: number) => {
    list.push({ kind, side, start: at, end: at + seconds * 1000 });
    at += seconds * 1000;
  };
  add("ready", first, readySeconds);
  add("hold", first, hold.seconds);
  if (hold.right !== null) {
    add("ready", "right", readySeconds);
    add("hold", "right", hold.right);
  }
  return list;
}

/** The phase of a hold at `now`. */
export function holdPhase(hold: Hold, now: number): HoldPhase {
  const segment = segments(hold).find((item) => now < item.end);
  if (!segment) return { kind: "done" };
  return segment.kind === "ready"
    ? { kind: "ready", side: segment.side, endsAt: segment.end }
    : { kind: "hold", side: segment.side, startedAt: segment.start, endsAt: segment.end };
}

/** When the whole hold ends, in epoch milliseconds. */
export function holdEndsAt(hold: Hold) {
  return segments(hold).at(-1)?.end ?? hold.startedAt;
}

/**
 * The whole millisecond a finished hold is recorded at. A decimal target
 * can end part-way through a millisecond, and the rest it starts needs a
 * whole-millisecond deadline.
 */
export function holdFinishedAt(hold: Hold) {
  return Math.ceil(holdEndsAt(hold));
}

/** Whether the hold's set is still there and still to do, so the hold may record it. */
export function holdSetOpen(workout: Workout, hold: Hold) {
  const set = workout.exercises[hold.exerciseIndex]?.sets[hold.setIndex];
  return Boolean(set && !set.done && !set.skipped);
}

/** A hold target for a label: "0:30", or "22.5 s" for decimal seconds. */
export function targetLabel(seconds: number) {
  return Number.isInteger(seconds) ? formatDuration(seconds) : `${seconds} s`;
}

/**
 * A hold target from the set's typed or saved text. The set field accepts
 * seconds above 0 up to 600, decimals included, and so does the timer.
 * Text the field would refuse uses the saved value, else 1 second.
 */
export function targetSeconds(text: string, fallback: number) {
  const valid = (value: number) => Number.isFinite(value) && value > 0 && value <= 600;
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (trimmed && valid(value)) return value;
  return valid(fallback) ? fallback : 1;
}

/** Starts a hold for a timed set. */
export function startHold(
  workout: Workout,
  exerciseIndex: number,
  setIndex: number,
  targets: { seconds: number; right: number | null },
  now: number,
): Hold | undefined {
  const exercise = workout.exercises[exerciseIndex];
  const set = exercise?.sets[setIndex];
  if (!exercise || !set || exercise.prescription.mode !== "seconds" || set.done || set.skipped) return undefined;
  return {
    exerciseIndex,
    setIndex,
    name: exercise.prescription.name,
    startedAt: now,
    seconds: targets.seconds,
    right: exercise.prescription.side ? (targets.right ?? targets.seconds) : null,
  };
}

/**
 * The set change a hold records. A finished hold records every target and
 * marks the set Done. A hold stopped early records the whole seconds held on
 * each side it reached and leaves the set to be marked Done; a side not
 * reached keeps its saved value.
 */
export function holdResult(hold: Hold, now: number): Partial<SetEntry> | undefined {
  const phase = holdPhase(hold, now);
  if (phase.kind === "done") return hold.right === null ? { value: hold.seconds, done: true, skipped: false } : { value: hold.seconds, right: hold.right, done: true, skipped: false };
  const held = segments(hold).filter((item) => item.kind === "hold" && item.start <= now);
  if (!held.length) return undefined;
  const change: Partial<SetEntry> = {};
  for (const item of held) {
    const seconds = Math.max(0, Math.floor((Math.min(now, item.end) - item.start) / 1000));
    if (item.side === "right") change.right = seconds;
    else change.value = seconds;
  }
  // Zero seconds is not a result; the set keeps its saved value for that side.
  if (change.value === 0) delete change.value;
  if (change.right === 0) delete change.right;
  return Object.keys(change).length ? change : undefined;
}

/** "Get ready", "Hold", "Left side", "Switch to right" and so on. */
export function phaseTitle(phase: HoldPhase) {
  if (phase.kind === "done") return "Hold done";
  if (phase.kind === "ready") return phase.side === "right" ? "Switch to right" : "Get ready";
  return phase.side === "left" ? "Hold left" : phase.side === "right" ? "Hold right" : "Hold";
}

/** The announcement when a hold phase starts. */
export function phaseAnnouncement(hold: Hold, phase: HoldPhase) {
  if (phase.kind === "done") return `Hold done. ${hold.name}, set ${hold.setIndex + 1} recorded.`;
  if (phase.kind === "ready") return phase.side === "right" ? "Switch to your right side." : `Get ready: ${hold.name}.`;
  const seconds = phase.side === "right" ? hold.right : hold.seconds;
  return `${phaseTitle(phase)} for ${seconds} seconds.`;
}

/** A key that changes whenever the hold moves to another phase. */
export function phaseKey(phase: HoldPhase) {
  return phase.kind === "done" ? "done" : `${phase.kind}:${phase.side ?? "one"}:${phase.endsAt}`;
}
