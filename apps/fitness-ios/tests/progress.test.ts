import { describe, expect, test } from "bun:test";
import { exercises } from "@bent/fitness-contracts/domain";
import type { Entity, RecordEntry, Workout } from "@bent/fitness-contracts/domain";
import { dailyWeights } from "@bent/fitness-contracts/progress";
import type { StrengthSeries, WeekSummary } from "@bent/fitness-contracts/progress";
import { applyText, changeSet, commitTyped, fieldKey, fieldText, setKeys, without } from "../src/screens/progress/correction-inputs";
import {
  correctionStatus,
  correctionText,
  correctionsByWorkout,
  editStatus,
  groupFor,
  finishedOriginals,
  groupByDate,
  historySessions,
  openCorrection,
  otherCorrection,
  removalFor,
  removedWorkouts,
  sessionLabel,
} from "../src/screens/progress/history";
import { createNotice } from "../src/screens/progress/notice";
import {
  bodyChart,
  chartScale,
  countSpoken,
  countText,
  daysBetween,
  parseWeighIn,
  pointText,
  recentSessions,
  replacedWeighIn,
  sessionDetail,
  shownWeeks,
  shownWeight,
  strengthChange,
  strengthLabels,
  strengthSummary,
  trendText,
  weekBarLabels,
  weekBars,
  weighInLabels,
  weighInOn,
  weightChange,
  weightLimits,
} from "../src/screens/progress/summary";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let revision = 0;
const entry = (n: number, data: Entity, updatedAt = "2026-11-01T00:00:00.000Z"): RecordEntry => ({
  id: id(n),
  revision: ++revision,
  data,
  updatedAt,
});

const found = exercises.find((e) => e.id === "squat");
if (!found) throw new Error("Missing exercise fixtures");
const squat = found;

function workout(date: string, loadKg = 10, finished = true, value = 10): Workout {
  return {
    kind: "workout",
    date,
    routineId: id(900),
    name: "Strength A",
    startedAt: `${date}T08:00:00.000Z`,
    finishedAt: finished ? `${date}T09:00:00.000Z` : null,
    notes: "",
    restUntil: null,
    exercises: [
      {
        prescription: squat,
        sets: Array.from({ length: squat.sets }, () => ({
          loadKg,
          value,
          right: null,
          done: true,
          skipped: false,
          rir: 2,
          controlled: true,
        })),
      },
    ],
  };
}
const run = (date: string): Entity => ({ kind: "run", date, minutes: 30, distanceKm: 5, notes: "" });
const weight = (date: string, kg: number): Entity => ({ kind: "weight", date, kg });

