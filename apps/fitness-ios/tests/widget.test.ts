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
  /** A synthetic snapshot file: `fail` makes the next writes or deletes throw, `hold` holds the next write. */
  function store() {
    const files: (string | null)[] = [];
    const calls: string[] = [];
    let release: (() => void) | null = null;
    const state = { hold: false, failSave: false, failClear: false };
    const value: WidgetStore = {
      save: async (json) => {
        calls.push("save");
        if (state.hold) {
          state.hold = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        if (state.failSave) throw new Error("Synthetic write failure");
        files.push(json);
      },
      clear: async () => {
        calls.push("clear");
        if (state.failClear) throw new Error("Synthetic delete failure");
        files.push(null);
      },
    };
    return { value, files, calls, state, release: () => release?.(), current: () => files.at(-1) };
  }
  const snapshot = (now: number) => widgetSnapshot(settings, [], now, scheme);
  const signedOut = JSON.stringify(signedOutSnapshot);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("writes each new snapshot once", async () => {
    const target = store();
    const publisher = new WidgetPublisher(target.value);
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")), 1)).toBe("saved");
    expect(await publisher.publish(snapshot(at("2026-11-23T07:00:00Z")), 1)).toBe("unchanged");
    expect(await publisher.publish(snapshot(at("2026-11-24T06:00:00Z")), 1)).toBe("saved");
    expect(target.files).toHaveLength(2);
  });

  test("signing out drops waiting snapshots and writes the signed-out one last", async () => {
    const target = store();
    const publisher = new WidgetPublisher(target.value);
    target.state.hold = true;
    const slow = publisher.publish(snapshot(at("2026-11-23T06:00:00Z")), 1);
    // The first write has started and waits.
    await tick();
    const waiting = publisher.publish(snapshot(at("2026-11-24T06:00:00Z")), 1);
    const signOut = publisher.signOut(2);
    target.release();
    expect(await slow).toBe("saved");
    expect(await waiting).toBe("unchanged");
    expect(await signOut).toBe("saved");
    expect(target.current()).toBe(signedOut);
    expect(target.files).toHaveLength(2);
  });

  test("never writes a snapshot from an ended sign-in, even one built after signing out", async () => {
    const target = store();
    const publisher = new WidgetPublisher(target.value);
    expect(await publisher.signOut(2)).toBe("saved");
    // The outgoing account's screens can still build a snapshot before they close.
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")), 1)).toBe("unchanged");
    expect(target.current()).toBe(signedOut);
    // The next sign-in writes its snapshot.
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")), 3)).toBe("saved");
    expect(target.current()).not.toBe(signedOut);
  });

  test("deletes the snapshot when the signed-out one can't be written", async () => {
    const target = store();
    const publisher = new WidgetPublisher(target.value);
    await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")), 1);
    target.state.failSave = true;
    expect(await publisher.signOut(2)).toBe("cleared");
    expect(target.current()).toBeNull();
    expect(target.calls).toEqual(["save", "save", "clear"]);
  });

  test("reports a sign-out that left the snapshot, and tries again on the next call", async () => {
    const target = store();
    const publisher = new WidgetPublisher(target.value);
    await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")), 1);
    target.state.failSave = true;
    target.state.failClear = true;
    expect(await publisher.signOut(2)).toBe("failed");
    expect(target.current()).toContain('"signedIn"');
    // At the next foreground or launch, writing works again.
    target.state.failSave = false;
    expect(await publisher.signOut(2)).toBe("saved");
    expect(target.current()).toBe(signedOut);
    expect(await publisher.signOut(2)).toBe("unchanged");
  });

  test("writes again after a failed write", async () => {
    const target = store();
    const publisher = new WidgetPublisher(target.value);
    target.state.failSave = true;
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")), 1)).toBe("unchanged");
    target.state.failSave = false;
    expect(await publisher.publish(snapshot(at("2026-11-23T06:00:00Z")), 1)).toBe("saved");
    expect(target.files).toHaveLength(1);
  });

  test("writes nothing without the native module", async () => {
    expect(await new WidgetPublisher(null).publish(snapshot(at("2026-11-23T06:00:00Z")), 1)).toBe("unchanged");
    expect(await new WidgetPublisher(null).signOut(1)).toBe("unchanged");
  });
});
