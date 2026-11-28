import { describe, expect, test } from "bun:test";
import { createWorkout, defaultSettings, sessionMinutes, withNutrient } from "@bent/fitness-contracts/domain";
import type { Entity, RecordEntry, Settings } from "@bent/fitness-contracts/domain";
import { WidgetPublisher, signedOutSnapshot, widgetDays, widgetLink, widgetSnapshot } from "../src/logic/widget";
import type { WidgetDay, WidgetSnapshot, WidgetStore } from "../src/logic/widget";

// Synthetic plan: Monday 23 Nov 2026 starts a week of
// Strength A, run, Strength B, rest, Strength A, run, rest.
const monday = "2026-11-23";
const settings = defaultSettings(monday, "UTC");
const [routineA] = settings.routines;
const scheme = "build.bent.fitness.dev";
const at = (iso: string) => Date.parse(iso);

let counter = 0;
function record(data: Entity): RecordEntry {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    revision: 1,
    data,
    updatedAt: "2026-11-23T08:00:00.000Z",
  };
}
function workout(date: string, finished: boolean) {
  if (!routineA) throw new Error("The default plan has Strength A.");
  const started = createWorkout(settings, routineA, date, true, []);
  return finished ? { ...started, finishedAt: `${date}T09:00:00.000Z` } : started;
}
const meal = (date: string, calories: number, protein: number, extra: Partial<Record<"carbs" | "fat" | "fibre", number>> = {}): Entity => ({
  kind: "meal",
  date,
  name: "Synthetic meal",
  calories,
  protein,
  ...extra,
});
const run = (date: string): Entity => ({ kind: "run", date, minutes: 30, distanceKm: 5, notes: "" });

function days(snapshot: WidgetSnapshot): WidgetDay[] {
  if (snapshot.status !== "signedIn") throw new Error("Expected a signed-in snapshot.");
  return snapshot.days;
}
function first(snapshot: WidgetSnapshot): WidgetDay {
  const [day] = days(snapshot);
  if (!day) throw new Error("Expected a day.");
  return day;
}