describe("progress summary", () => {
  test("formats counts and weights", () => {
    expect(countText({ done: 2, planned: 3 })).toBe("2/3");
    expect(countText({ done: 1, planned: 0 })).toBe("1 done");
    expect(countSpoken({ done: 1, planned: 3 }, "run")).toBe("1 of 3 runs done");
    expect(countSpoken({ done: 1, planned: 0 }, "strength session")).toBe("1 strength session done");
    expect(shownWeight(80, "kg")).toBe("80.0 kg");
    expect(shownWeight(80, "lb")).toBe("176.4 lb");
  });

  test("shows weeks from the plan start or with sessions", () => {
    const weeks: WeekSummary[] = [
      { monday: "2026-11-02", strength: { done: 0, planned: 0 }, runs: { done: 0, planned: 0 } },
      { monday: "2026-11-09", strength: { done: 1, planned: 0 }, runs: { done: 0, planned: 0 } },
      { monday: "2026-11-16", strength: { done: 0, planned: 3 }, runs: { done: 0, planned: 2 } },
    ];
    expect(shownWeeks(weeks, "2026-11-18").map((w) => w.monday)).toEqual(["2026-11-09", "2026-11-16"]);
    const bars = weekBars(weeks.slice(2));
    expect(bars).toEqual([
      { x: "16 Nov", y: 0, part: "strength" },
      { x: "16 Nov", y: 0, part: "runs" },
      { x: "16 Nov", y: 5, part: "open" },
    ]);
  });

  test("summarises strength by load or by reps", () => {
    const byLoad: StrengthSeries = {
      key: "squat:reps:single",
      name: "Goblet squat",
      mode: "reps",
      side: false,
      load: "dumbbell",
      points: [
        { date: "2026-11-02", loadKg: 10, value: 10 },
        { date: "2026-11-09", loadKg: 12.5, value: 8 },
      ],
    };
    const summary = strengthSummary(byLoad, "kg");
    expect(summary?.measure).toBe("Heaviest completed set, kg per dumbbell");
    expect(summary?.change).toBe("+2.5 kg");
    expect(summary?.values).toEqual([10, 12.5]);
    expect(summary?.chip).toBe("Reps · Per dumbbell");

    const [first] = byLoad.points;
    if (!first) throw new Error("The series has a first point.");
    const byReps: StrengthSeries = { ...byLoad, points: [first, { date: "2026-11-09", loadKg: 10, value: 12 }] };
    expect(strengthSummary(byReps, "kg")?.measure).toBe("Reps at 10 kg per dumbbell");
    expect(strengthSummary({ ...byReps, load: "barbell" }, "kg")).toMatchObject({ measure: "Reps at 10 kg on the bar", chip: "Reps · Whole bar" });
    expect(strengthSummary(byReps, "kg")?.change).toBe("+2 reps");

    const hold: StrengthSeries = {
      key: "plank:seconds:single",
      name: "Forearm plank",
      mode: "seconds",
      side: true,
      load: "bodyweight",
      points: [
        { date: "2026-11-02", loadKg: 0, value: 30 },
        { date: "2026-11-09", loadKg: 0, value: 30 },
      ],
    };
    expect(strengthSummary(hold, "kg")?.change).toBe("No change");
    expect(strengthSummary(hold, "kg")?.chip).toBe("Timed · each side");
    expect(pointText({ date: "2026-11-02", loadKg: 0, value: 30 }, hold, "kg")).toBe("30 s each side");
    expect(strengthSummary({ ...hold, points: [] }, "kg")).toBeNull();
  });

  test("describes the weight trend", () => {
    expect(trendText({ change: null, comparedCount: 0 }, "kg")).toBe("Record more than 7 weigh-ins to compare averages.");
    expect(trendText({ change: -0.5, comparedCount: 1 }, "kg")).toBe("−0.5 kg compared with the 1 weigh-in before.");
    expect(trendText({ change: 0, comparedCount: 7 }, "kg")).toBe("±0.0 kg compared with the 7 weigh-ins before.");
  });

  test("lists recent sessions with corrections applied", () => {
    const records = [
      entry(1, workout("2026-11-02")),
      entry(2, run("2026-11-04")),
      entry(3, workout("2026-11-05", 10, false)),
      entry(4, { kind: "workoutCorrection", workoutId: id(1), replacement: null, reason: "Removed from history" }),
    ];
    const recent = recentSessions(records, 5);
    expect(recent.map((s) => s.id)).toEqual([id(2)]);
    expect(sessionDetail(recent[0] ?? { id: "", data: workout("2026-11-02") })).toBe("30 min · 5 km");
    expect(sessionDetail({ id: id(1), data: workout("2026-11-02") })).toBe("3 sets done");
  });

  test("scales charts to their range", () => {
    const scale = chartScale([80, 82], 0.5);
    expect(scale.shift(80)).toBe(0.5);
    expect(scale.shift(82)).toBe(2.5);
    expect(scale.top).toBe(3);
    expect(daysBetween("2026-11-01", "2026-11-08")).toBe(7);
  });

  test("builds the bodyweight chart from the latest weigh-in per date", () => {
    const records = [
      entry(10, weight("2026-11-01", 80)),
      entry(11, weight("2026-11-02", 81)),
      entry(12, weight("2026-11-02", 82)),
      entry(13, weight("2026-11-03", 79)),
    ];
    const chart = bodyChart(dailyWeights(records));
    expect(chart.points.map((p) => p.kg)).toEqual([80, 82, 79]);
    expect(chart.trend.map((p) => p.kg)).toEqual([80, 81, 241 / 3]);
    expect(chart.lowest).toBe(79);
    expect(chart.highest).toBe(82);
    expect(chart.average).toBe(241 / 3);
    expect(weighInOn(records, "2026-11-02")?.kg).toBe(82);
    expect(replacedWeighIn(records, "2026-11-02")).toBe(id(11));
    expect(bodyChart([]).average).toBeNull();
  });

  test("checks typed weigh-ins", () => {
    expect(weightLimits("kg")).toEqual({ min: 20, max: 500 });
    expect(weightLimits("lb")).toEqual({ min: 44.1, max: 1102.3 });
    expect(parseWeighIn("2026-11-02", "", "kg")).toEqual({ error: "Enter a valid date and weight." });
    expect(parseWeighIn("2026-11-02", "12", "kg")).toEqual({ error: "Enter a weight from 20 to 500 kg." });
    expect(parseWeighIn("", "80", "kg")).toEqual({ error: "Enter a valid date and weight." });
    expect(parseWeighIn("2026-11-02", "80,5", "kg")).toEqual({ data: { kind: "weight", date: "2026-11-02", kg: 80.5 } });
    const pounds = parseWeighIn("2026-11-02", "176.4", "lb");
    expect("data" in pounds && Math.round(pounds.data.kg * 10) / 10).toBe(80);
  });
});

