import { describe, expect, test } from "bun:test";
import { completedActivity, createWorkout, defaultSettings, settingsId } from "@bent/fitness-contracts/domain";
import type { Entity, RecordEntry, Settings } from "@bent/fitness-contracts/domain";
import {
  activeWorkout,
  boardLabel,
  canReorganise,
  canResetWeek,
  chooseSource,
  dayInfo,
  dayOption,
  editStatus,
  firstMove,
  isDay,
  lockedDay,
  movableDays,
  moveDestinations,
  movePreview,
  moveSources,
  parseRun,
  pips,
  planAction,
  planMove,
  planRoutine,
  recordedText,
  recordedWorkout,
  resetWeek,
  rotationNote,
  runForm,
  runSummary,
  saveStatus,
  weekDays,
  workoutProgress,
} from "../src/screens/week/logic";

// Synthetic plan: Monday 23 Nov 2026 starts a week of
// Strength A, run, Strength B, rest, Strength A, run, rest.
const monday = "2026-11-23";
const settings = defaultSettings(monday, "UTC");
const days = weekDays(monday);
const routineA = settings.routines[0]!;
const routineB = settings.routines[1]!;

let counter = 0;
function record(data: Entity, revision = 1): RecordEntry {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    revision,
    data,
    updatedAt: "2026-11-23T08:00:00.000Z",
  };
}
function finishedWorkout(date: string, routine = routineA) {
  const workout = createWorkout(settings, routine, date, true, []);
  return { ...workout, finishedAt: `${date}T09:00:00.000Z` };
}
const run = (date: string, minutes = 30, distanceKm = 5): Entity => ({ kind: "run", date, minutes, distanceKm, notes: "" });

describe("days", () => {
  test("isDay accepts calendar days only", () => {
    expect(isDay("2026-11-27")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("")).toBe(false);
    expect(isDay(undefined)).toBe(false);
  });

  test("weekDays lists Monday to Sunday", () => {
    expect(days).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
  });

  test("dayInfo follows the plan and the records", () => {
    const today = "2026-11-25";
    const records = [record(finishedWorkout("2026-11-23")), record(run("2026-11-26"))];
    const activity = completedActivity(records);
    const done = dayInfo(settings, activity, "2026-11-23", today);
    expect(done).toMatchObject({ name: "Strength A", status: "Done", state: "done", completed: true });
    const missed = dayInfo(settings, activity, "2026-11-24", today);
    expect(missed).toMatchObject({ name: "Easy run", status: "Not recorded", state: "missed" });
    const planned = dayInfo(settings, activity, "2026-11-25", today);
    expect(planned).toMatchObject({ name: "Strength B", status: "Planned", state: "planned" });
    // A run on a rest day counts as other activity.
    const other = dayInfo(settings, activity, "2026-11-26", today);
    expect(other).toMatchObject({ name: "Rest", status: "Activity recorded", state: "done", other: true });
    const rest = dayInfo(settings, activity, "2026-11-29", today);
    expect(rest).toMatchObject({ status: "Rest day", state: "rest" });
  });

  test("boardLabel splits strength routine names", () => {
    expect(boardLabel("strength", "Strength A")).toEqual(["Strength", "A"]);
    expect(boardLabel("strength", "Legs")).toEqual(["Legs", ""]);
    expect(boardLabel("run", "Easy run")).toEqual(["Run", ""]);
    expect(boardLabel("rest", "Rest")).toEqual(["Rest", ""]);
  });

  test("recordedText names what was recorded", () => {
    const records = [record(finishedWorkout("2026-11-23")), record(run("2026-11-23"))];
    const info = dayInfo(settings, completedActivity(records), "2026-11-23", "2026-11-24");
    expect(recordedText(info, "2026-11-23", "2026-11-24")).toBe("Strength and run recorded on Mon 23 Nov 2026.");
    const runOnly = dayInfo(settings, completedActivity([record(run("2026-11-24"))]), "2026-11-24", "2026-11-24");
    expect(recordedText(runOnly, "2026-11-24", "2026-11-24")).toBe("Run recorded today.");
  });
});

