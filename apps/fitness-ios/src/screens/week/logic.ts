import { z } from "zod";
import {
  addDays,
  formatDate,
  formatShortDate,
  nextSession,
  runSchema,
  sameData,
  scheduled,
  sessionMinutes,
  trainingRecords,
} from "@bent/fitness-contracts/domain";
import type { DayActivity, Entity, RecordEntry, Routine, Settings, Workout } from "@bent/fitness-contracts/domain";
import { sessionName } from "@bent/fitness-contracts/week";
import { runText } from "../../logic/format";

/*
 * The Week tab's rules, kept apart from React Native so Bun tests cover them.
 * They follow the Fitness web app's week, plan and run pages. Weekly plan
 * progress and reorganising a week are shared rules in
 * `@bent/fitness-contracts/week`.
 */

export type DayState = "done" | "missed" | "planned" | "rest";

/** Whether a value is a calendar day such as 2026-11-27. */
export function isDay(value: string | undefined): value is string {
  return z.iso.date().safeParse(value).success;
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

/**
 * A day's session as the reminders and the widget name it: "Strength A"
 * with "6 exercises · about 45 min", "Easy run", or "Rest day".
 */
export function sessionText(info: DayInfo): { title: string; detail: string | null } {
  const { plan } = info;
  if (plan.type === "strength") {
    if (!plan.routine) return { title: info.name, detail: "Strength session" };
    const count = plan.routine.exercises.length;
    return {
      title: plan.routine.name,
      detail: `${count} ${count === 1 ? "exercise" : "exercises"} · about ${sessionMinutes(plan.routine, plan.intro)} min`,
    };
  }
  return { title: plan.type === "run" ? "Easy run" : "Rest day", detail: null };
}

/** "Next: Mon 30 Nov · Strength B" for the first session after `day`, or null with none in the next two weeks. */
export function nextSessionText(settings: Settings, records: RecordEntry[], day: string) {
  const upcoming = nextSession(settings, addDays(day, 1), records);
  if (!upcoming) return null;
  const name = upcoming.plan.type === "strength" ? (upcoming.plan.routine?.name ?? "Strength") : "Easy run";
  return `Next: ${formatShortDate(upcoming.date)} · ${name}`;
}

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
