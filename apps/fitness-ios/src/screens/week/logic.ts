import { z } from "zod";
import {
  addDays,
  formatDate,
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

/** Filled pips for a weekly total, at most seven. */
export function pips(value: { done: number; planned: number }) {
  return Array.from({ length: Math.min(7, Math.max(value.planned, value.done)) }, (_, index) => index < value.done);
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

/** Whether two days hold the same session: the same type and, for strength, the same routine. */
function samePlan(a: Plan, b: Plan) {
  return a.type === b.type && (a.type !== "strength" || a.routine?.id === b.routine?.id);
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

/** The days whose session changes, as "Easy run moves to Sun 29 Nov 2026." */
export function reorderPreview(settings: Settings, days: string[], order: string[]) {
  return days
    .flatMap((day, index) => {
      const source = order[index] ?? day;
      const plan = scheduled(settings, source);
      return samePlan(plan, scheduled(settings, day)) ? [] : [`${sessionName(plan)} moves to ${formatDate(day)}.`];
    })
    .join(" ");
}

/**
 * Turns the arrangement the list shows into settings, one swap at a time
 * with the shared reorganise rule. Days that keep the same session are left
 * as they are. A change saved on another device since the sheet opened stops
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
  try {
    let settings = origin.settings;
    days.forEach((day, index) => {
      const wanted = scheduled(origin.settings, order[index] ?? day);
      if (samePlan(scheduled(settings, day), wanted)) return;
      const other = days
        .slice(index + 1)
        .find((later) => !lockedDay(later, today, records) && samePlan(scheduled(settings, later), wanted));
      if (!other)
        throw Error("A session was recorded or started on one of these days. Close this sheet and reopen it to see the current week.");
      // The shared rule moves a planned session, so a rest day is never the source.
      const [from, to] = wanted.type === "rest" ? [day, other] : [other, day];
      settings = reorganiseDays(settings, from, to, today, records);
    });
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