describe("workouts", () => {
  test("activeWorkout finds the unfinished workout", () => {
    const open = record(createWorkout(settings, routineA, monday, true, []));
    expect(activeWorkout([record(finishedWorkout(monday)), open])?.id).toBe(open.id);
    expect(activeWorkout([record(finishedWorkout(monday))])).toBeUndefined();
  });

  test("workoutProgress counts done and skipped sets", () => {
    const workout = createWorkout(settings, routineA, monday, true, []);
    const [first, ...rest] = workout.exercises;
    if (!first) throw new Error("Routine has no exercises");
    const marked = {
      ...workout,
      exercises: [
        { ...first, sets: first.sets.map((set, index) => ({ ...set, done: index === 0, skipped: index === 1 })) },
        ...rest,
      ],
    };
    const total = workout.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0);
    expect(workoutProgress(marked)).toEqual({ handled: 2, total, fraction: 2 / total });
    expect(workoutProgress({ ...workout, exercises: [] }).fraction).toBe(0);
  });

  test("pips show done sessions, capped at seven", () => {
    expect(pips({ done: 1, planned: 3 })).toEqual([true, false, false]);
    expect(pips({ done: 4, planned: 2 })).toEqual([true, true, true, true]);
    expect(pips({ done: 9, planned: 9 })).toHaveLength(7);
  });

  test("rotationNote lists the routines", () => {
    expect(rotationNote(settings)).toStartWith("Repeating strength days take turns through Strength A, Strength B in calendar order.");
  });

  test("saveStatus follows the sync state", () => {
    const base = { online: true, saving: false, error: "", pending: 0, ready: true };
    expect(saveStatus(base)).toBe("Saved");
    expect(saveStatus({ ...base, online: false })).toBe("Offline · pending on device");
    expect(saveStatus({ ...base, saving: true })).toBe("Saving…");
    expect(saveStatus({ ...base, error: "Failed" })).toBe("Needs attention");
    expect(saveStatus({ ...base, pending: 2 })).toBe("2 pending");
    expect(saveStatus({ ...base, ready: false })).toBe("Loading…");
  });
});

