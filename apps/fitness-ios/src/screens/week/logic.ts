import { z } from "zod";
import {
  addDays,
  formatDate,
  formatShortDate,
  reorganiseDays,
  runSchema,
  sameData,
  scheduled,
  trainingRecords,
} from "@bent/fitness-contracts/domain";
import type { DayActivity, Entity, RecordEntry, Routine, Settings, Workout } from "@bent/fitness-contracts/domain";
import { runText } from "../../logic/format";

/*
 * The Week tab's rules, kept apart from React Native so Bun tests cover them.
 * They follow the Fitness web app's week, plan, run and reorganisation pages.
 */

export type DayState = "done" | "missed" | "planned" | "rest";
type Plan = ReturnType<typeof scheduled>;

/** Whether a value is a calendar day such as 2026-11-27. */
export function isDay(value: string | undefined): value is string {
  return z.iso.date().safeParse(value).success;
}

/** The seven days of the week starting on `monday`. */
export function weekDays(monday: string) {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** "Strength A", "Easy run" or "Rest" for a planned day. */
function sessionName(plan: Plan) {
  return plan.type === "strength" ? (plan.routine?.name ?? "Strength") : plan.type === "run" ? "Easy run" : "Rest";
}

/** What a day holds in the repeating week and what was recorded on it. */
export function dayInfo(settings: Settings, activity: Map<string, DayActivity>, day: string, today: string) {
  const plan = scheduled(settings, day);
  const done = activity.get(day);
  const completed = plan.type === "strength" ? Boolean(done?.strength) : plan.type === "run" ? Boolean(done?.run) : false;
  const other = !completed && Boolean(done?.strength || done?.run);
  const name = sessionName(plan);
  const status = completed
    ? "Done"
    : other
      ? "Activity recorded"
      : plan.type === "rest"
        ? "Rest day"
        : day < today
          ? "Not recorded"
          : "Planned";
  const state: DayState = completed || other ? "done" : plan.type === "rest" ? "rest" : day < today ? "missed" : "planned";
  return { plan, done, completed, other, name, status, state };
}

export type DayInfo = ReturnType<typeof dayInfo>;

/** Splits "Strength A" into "Strength" and "A" for the narrow week board. */
export function boardLabel(type: string, name: string): [string, string] {
  if (type === "rest") return ["Rest", ""];
  if (type === "run") return ["Run", ""];
  const match = /^Strength\s+(.+)$/.exec(name);
  return match ? ["Strength", match[1] ?? ""] : [name, ""];
}

/** What was recorded on a day, as the day panel words it. */
export function recordedText(info: DayInfo, day: string, today: string) {
  const kind = info.done?.strength && info.done.run ? "Strength and run" : info.done?.strength ? "Strength workout" : "Run";
  return `${kind} recorded ${day === today ? "today" : `on ${formatDate(day)}`}.`;
}

/** The unfinished workout, if one is in progress. Only one runs at a time. */
export function activeWorkout(records: RecordEntry[]) {
  return records.find((record) => record.data.kind === "workout" && !record.data.finishedAt);
}

/** How many of a workout's sets are done or skipped. */
export function workoutProgress(workout: Workout) {
  const sets = workout.exercises.flatMap((exercise) => exercise.sets);
  const handled = sets.filter((set) => set.done || set.skipped).length;
  return { handled, total: sets.length, fraction: sets.length ? handled / sets.length : 0 };
}

/**
 * How far a weekly total is through its plan. The plan is met once every
 * planned session is done; a total with nothing planned or done has no progress.
 */
export function planProgress({ done, planned }: { done: number; planned: number }) {
  if (planned <= 0 && done <= 0) return null;
  return { met: done >= planned, fraction: planned > 0 ? Math.min(1, done / planned) : 1 };
}

/** How strength days choose their routine. */
export function rotationNote(settings: Settings) {
  return `Repeating strength days take turns through ${settings.routines.map((routine) => routine.name).join(", ")} in calendar order. Reorganised sessions keep their chosen routine.`;
}

/** The save state, in the words of the Fitness web header. */
export function saveStatus(sync: { online: boolean; saving: boolean; error: string; pending: number; ready: boolean }) {
  if (!sync.online) return "Offline · pending on device";
  if (sync.saving) return "Saving…";
  if (sync.error) return "Needs attention";
  if (sync.pending) return `${sync.pending} pending`;
  return sync.ready ? "Saved" : "Loading…";
}

// Reorganising a week

/** Past days and days with a recorded or started session stay fixed. */
export function lockedDay(day: string, today: string, records: RecordEntry[]) {
  return (
    day < today || records.some(({ data }) => (data.kind === "workout" || data.kind === "run") && data.date === day)
  );
}

/** The days in `days` that a move can change. */
export function movableDays(days: string[], today: string, records: RecordEntry[]) {
  return days.filter((day) => !lockedDay(day, today, records));
}

/** A move needs two open days and a planned session among them. */
export function canReorganise(settings: Settings, movable: string[]) {
  return movable.length >= 2 && movable.some((day) => scheduled(settings, day).type !== "rest");
}

/** Whether any day of the week has a date-specific plan. */
export function canResetWeek(settings: Settings, days: string[]) {
  return days.some((day) => settings.dayPlans?.[day]);
}

/** The settings with this week's date-specific plans removed. */
export function resetWeek(settings: Settings, days: string[]): Settings {
  return {
    ...settings,
    dayPlans: Object.fromEntries(Object.entries(settings.dayPlans ?? {}).filter(([day]) => !days.includes(day))),
  };
}

/**
 * Whether two days hold the same session: the same type and, for strength,
 * the same routine snapshot. A dated plan keeps the routine as it was when
 * the day was moved, so a renamed or edited routine counts as different.
 */
function samePlan(a: Plan, b: Plan) {
  return a.type === b.type && (a.type !== "strength" || sameData(a.routine ?? null, b.routine ?? null));
}

/**
 * The fewest swaps that turn `start` into `goal`, as pairs of positions.
 * Each value names a session; a week has at most seven open days, so a
 * breadth-first search over the arrangements stays small.
 */
function fewestSwaps(start: number[], goal: number[]): [number, number][] | undefined {
  const target = goal.join(",");
  const paths = new Map<string, [number, number][]>([[start.join(","), []]]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: number[][] = [];
    for (const state of frontier) {
      const path = paths.get(state.join(",")) ?? [];
      if (state.join(",") === target) return path;
      state.forEach((key, i) => {
        if (key === goal[i]) return;
        for (let j = i + 1; j < state.length; j += 1) {
          // Days already holding their session stay out of the swaps.
          if (state[j] === key || state[j] === goal[j]) continue;
          const swapped = [...state];
          [swapped[i], swapped[j]] = [state[j] ?? key, key];
          const id = swapped.join(",");
          if (paths.has(id)) continue;
          paths.set(id, [...path, [i, j]]);
          next.push(swapped);
        }
      });
    }
    frontier = next;
  }
  return undefined;
}

/**
 * One row of the reorganise list. `source` is the day whose planned session
 * sits on `day`; a new arrangement starts with every session on its own day.
 */
export type WeekSlot = { day: string; source: string; session: string; locked: boolean };

/** The week as the reorganise list shows it, with `order[i]` placed on the week's day `i`. */
export function weekSlots(settings: Settings, days: string[], order: string[], today: string, records: RecordEntry[]): WeekSlot[] {
  return days.map((day, index) => {
    const source = order[index] ?? day;
    return { day, source, session: sessionName(scheduled(settings, source)), locked: lockedDay(day, today, records) };
  });
}

/**
 * Applies a drag in the reorganise list. The moved sessions land among the
 * open days in the order shown, and fixed days keep their sessions. Indices
 * follow SwiftUI's `onMove`: `destination` counts rows before the moved ones
 * are taken out.
 */
export function reorderWeek(order: string[], locked: boolean[], sources: number[], destination: number) {
  const moving = sources.filter((index) => !locked[index] && index < order.length);
  if (moving.length === 0) return order;
  const stays = (index: number) => !locked[index] && !moving.includes(index);
  const open = order.filter((_, index) => stays(index));
  const at = order.slice(0, Math.max(0, destination)).filter((_, index) => stays(index)).length;
  open.splice(at, 0, ...moving.map((index) => order[index] ?? ""));
  let next = 0;
  return order.map((source, index) => (locked[index] ? source : (open[next++] ?? source)));
}

/**
 * The days whose session changes, as "2 days change: Sat 28, Sun 29." The
 * list shows the new sessions, so this names only the days.
 */
export function reorderPreview(settings: Settings, days: string[], order: string[]) {
  const changed = days.filter((day, index) => !samePlan(scheduled(settings, order[index] ?? day), scheduled(settings, day)));
  if (changed.length === 0) return "";
  const names = changed.map((day) => formatShortDate(day).split(" ").slice(0, 2).join(" "));
  return `${changed.length === 1 ? "1 day changes" : `${changed.length} days change`}: ${names.join(", ")}.`;
}

/**
 * Turns the arrangement the list shows into settings with the fewest swaps
 * of the shared reorganise rule, so only days whose session changes gain a
 * dated plan. A change saved on another device since the sheet opened stops
 * the save, so it never overwrites that edit.
 */
export function planWeek(
  origin: { settings: Settings; revision: number },
  latest: { revision: number; data: Entity | null },
  days: string[],
  order: string[],
  today: string,
  records: RecordEntry[],
): { settings: Settings } | { error: string } {
  if (latest.revision !== origin.revision || !sameData(latest.data, origin.settings))
    return { error: "Your plan changed. Close this sheet and reopen it to use the saved plan." };
  const sessions: Plan[] = [];
  const keyOf = (plan: Plan) => {
    const found = sessions.findIndex((session) => samePlan(session, plan));
    if (found >= 0) return found;
    sessions.push(plan);
    return sessions.length - 1;
  };
  const current = days.map((day) => keyOf(scheduled(origin.settings, day)));
  const wanted = days.map((day, index) => keyOf(scheduled(origin.settings, order[index] ?? day)));
  const open = days.flatMap((day, index) => (lockedDay(day, today, records) ? [] : [index]));
  const recorded = "A session was recorded or started on one of these days. Close this sheet and reopen it to see the current week.";
  if (current.some((key, index) => !open.includes(index) && key !== wanted[index])) return { error: recorded };
  const swaps = fewestSwaps(
    open.map((index) => current[index] ?? -1),
    open.map((index) => wanted[index] ?? -1),
  );
  if (!swaps) return { error: recorded };
  try {
    let settings = origin.settings;
    for (const [a, b] of swaps) {
      const [first, second] = [days[open[a] ?? -1] ?? "", days[open[b] ?? -1] ?? ""];
      // The shared rule moves a planned session, so a rest day is never the source.
      const [from, to] = scheduled(settings, first).type === "rest" ? [second, first] : [first, second];
      settings = reorganiseDays(settings, from, to, today, records);
    }
    return { settings };
  } catch (problem) {
    return { error: problem instanceof Error ? problem.message : "Check the selected days." };
  }
}

// The workout plan page

/** The routine a plan page shows: the requested one, or the day's planned routine. */
export function planRoutine(settings: Settings, date: string, routineId?: string) {
  if (!isDay(date)) return undefined;
  const planned = scheduled(settings, date);
  const routine: Routine | undefined = routineId
    ? planned.type === "strength" && planned.routine?.id === routineId
      ? planned.routine
      : settings.routines.find((item) => item.id === routineId)
    : planned.type === "strength"
      ? planned.routine
      : undefined;
  return routine ? { routine, intro: planned.intro } : undefined;
}

/** A finished workout of this routine recorded for the date. */
export function recordedWorkout(records: RecordEntry[], date: string, routineId: string) {
  return trainingRecords(records).find(
    (record) =>
      record.data.kind === "workout" &&
      Boolean(record.data.finishedAt) &&
      record.data.date === date &&
      record.data.routineId === routineId,
  );
}

/** The plan page's main action and the note under it. */
export function planAction(settings: Settings, routine: Routine, date: string, today: string, intro: boolean) {
  // A future plan is done today, so it uses today's introduction setting.
  const workoutDate = date > today ? today : date;
  const workoutIntro = scheduled(settings, workoutDate).intro;
  const label = date > today ? "Do this workout today" : date < today ? `Log workout for ${formatDate(date)}` : "Start workout";
  const note =
    date > today
      ? `This starts ${routine.name} now and records it for today, ${formatDate(today)}.${
          workoutIntro === intro
            ? ""
            : workoutIntro
              ? " Today is in your introduction weeks, so each exercise has up to 2 sets."
              : " Today uses full sets."
        }`
      : date < today
        ? `Log workout opens a workout dated ${formatDate(date)} for results you have already done. Do this workout today records it for ${formatDate(today)}.`
        : "Start when you are ready to train. This begins your session and elapsed timer.";
  return { workoutDate, label, note };
}

// Recording a run

/** The version of a record an editor opened. Saving checks it is still current. */
export type Opened<T extends Entity> = { id: string; revision: number; data: T };
export type Run = Extract<Entity, { kind: "run" }>;
export type EditStatus = "current" | "changed" | "removed";

/** Whether the record still matches the version the editor opened. */
export function editStatus(
  opened: Opened<Entity> | undefined,
  current: { revision: number; data: Entity | null } | undefined,
): EditStatus {
  if (!opened) return "current";
  if (!current?.data) return "removed";
  return current.revision === opened.revision && sameData(current.data, opened.data) ? "current" : "changed";
}

/** A typed number. Empty text is not a number. */
function typedNumber(text: string) {
  const trimmed = text.trim().replace(",", ".");
  return trimmed === "" ? Number.NaN : Number(trimmed);
}

/** Checks the run form and returns the run to save, or the message to show. */
export function parseRun(
  values: { date: string; minutes: string; distance: string; notes: string },
  today: string,
): { run: Run } | { error: string } {
  const result = runSchema.safeParse({
    kind: "run",
    date: values.date,
    minutes: typedNumber(values.minutes),
    distanceKm: typedNumber(values.distance),
    notes: values.notes,
  });
  if (!result.success) return { error: "Enter a valid date, duration and distance." };
  if (result.data.date > today) return { error: `Record a run on ${formatDate(today)} or an earlier date.` };
  return { run: result.data };
}

/** The form's starting values for a run, or for a new run on `day`. */
export function runForm(run: Run | undefined, day: string, today: string) {
  return {
    date: run?.date ?? (day > today ? today : day),
    minutes: run ? String(run.minutes) : "",
    distance: run ? String(run.distanceKm) : "",
    notes: run?.notes ?? "",
  };
}

/** "Fri 27 Nov 2026 · 30 min · 5 km" */
export function runSummary(run: Run) {
  return `${formatDate(run.date)} · ${runText(run)}`;
}
