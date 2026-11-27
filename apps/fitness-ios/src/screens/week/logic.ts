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

/** Planned sessions that can move. */
export function moveSources(settings: Settings, movable: string[]) {
  return movable.filter((day) => scheduled(settings, day).type !== "rest");
}

/** Days a session on `from` can move to. */
export function moveDestinations(movable: string[], from: string) {
  return movable.filter((day) => day !== from);
}

/** The move the sheet opens with: the first planned session and the next open day. */
export function firstMove(settings: Settings, movable: string[]) {
  const from = moveSources(settings, movable)[0] ?? "";
  return { from, to: movable.find((day) => day !== from) ?? "" };
}

/** Choosing a new session keeps the destination unless it is the same day. */
export function chooseSource(movable: string[], from: string, to: string) {
  return { from, to: to === from ? (movable.find((day) => day !== from) ?? "") : to };
}

/** "Fri 27 Nov 2026 · Strength A" */
export function dayOption(settings: Settings, day: string) {
  return `${formatDate(day)} · ${sessionName(scheduled(settings, day))}`;
}

/** What the move does to both days. */
export function movePreview(settings: Settings, from: string, to: string) {
  if (!from || !to) return "";
  return `${sessionName(scheduled(settings, from))} moves to ${formatDate(to)}. ${sessionName(scheduled(settings, to))} moves to ${formatDate(from)}.`;
}

/**
 * Applies a move to the settings the sheet opened with. A change saved on
 * another device since then stops the move, so it never overwrites that edit.
 */
export function planMove(
  origin: { settings: Settings; revision: number },
  latest: { revision: number; data: Entity | null },
  from: string,
  to: string,
  today: string,
  records: RecordEntry[],
): { settings: Settings } | { error: string } {
  if (latest.revision !== origin.revision || !sameData(latest.data, origin.settings))
    return { error: "Your plan changed. Close this sheet and reopen it to use the saved plan." };
  try {
    return { settings: reorganiseDays(origin.settings, from, to, today, records) };
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