describe("chart popovers", () => {
  const goblet: StrengthSeries = {
    key: "squat:reps:0",
    name: "Goblet squat",
    mode: "reps",
    side: false,
    load: "dumbbell",
    points: [
      { date: "2026-11-02", loadKg: 10, value: 8 },
      { date: "2026-11-04", loadKg: 12, value: 8 },
      { date: "2026-11-06", loadKg: 12, value: 10 },
      { date: "2026-11-09", loadKg: 12, value: 9 },
    ],
  };

  test("each session shows its best set and the change since the one before", () => {
    expect(strengthLabels(goblet, "kg")).toEqual([
      { title: "Mon 2 Nov", detail: "10 kg × 8\nFirst in this chart" },
      { title: "Wed 4 Nov", detail: "12 kg × 8\n+2 kg since Mon 2 Nov" },
      { title: "Fri 6 Nov", detail: "12 kg × 10\n+2 reps since Wed 4 Nov" },
      { title: "Mon 9 Nov", detail: "12 kg × 9\n−1 rep since Fri 6 Nov" },
    ]);
    expect(strengthLabels(goblet, "lb")[1]?.detail).toBe("26.46 lb × 8\n+4.41 lb since Mon 2 Nov");
  });

  test("timed and sided exercises say so, and an unchanged session says no change", () => {
    const plank: StrengthSeries = {
      key: "plank:seconds:0",
      name: "Plank",
      mode: "seconds",
      side: false,
      load: "bodyweight",
      points: [
        { date: "2026-11-02", loadKg: 0, value: 30 },
        { date: "2026-11-04", loadKg: 0, value: 45 },
        { date: "2026-11-06", loadKg: 0, value: 45 },
      ],
    };
    expect(strengthLabels(plank, "kg").map((label) => label.detail)).toEqual([
      "30 s\nFirst in this chart",
      "45 s\n+15 s since Mon 2 Nov",
      "45 s\nNo change since Wed 4 Nov",
    ]);
    expect(strengthLabels({ ...goblet, side: true }, "kg")[0]?.detail).toBe("10 kg × 8 each side\nFirst in this chart");
    expect(
      strengthChange({ date: "2026-11-02", loadKg: 12, value: 8 }, { date: "2026-11-04", loadKg: 10, value: 12 }, goblet, "kg"),
    ).toBe("−2 kg");
  });

  test("each weigh-in shows its value, its average when charted and the change", () => {
    const points = [
      { date: "2026-11-02", kg: 80.5 },
      { date: "2026-11-03", kg: 80.25 },
      { date: "2026-11-05", kg: 81.2 },
    ];
    expect(weighInLabels(points, "kg", [80.5, 80.375, 80.65])).toEqual([
      { title: "Mon 2 Nov", detail: "80.5 kg\nAverage of 1: 80.5 kg" },
      { title: "Tue 3 Nov", detail: "80.3 kg\nAverage of 2: 80.4 kg\n−0.3 kg since Mon 2 Nov" },
      { title: "Thu 5 Nov", detail: "81.2 kg\nAverage of 3: 80.7 kg\n+1.0 kg since Tue 3 Nov" },
    ]);
    expect(weighInLabels(points, "lb").map((label) => label.detail)).toEqual([
      "177.5 lb",
      "176.9 lb\n−0.6 lb since Mon 2 Nov",
      "179.0 lb\n+2.1 lb since Tue 3 Nov",
    ]);
    // The average counts at most 7 weigh-ins.
    const many = Array.from({ length: 9 }, (_, i) => ({ date: `2026-11-1${i}`, kg: 80 }));
    expect(weighInLabels(many, "kg", many.map(() => 80))[8]?.detail).toBe("80.0 kg\nAverage of 7: 80.0 kg\nNo change since Tue 17 Nov");
  });

  test("weight changes carry a sign, and one that rounds away is no change", () => {
    expect(weightChange(0.44, "kg")).toBe("+0.4 kg");
    expect(weightChange(-1.25, "kg")).toBe("−1.3 kg");
    expect(weightChange(0.02, "kg")).toBe("No change");
    expect(weightChange(1, "lb")).toBe("+2.2 lb");
  });

  test("each week shows its sessions, in the order of the bars", () => {
    const weeks: WeekSummary[] = [
      { monday: "2026-11-02", strength: { planned: 3, done: 2 }, runs: { planned: 2, done: 2 } },
      { monday: "2026-11-09", strength: { planned: 0, done: 1 }, runs: { planned: 0, done: 0 } },
    ];
    expect(weekBarLabels(weeks)).toEqual([
      { title: "Week of 2 Nov", detail: "Strength 2/3\nRuns 2/2\n1 planned, not recorded" },
      { title: "Week of 9 Nov", detail: "Strength 1 done\nRuns 0 done" },
    ]);
    // One label for each bar position.
    expect(new Set(weekBars(weeks).map((bar) => bar.x)).size).toBe(weekBarLabels(weeks).length);
  });
});