describe("the widget snapshot", () => {
  test("covers today and the next days, each from midnight to midnight in the account timezone", () => {
    const brisbane: Settings = { ...settings, timezone: "Australia/Brisbane" };
    // 20:00 UTC on Monday is 06:00 on Tuesday in Brisbane.
    const snapshot = widgetSnapshot(brisbane, [], at("2026-11-23T20:00:00Z"), scheme);
    const covered = days(snapshot);
    expect(snapshot).toMatchObject({ version: 1, status: "signedIn", timezone: "Australia/Brisbane" });
    expect(covered).toHaveLength(widgetDays);
    expect(covered.map((day) => day.day)).toEqual([
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
      "2026-11-30",
    ]);
    expect(covered[0]).toMatchObject({ start: at("2026-11-23T14:00:00Z"), end: at("2026-11-24T14:00:00Z") });
    // Each day ends where the next starts, so the widget moves on at midnight.
    for (const [index, day] of covered.entries()) {
      const next = covered[index + 1];
      if (next) expect(day.end).toBe(next.start);
    }
  });

  test("follows daylight-saving changes, so a day can be 23 or 25 hours", () => {
    // Sydney moves from +10 to +11 on 4 Oct 2026, and back on 5 Apr 2026.
    const sydney: Settings = { ...settings, timezone: "Australia/Sydney" };
    const spring = first(widgetSnapshot(sydney, [], at("2026-10-04T01:00:00Z"), scheme));
    expect(spring.day).toBe("2026-10-04");
    expect(spring.end - spring.start).toBe(23 * 3_600_000);
    const autumn = first(widgetSnapshot(sydney, [], at("2026-04-05T01:00:00Z"), scheme));
    expect(autumn.day).toBe("2026-04-05");
    expect(autumn.end - autumn.start).toBe(25 * 3_600_000);
  });

  test("names each day's session with its exercises and length, as the reminders do", () => {
    if (!routineA) throw new Error("The default plan has Strength A.");
    const covered = days(widgetSnapshot(settings, [], at("2026-11-23T06:00:00Z"), scheme));
    const [strength, easyRun, , rest] = covered;
    expect(strength?.plan).toEqual({
      kind: "strength",
      title: "Strength A",
      detail: `${routineA.exercises.length} exercises · about ${sessionMinutes(routineA, true)} min`,
      state: "planned",
      status: "Planned",
    });
    expect(easyRun?.plan).toEqual({ kind: "run", title: "Easy run", detail: null, state: "planned", status: "Planned" });
    expect(rest?.plan).toEqual({
      kind: "rest",
      title: "Rest day",
      detail: "Next: Fri 27 Nov · Strength A",
      state: "rest",
      status: "Rest day",
    });
  });

  test("shows a finished session as done and an unfinished one as in progress", () => {
    const done = first(widgetSnapshot(settings, [record(workout(monday, true))], at("2026-11-23T12:00:00Z"), scheme));
    expect(done.plan).toMatchObject({ title: "Strength A", state: "done", status: "Done" });
    const started = first(widgetSnapshot(settings, [record(workout(monday, false))], at("2026-11-23T12:00:00Z"), scheme));
    expect(started.plan).toMatchObject({ kind: "strength", title: "Strength A", state: "inProgress", status: "In progress" });
    expect(started.plan.detail).toMatch(/^0\/\d+ sets handled$/);
    // A run on a strength day is recorded activity, not the planned session.
    const other = first(widgetSnapshot(settings, [record(run(monday))], at("2026-11-23T12:00:00Z"), scheme));
    expect(other.plan).toMatchObject({ title: "Strength A", state: "done", status: "Activity recorded" });
  });

  test("follows dated plans from the Week tab", () => {
    const moved: Settings = { ...settings, dayPlans: { [monday]: { type: "rest", routine: null } } };
    expect(first(widgetSnapshot(moved, [], at("2026-11-23T06:00:00Z"), scheme)).plan).toMatchObject({
      kind: "rest",
      title: "Rest day",
      detail: "Next: Tue 24 Nov · Easy run",
    });
  });

  test("totals each day's food against the targets, so the next day starts at zero", () => {
    let tracked = withNutrient(settings, "carbs", 250);
    tracked = withNutrient(tracked, "fibre", 30);
    tracked = withNutrient(tracked, "fat", null);
    const records = [
      record(meal(monday, 600, 30, { carbs: 70, fibre: 8 })),
      record(meal(monday, 525.4, 27, { fat: 20 })),
      record(meal("2026-11-22", 900, 50)),
    ];
    const [today, tomorrow] = days(widgetSnapshot(tracked, records, at("2026-11-23T12:00:00Z"), scheme));
    expect(today?.food).toEqual({
      calories: { label: "Calories", unit: "kcal", value: 1125, target: 2400, tone: "default" },
      protein: { label: "Protein", unit: "g", value: 57, target: 120, tone: "default" },
      nutrients: [
        { label: "Carbs", unit: "g", value: 70, target: 250, tone: "default" },
        { label: "Fat", unit: "g", value: 20, target: null, tone: "default" },
        { label: "Fibre", unit: "g", value: 8, target: 30, tone: "default" },
      ],
    });
    expect(tomorrow?.food.calories).toMatchObject({ value: 0, target: 2400 });
    expect(tomorrow?.food.nutrients.map((nutrient) => nutrient.value)).toEqual([0, 0, 0]);
  });

  test("marks calories over target, protein reached, and nutrient targets met or passed", () => {
    let tracked = withNutrient(settings, "carbs", 100);
    tracked = withNutrient(tracked, "fibre", 30);
    const records = [record(meal(monday, 2500, 130, { carbs: 120, fibre: 31 }))];
    const { food } = first(widgetSnapshot(tracked, records, at("2026-11-23T12:00:00Z"), scheme));
    expect(food.calories.tone).toBe("missed");
    expect(food.protein.tone).toBe("done");
    expect(food.nutrients.map((nutrient) => nutrient.tone)).toEqual(["missed", "done"]);
  });

  test("leaves out nutrients the account doesn't track", () => {
    const records = [record(meal(monday, 500, 30, { carbs: 50 }))];
    expect(first(widgetSnapshot(settings, records, at("2026-11-23T12:00:00Z"), scheme)).food.nutrients).toEqual([]);
  });

  test("links each day to the Week and Food tabs with the app's scheme", () => {
    expect(first(widgetSnapshot(settings, [], at("2026-11-23T12:00:00Z"), "build.bent.fitness")).links).toEqual({
      week: "build.bent.fitness://week?day=2026-11-23",
      food: "build.bent.fitness://food?day=2026-11-23",
    });
  });

  test("signed out, holds no account data", () => {
    expect(signedOutSnapshot).toEqual({ version: 1, status: "signedOut" });
  });
});