describe("reorganising a week", () => {
  const today = "2026-11-24";

  test("past days and days with sessions are fixed", () => {
    const records = [record(createWorkout(settings, routineB, "2026-11-25", true, []))];
    expect(lockedDay("2026-11-23", today, records)).toBe(true);
    expect(lockedDay("2026-11-25", today, records)).toBe(true);
    expect(lockedDay("2026-11-26", today, records)).toBe(false);
    expect(movableDays(days, today, records)).toEqual(["2026-11-24", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
  });

  test("a move needs two open days and a planned session", () => {
    expect(canReorganise(settings, movableDays(days, today, []))).toBe(true);
    expect(canReorganise(settings, ["2026-11-29"])).toBe(false);
    expect(canReorganise(settings, ["2026-11-26", "2026-11-29"])).toBe(false);
  });

  test("the sheet opens on the first planned session", () => {
    const movable = movableDays(days, "2026-11-26", []);
    expect(moveSources(settings, movable)).toEqual(["2026-11-27", "2026-11-28"]);
    expect(firstMove(settings, movable)).toEqual({ from: "2026-11-27", to: "2026-11-26" });
    expect(moveDestinations(movable, "2026-11-27")).toEqual(["2026-11-26", "2026-11-28", "2026-11-29"]);
  });

  test("choosing the destination day as the source picks another destination", () => {
    const movable = ["2026-11-26", "2026-11-27", "2026-11-28"];
    expect(chooseSource(movable, "2026-11-27", "2026-11-27")).toEqual({ from: "2026-11-27", to: "2026-11-26" });
    expect(chooseSource(movable, "2026-11-28", "2026-11-26")).toEqual({ from: "2026-11-28", to: "2026-11-26" });
  });

  test("options and preview name both days", () => {
    expect(dayOption(settings, "2026-11-27")).toBe("Fri 27 Nov 2026 · Strength A");
    expect(movePreview(settings, "2026-11-27", "2026-11-29")).toBe(
      "Strength A moves to Sun 29 Nov 2026. Rest moves to Fri 27 Nov 2026.",
    );
    expect(movePreview(settings, "", "2026-11-29")).toBe("");
  });

  test("planMove swaps the sessions", () => {
    const origin = { settings, revision: 3 };
    const result = planMove(origin, { revision: 3, data: settings }, "2026-11-27", "2026-11-29", today, []);
    if (!("settings" in result)) throw new Error(result.error);
    expect(result.settings.dayPlans?.["2026-11-29"]).toEqual({ type: "strength", routine: routineA });
    expect(result.settings.dayPlans?.["2026-11-27"]).toEqual({ type: "rest", routine: null });
  });

  test("planMove stops when the plan changed on another device", () => {
    const origin = { settings, revision: 3 };
    const changed: Settings = { ...settings, goal: "Run further" };
    expect(planMove(origin, { revision: 4, data: changed }, "2026-11-27", "2026-11-29", today, [])).toEqual({
      error: "Your plan changed. Close this sheet and reopen it to use the saved plan.",
    });
    expect(planMove(origin, { revision: 3, data: changed }, "2026-11-27", "2026-11-29", today, [])).toHaveProperty("error");
  });

  test("planMove reports the shared rule's message", () => {
    const origin = { settings, revision: 1 };
    expect(planMove(origin, { revision: 1, data: settings }, "2026-11-23", "2026-11-27", today, [])).toEqual({
      error: "Choose today or an upcoming day.",
    });
    expect(planMove(origin, { revision: 1, data: settings }, "2026-11-26", "2026-11-29", today, [])).toEqual({
      error: "Choose a planned workout or run to move.",
    });
  });

  test("reset removes only this week's dated plans", () => {
    const moved = {
      ...settings,
      dayPlans: {
        "2026-11-27": { type: "rest" as const, routine: null },
        "2026-12-04": { type: "rest" as const, routine: null },
      },
    };
    expect(canResetWeek(settings, days)).toBe(false);
    expect(canResetWeek(moved, days)).toBe(true);
    expect(resetWeek(moved, days).dayPlans).toEqual({ "2026-12-04": { type: "rest", routine: null } });
  });

  test("the settings record id is the shared one", () => {
    expect(settingsId).toBe("00000000-0000-4000-8000-000000000001");
  });
});

describe("workout plan page", () => {
  test("planRoutine uses the requested routine or the day's plan", () => {
    expect(planRoutine(settings, "2026-11-23")?.routine.id).toBe(routineA.id);
    expect(planRoutine(settings, "2026-11-23", routineB.id)?.routine.id).toBe(routineB.id);
    expect(planRoutine(settings, "2026-11-24")).toBeUndefined();
    expect(planRoutine(settings, "2026-11-24", routineB.id)?.routine.id).toBe(routineB.id);
    expect(planRoutine(settings, "not-a-day", routineA.id)).toBeUndefined();
    expect(planRoutine(settings, "2026-11-23", "00000000-0000-4000-8000-0000000000ff")).toBeUndefined();
    expect(planRoutine(settings, "2026-11-23")?.intro).toBe(true);
  });

  test("recordedWorkout finds the finished workout for the routine and date", () => {
    const records = [record(finishedWorkout("2026-11-23")), record(createWorkout(settings, routineB, "2026-11-25", true, []))];
    expect(recordedWorkout(records, "2026-11-23", routineA.id)).toBeDefined();
    expect(recordedWorkout(records, "2026-11-23", routineB.id)).toBeUndefined();
    expect(recordedWorkout(records, "2026-11-25", routineB.id)).toBeUndefined();
  });

  test("planAction words today, past and future plans", () => {
    expect(planAction(settings, routineA, "2026-11-25", "2026-11-25", true)).toEqual({
      workoutDate: "2026-11-25",
      label: "Start workout",
      note: "Start when you are ready to train. This begins your session and elapsed timer.",
    });
    const past = planAction(settings, routineA, "2026-11-23", "2026-11-25", true);
    expect(past.workoutDate).toBe("2026-11-23");
    expect(past.label).toBe("Log workout for Mon 23 Nov 2026");
    expect(past.note).toBe(
      "Log workout opens a workout dated Mon 23 Nov 2026 for results you have already done. Do this workout today records it for Wed 25 Nov 2026.",
    );
    const future = planAction(settings, routineA, "2026-11-27", "2026-11-25", true);
    expect(future.workoutDate).toBe("2026-11-25");
    expect(future.label).toBe("Do this workout today");
    expect(future.note).toBe("This starts Strength A now and records it for today, Wed 25 Nov 2026.");
  });

  test("planAction explains a change between introduction and full sets", () => {
    // The introduction lasts two weeks from 23 Nov, so 7 Dec uses full sets.
    expect(planAction(settings, routineA, "2026-12-09", "2026-12-07", true).note).toEndWith(" Today uses full sets.");
    expect(planAction(settings, routineA, "2026-12-09", "2026-11-25", false).note).toEndWith(
      " Today is in your introduction weeks, so each exercise has up to 2 sets.",
    );
  });
});

describe("recording a run", () => {
  const today = "2026-11-25";

  test("parseRun accepts a completed run", () => {
    expect(parseRun({ date: "2026-11-24", minutes: "32.5", distance: "5,2", notes: "Easy" }, today)).toEqual({
      run: { kind: "run", date: "2026-11-24", minutes: 32.5, distanceKm: 5.2, notes: "Easy" },
    });
    expect(parseRun({ date: today, minutes: "20", distance: "0", notes: "" }, today)).toHaveProperty("run");
  });

  test("parseRun rejects missing or out-of-range values", () => {
    const error = { error: "Enter a valid date, duration and distance." };
    expect(parseRun({ date: today, minutes: "", distance: "5", notes: "" }, today)).toEqual(error);
    expect(parseRun({ date: today, minutes: "0", distance: "5", notes: "" }, today)).toEqual(error);
    expect(parseRun({ date: today, minutes: "1441", distance: "5", notes: "" }, today)).toEqual(error);
    expect(parseRun({ date: today, minutes: "30", distance: "", notes: "" }, today)).toEqual(error);
    expect(parseRun({ date: today, minutes: "30", distance: "501", notes: "" }, today)).toEqual(error);
    expect(parseRun({ date: today, minutes: "30", distance: "-1", notes: "" }, today)).toEqual(error);
    expect(parseRun({ date: "today", minutes: "30", distance: "5", notes: "" }, today)).toEqual(error);
    expect(parseRun({ date: today, minutes: "30", distance: "5", notes: "x".repeat(2001) }, today)).toEqual(error);
  });

  test("parseRun rejects a future date", () => {
    expect(parseRun({ date: "2026-11-26", minutes: "30", distance: "5", notes: "" }, today)).toEqual({
      error: "Record a run on Wed 25 Nov 2026 or an earlier date.",
    });
  });

  test("runForm starts a new run no later than today", () => {
    expect(runForm(undefined, "2026-11-28", today)).toEqual({ date: today, minutes: "", distance: "", notes: "" });
    expect(runForm(undefined, "2026-11-24", today).date).toBe("2026-11-24");
    const saved = { kind: "run" as const, date: "2026-11-20", minutes: 30, distanceKm: 4.5, notes: "Park" };
    expect(runForm(saved, "2026-11-20", today)).toEqual({ date: "2026-11-20", minutes: "30", distance: "4.5", notes: "Park" });
    expect(runSummary(saved)).toBe("Fri 20 Nov 2026 · 30 min · 4.5 km");
  });

  test("editStatus compares the opened version with the saved one", () => {
    const data = run("2026-11-24");
    const opened = { id: "00000000-0000-4000-8000-000000000999", revision: 2, data };
    expect(editStatus(undefined, undefined)).toBe("current");
    expect(editStatus(opened, { revision: 2, data: { ...data } })).toBe("current");
    expect(editStatus(opened, { revision: 3, data })).toBe("changed");
    expect(editStatus(opened, { revision: 2, data: run("2026-11-24", 40) })).toBe("changed");
    expect(editStatus(opened, { revision: 3, data: null })).toBe("removed");
    expect(editStatus(opened, undefined)).toBe("removed");
  });
});
