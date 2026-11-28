import { describe, expect, test } from "bun:test";
import { createWorkout, defaultSettings } from "../src/domain";
import type { Entity, RecordEntry, Settings } from "../src/domain";
import {
  canReorganise,
  canResetWeek,
  lockedDay,
  movableDays,
  planProgress,
  planWeek,
  reorderPreview,
  reorderWeek,
  resetWeek,
  weekDays,
  weekSlots,
} from "../src/week";

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

describe("weekly plan progress", () => {
  test("weekDays lists Monday to Sunday", () => {
    expect(days).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
  });

  test("planProgress fills towards the plan and is met once every planned session is done", () => {
    expect(planProgress({ done: 1, planned: 4 })).toEqual({ met: false, fraction: 0.25 });
    expect(planProgress({ done: 3, planned: 3 })).toEqual({ met: true, fraction: 1 });
    expect(planProgress({ done: 3, planned: 2 })).toEqual({ met: true, fraction: 1 });
    expect(planProgress({ done: 1, planned: 0 })).toEqual({ met: true, fraction: 1 });
    expect(planProgress({ done: 0, planned: 0 })).toBeNull();
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

  test("the list shows every day with fixed days locked", () => {
    const records = [record(createWorkout(settings, routineB, "2026-11-25", true, []))];
    expect(weekSlots(settings, days, days, today, records).map(({ session, locked }) => [session, locked])).toEqual([
      ["Strength A", true],
      ["Easy run", false],
      ["Strength B", true],
      ["Rest", false],
      ["Strength A", false],
      ["Easy run", false],
      ["Rest", false],
    ]);
  });

  test("a drag moves the session and shifts the open days between", () => {
    const locked = days.map((day) => lockedDay(day, today, []));
    // Tuesday's run dragged below Thursday's rest: Wednesday and Thursday shift up.
    expect(reorderWeek(days, locked, [1], 4)).toEqual([
      "2026-11-23",
      "2026-11-25",
      "2026-11-26",
      "2026-11-24",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
    ]);
    // Sunday dragged to the top lands on the first open day, after the fixed Monday.
    expect(reorderWeek(days, locked, [6], 0)).toEqual([
      "2026-11-23",
      "2026-11-29",
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
    ]);
  });

  test("fixed days never move", () => {
    const locked = days.map((day) => lockedDay(day, "2026-11-28", []));
    expect(reorderWeek(days, locked, [2], 6)).toBe(days);
    // A drop above the fixed days lands on the first open one.
    expect(reorderWeek(days, locked, [6], 1)).toEqual([...days.slice(0, 5), "2026-11-29", "2026-11-28"]);
    expect(reorderWeek(days, locked, [5], 7)).toEqual([...days.slice(0, 5), "2026-11-29", "2026-11-28"]);
  });

  test("the preview names each day whose session changes", () => {
    expect(reorderPreview(settings, days, days)).toBe("");
    const order = [...days.slice(0, 5), "2026-11-29", "2026-11-28"];
    expect(reorderPreview(settings, days, order)).toBe("2 days change: Sat 28, Sun 29.");
    // Swapping two rest days changes nothing.
    expect(reorderPreview(settings, days, [days[0]!, days[1]!, days[2]!, "2026-11-29", days[4]!, days[5]!, "2026-11-26"])).toBe("");
  });

  test("planWeek saves the arrangement with the shared rule", () => {
    const origin = { settings, revision: 3 };
    const locked = days.map((day) => lockedDay(day, today, []));
    const order = reorderWeek(days, locked, [1], 4);
    const result = planWeek(origin, { revision: 3, data: settings }, days, order, today, []);
    if (!("settings" in result)) throw new Error(result.error);
    expect(weekSlots(result.settings, days, days, today, []).map(({ session }) => session)).toEqual([
      "Strength A",
      "Strength B",
      "Rest",
      "Easy run",
      "Strength A",
      "Easy run",
      "Rest",
    ]);
    expect(result.settings.dayPlans?.["2026-11-25"]).toEqual({ type: "rest", routine: null });
    expect(Object.keys(result.settings.dayPlans ?? {}).sort()).toEqual(["2026-11-24", "2026-11-25", "2026-11-26"]);
  });

  test("planWeek keeps routines and leaves matching days alone", () => {
    const origin = { settings, revision: 1 };
    // Friday's Strength A to Tuesday: Tuesday to Friday shift by a day.
    const locked = days.map((day) => lockedDay(day, today, []));
    const order = reorderWeek(days, locked, [4], 1);
    const result = planWeek(origin, { revision: 1, data: settings }, days, order, today, []);
    if (!("settings" in result)) throw new Error(result.error);
    expect(result.settings.dayPlans?.["2026-11-24"]).toEqual({ type: "strength", routine: routineA });
    expect(result.settings.dayPlans?.["2026-11-25"]).toEqual({ type: "run", routine: null });
    expect(result.settings.dayPlans?.["2026-11-26"]).toEqual({ type: "strength", routine: routineB });
    expect(result.settings.dayPlans?.["2026-11-27"]).toEqual({ type: "rest", routine: null });
    expect(result.settings.dayPlans?.["2026-11-23"]).toBeUndefined();
  });

  test("planWeek works around fixed days with matching sessions", () => {
    // Wednesday's Strength B is recorded; Friday's Strength A moves to Thursday.
    const records = [record(finishedWorkout("2026-11-25", routineB))];
    const locked = days.map((day) => lockedDay(day, today, records));
    const order = reorderWeek(days, locked, [4], 3);
    const result = planWeek({ settings, revision: 1 }, { revision: 1, data: settings }, days, order, today, records);
    if (!("settings" in result)) throw new Error(result.error);
    expect(result.settings.dayPlans?.["2026-11-26"]).toEqual({ type: "strength", routine: routineA });
    expect(result.settings.dayPlans?.["2026-11-27"]).toEqual({ type: "rest", routine: null });
    expect(result.settings.dayPlans?.["2026-11-25"]).toBeUndefined();
  });

  test("planWeek writes dated plans only for days whose session changes", () => {
    // Friday's Strength A dragged below a weekend of two runs.
    const weekend: Settings = { ...settings, dayPlans: { "2026-11-29": { type: "run", routine: null } } };
    const friday = "2026-11-27";
    const locked = days.map((day) => lockedDay(day, friday, []));
    const order = reorderWeek(days, locked, [4], 7);
    const result = planWeek({ settings: weekend, revision: 1 }, { revision: 1, data: weekend }, days, order, friday, []);
    if (!("settings" in result)) throw new Error(result.error);
    expect(result.settings.dayPlans).toEqual({
      "2026-11-27": { type: "run", routine: null },
      "2026-11-29": { type: "strength", routine: routineA },
    });
  });

  test("an edited routine counts as a different session", () => {
    // Tuesday keeps a dated copy of Strength A from before it was renamed.
    const older = { ...routineA, name: "Strength A (old)" };
    const moved: Settings = { ...settings, dayPlans: { "2026-11-24": { type: "strength", routine: older } } };
    const order = ["2026-11-23", "2026-11-27", "2026-11-25", "2026-11-26", "2026-11-24", "2026-11-28", "2026-11-29"];
    expect(reorderPreview(moved, days, order)).toBe("2 days change: Tue 24, Fri 27.");
    const result = planWeek({ settings: moved, revision: 1 }, { revision: 1, data: moved }, days, order, today, []);
    if (!("settings" in result)) throw new Error(result.error);
    expect(result.settings.dayPlans?.["2026-11-24"]).toEqual({ type: "strength", routine: routineA });
    expect(result.settings.dayPlans?.["2026-11-27"]).toEqual({ type: "strength", routine: older });
  });

  test("planWeek stops when the plan changed on another device", () => {
    const origin = { settings, revision: 3 };
    const changed: Settings = { ...settings, goal: "Run further" };
    const order = [...days.slice(0, 5), "2026-11-29", "2026-11-28"];
    expect(planWeek(origin, { revision: 4, data: changed }, days, order, today, [])).toEqual({
      error: "Your plan changed. Close this sheet and reopen it to use the saved plan.",
    });
    expect(planWeek(origin, { revision: 3, data: changed }, days, order, today, [])).toHaveProperty("error");
  });

  test("planWeek only saves an arrangement of the week it was given", () => {
    const origin = { settings, revision: 1 };
    const latest = { revision: 1, data: settings };
    const error = { error: "The week changed. Close this sheet and reopen it to arrange the week shown." };
    // A draft from another week, or with a day missing or repeated, is refused.
    expect(planWeek(origin, latest, weekDays("2026-11-30"), days, today, [])).toEqual(error);
    expect(planWeek(origin, latest, days, days.slice(1), today, [])).toEqual(error);
    expect(planWeek(origin, latest, days, [days[1]!, ...days.slice(1)], today, [])).toEqual(error);
  });

  test("planWeek stops when a session was recorded on a changed day", () => {
    // A session recorded after the sheet opened fixes its day.
    const order = [...days.slice(0, 5), "2026-11-29", "2026-11-28"];
    const records = [record(run("2026-11-29"))];
    expect(planWeek({ settings, revision: 1 }, { revision: 1, data: settings }, days, order, today, records)).toEqual({
      error: "A session was recorded or started on one of these days. Close this sheet and reopen it to see the current week.",
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
});