describe("history", () => {
  const original = entry(20, workout("2026-11-02"), "2026-11-02T09:00:00.000Z");
  const second = entry(21, workout("2026-11-02"), "2026-11-02T18:00:00.000Z");
  const easy = entry(22, run("2026-11-03"));
  const removedOne = entry(23, workout("2026-10-30"));
  const removal = entry(24, { kind: "workoutCorrection", workoutId: id(23), replacement: null, reason: "Removed from history" });
  const fix = entry(25, {
    kind: "workoutCorrection",
    workoutId: id(20),
    replacement: { ...workout("2026-11-01", 12), finishedAt: "2026-11-02T09:00:00.000Z" },
    reason: "Wrong weight",
  });
  const records = [original, second, easy, removedOne, removal, fix];

  test("groups corrected sessions by date, newest first", () => {
    const sessions = historySessions(records);
    expect(sessions.map((s) => s.id)).toEqual([id(22), id(21), id(20)]);
    expect(sessions.find((s) => s.id === id(20))?.data.date).toBe("2026-11-01");
    expect(groupByDate(sessions).map((g) => [g.date, g.sessions.length])).toEqual([
      ["2026-11-03", 1],
      ["2026-11-02", 1],
      ["2026-11-01", 1],
    ]);
    expect(groupFor(groupByDate(sessions), "2026-11-02")).toBe("2026-11-02");
    expect(groupFor(groupByDate(sessions), "2026-11-10")).toBe("2026-11-03");
    expect(groupFor(groupByDate(sessions), "2026-10-01")).toBeUndefined();
    expect(sessions[0] && sessionLabel(sessions[0])).toBe("Easy run on Tue 3 Nov 2026");
  });

  test("lists removed workouts and builds removals", () => {
    expect(removedWorkouts(records).map((r) => r.original.id)).toEqual([id(23)]);
    const corrections = correctionsByWorkout(records);
    expect(corrections.get(id(20))?.id).toBe(id(25));
    const originals = finishedOriginals(records);
    const first = originals.get(id(20));
    if (!first) throw new Error("Missing original");
    const change = removalFor(first, corrections.get(id(20)));
    expect(change).toEqual({
      data: { kind: "workoutCorrection", workoutId: id(20), replacement: null, reason: "Removed from history" },
      id: id(25),
      revision: fix.revision,
    });
    const fresh = removalFor({ ...second, data: workout("2026-11-02") }, undefined);
    expect(fresh.id).toBeUndefined();
    expect(fresh.revision).toBe(0);
  });

  test("opens corrections from the saved correction or the original", () => {
    const first = finishedOriginals(records).get(id(20));
    if (!first) throw new Error("Missing original");
    const corrections = correctionsByWorkout(records);
    const opened = openCorrection(first, corrections.get(id(20)), () => id(99));
    expect(opened.version).toEqual({ id: id(25), revision: fix.revision, data: fix.data.kind === "workoutCorrection" ? fix.data : null });
    expect(opened.workout.date).toBe("2026-11-01");
    expect(opened.workout.finishedAt).toBeNull();
    expect(opened.reason).toBe("Wrong weight");
    const blank = openCorrection(first, undefined, () => id(99));
    expect(blank.version).toEqual({ id: id(99), revision: 0, data: null });
    expect(blank.workout.date).toBe("2026-11-02");
    expect(blank.reason).toBe("");
  });

  test("detects corrections changed or removed elsewhere", () => {
    const saved = fix.data.kind === "workoutCorrection" ? fix.data : null;
    const opened = { id: id(25), revision: fix.revision, data: saved };
    expect(correctionStatus(opened, { revision: fix.revision, data: saved }, undefined)).toBe("current");
    expect(correctionStatus(opened, { revision: fix.revision + 1, data: saved }, undefined)).toBe("changed");
    expect(correctionStatus(opened, { revision: fix.revision + 1, data: null }, undefined)).toBe("removed");
    expect(correctionStatus(opened, { revision: fix.revision, data: saved }, { id: id(30) })).toBe("changed");
    const fresh = { id: id(31), revision: 0, data: null };
    expect(correctionStatus(fresh, { revision: 0, data: null }, undefined)).toBe("current");
    expect(correctionStatus(fresh, { revision: 1, data: saved }, undefined)).toBe("changed");
    expect(editStatus(undefined, undefined)).toBe("current");
    expect(otherCorrection(records, id(20), id(31))?.id).toBe(id(25));
    expect(otherCorrection(records, id(20), id(25))).toBeUndefined();
    expect(correctionText(saved ?? undefined)).toBe("Sun 1 Nov 2026 · Wrong weight");
    expect(correctionText({ kind: "workoutCorrection", workoutId: id(20), replacement: null, reason: "x" })).toBe(
      "removed from History",
    );
  });
});