describe("widget links", () => {
  test("open the Week or Food tab at the linked day", () => {
    expect(widgetLink(`${scheme}://week?day=2026-11-23`, scheme)).toEqual({ tab: "week", day: "2026-11-23" });
    expect(widgetLink(`${scheme}://food?day=2026-11-24`, scheme)).toEqual({ tab: "food", day: "2026-11-24" });
  });

  test("ignore other URLs, schemes and invalid days", () => {
    for (const url of [
      `${scheme}://oauth?code=synthetic`,
      `${scheme}://week`,
      `${scheme}://week?day=2026-13-40`,
      `${scheme}://food?day=2026-11-24&extra=1`,
      "build.bent.fitness://week?day=2026-11-23",
      "https://fitness.bent.build/week?day=2026-11-23",
    ])
      expect(widgetLink(url, scheme)).toBeNull();
  });
});

describe("WidgetPublisher", () => {
  function store() {
    const saved: string[] = [];
    let release: (() => void) | null = null;
    let hold = false;
    const value: WidgetStore & { saved: string[]; holdNext: () => void; release: () => void } = {
      saved,
      holdNext: () => {
        hold = true;
      },
      release: () => release?.(),
      save: async (json) => {
        if (hold) {
          hold = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        saved.push(json);
      },
    };
    return value;
  }
  const snapshot = (now: number) => widgetSnapshot(settings, [], now, scheme);

  test("writes each new snapshot once", async () => {
    const target = store();
    const publisher = new WidgetPublisher(target);
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")))).toBe("saved");
    expect(await publisher.publish(snapshot(at("2026-11-23T07:00:00Z")))).toBe("unchanged");
    expect(await publisher.publish(snapshot(at("2026-11-24T06:00:00Z")))).toBe("saved");
    expect(target.saved).toHaveLength(2);
  });

  test("signing out drops a waiting snapshot and writes the signed-out one last", async () => {
    const target = store();
    const publisher = new WidgetPublisher(target);
    target.holdNext();
    const slow = publisher.publish(snapshot(at("2026-11-23T06:00:00Z")));
    // The first write has started and waits.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const waiting = publisher.publish(snapshot(at("2026-11-24T06:00:00Z")));
    const signOut = publisher.signOut();
    target.release();
    expect(await slow).toBe("saved");
    expect(await waiting).toBe("unchanged");
    expect(await signOut).toBe("saved");
    expect(target.saved.at(-1)).toBe(JSON.stringify(signedOutSnapshot));
    expect(target.saved).toHaveLength(2);
    // The next sign-in writes its snapshot again.
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")))).toBe("saved");
  });

  test("writes again after a failed write", async () => {
    let fail = true;
    const saved: string[] = [];
    const publisher = new WidgetPublisher({
      save: async (json) => {
        if (fail) throw new Error("Synthetic write failure");
        saved.push(json);
      },
    });
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")))).toBe("unchanged");
    fail = false;
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")))).toBe("saved");
    expect(saved).toHaveLength(1);
  });

  test("writes nothing without the native module", async () => {
    expect(await new WidgetPublisher(null).publish(snapshot(at("2026-11-23T06:00:00Z")))).toBe("unchanged");
    expect(await new WidgetPublisher(null).signOut()).toBe("unchanged");
  });
});