describe("correction inputs", () => {
  const draft: Workout = { ...workout("2026-11-02"), finishedAt: null };

  test("shows typed text or the saved value", () => {
    const key = fieldKey(0, 0, "loadKg");
    expect(fieldText(draft, {}, key, "kg")).toBe("10");
    expect(fieldText(draft, {}, key, "lb")).toBe("22.05");
    expect(fieldText(draft, { [key]: { text: "20", units: "kg" } }, key, "lb")).toBe("44.09");
    expect(fieldText(draft, {}, "notes", "kg")).toBe("");
    expect(setKeys(1, 2)).toEqual(["1:2:loadKg", "1:2:value", "1:2:right", "1:2:rir"]);
  });

  test("validates typed values like the workout editor", () => {
    expect(applyText(draft, "0:0:value", "", "kg")).toBe("Enter reps as a number of 0 or more.");
    expect(applyText(draft, "0:0:value", "8.5", "kg")).toBe("Enter reps as a whole number.");
    expect(applyText(draft, "0:0:rir", "11", "kg")).toBe("Enter reps left as a whole number from 0 to 10.");
    expect(applyText(draft, "0:0:loadKg", "1001", "kg")).toBe("Enter a weight up to 1000 kg.");
    expect(applyText(draft, "0:0:value", "601", "kg")).toBe("Enter reps up to 600.");
    expect(applyText(draft, "9:0:value", "8", "kg")).toBeNull();
    const next = applyText(draft, "0:1:loadKg", "12,5", "kg");
    expect(typeof next === "object" && next?.exercises[0]?.sets[1]?.loadKg).toBe(12.5);
  });

  test("commits typed values and set actions", () => {
    const typed = {
      "0:0:value": { text: "12", units: "kg" as const },
      "0:1:value": { text: "abc", units: "kg" as const },
    };
    const blocked = commitTyped(draft, typed);
    expect(blocked).toEqual({ status: "invalid", errors: { "0:1:value": "Enter reps as a number of 0 or more." } });

    const one = commitTyped(draft, typed, { keys: setKeys(0, 0) });
    expect(one.status === "saved" && one.workout.exercises[0]?.sets[0]?.value).toBe(12);
    expect(one.status === "saved" && one.done).toEqual(["0:0:value"]);

    const skipped = commitTyped(draft, typed, {
      keys: setKeys(0, 1),
      dropInvalid: true,
      change: (w) => changeSet(w, 0, 1, { skipped: true, done: false }),
    });
    expect(skipped.status === "saved" && skipped.workout.exercises[0]?.sets[1]?.skipped).toBe(true);
    expect(skipped.status === "saved" && skipped.done).toEqual(["0:1:value"]);

    const zero = commitTyped(draft, { "0:0:value": { text: "0", units: "kg" } });
    expect(zero).toEqual({ status: "problem", message: "Enter a result for each completed set and both sides." });
    expect(without({ a: 1, b: 2 }, ["a"])).toEqual({ b: 2 });
  });
});

describe("history notice", () => {
  test("notifies subscribers of changes", () => {
    const notice = createNotice();
    let calls = 0;
    const stop = notice.subscribe(() => calls++);
    notice.set("Saved");
    notice.set("Saved");
    expect(notice.get()).toBe("Saved");
    expect(calls).toBe(1);
    stop();
    notice.set("");
    expect(calls).toBe(1);
  });
});

