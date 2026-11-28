import { describe, expect, test } from "bun:test";
import { createWorkout, defaultSettings, reorganiseDays, sessionMinutes } from "@bent/fitness-contracts/domain";
import type { Entity, RecordEntry, Settings } from "@bent/fitness-contracts/domain";
import {
  ReminderRetry,
  ReminderScheduler,
  clockText,
  defaultReminderSettings,
  fireTimeText,
  openedDay,
  parseReminderSettings,
  reminderDays,
  reminderPlan,
  reminderText,
  zonedTime,
} from "../src/logic/reminders";
import type { Reminder, ReminderCenter } from "../src/logic/reminders";

// Synthetic plan: Monday 23 Nov 2026 starts a week of
// Strength A, run, Strength B, rest, Strength A, run, rest.
const monday = "2026-11-23";
const settings = defaultSettings(monday, "UTC");
const [routineA, routineB] = settings.routines;
const on = { ...defaultReminderSettings, enabled: true };

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
const run = (date: string): Entity => ({ kind: "run", date, minutes: 30, distanceKm: 5, notes: "" });
const at = (iso: string) => Date.parse(iso);

describe("reminder settings", () => {
  test("default to off at 7:00 without rest days", () => {
    expect(defaultReminderSettings).toEqual({ enabled: false, minutes: 420, restDays: false });
  });

  test("parse stored values and fall back for unreadable ones", () => {
    expect(parseReminderSettings(JSON.stringify({ enabled: true, minutes: 1080, restDays: true }))).toEqual({
      enabled: true,
      minutes: 1080,
      restDays: true,
    });
    expect(parseReminderSettings(null)).toEqual(defaultReminderSettings);
    expect(parseReminderSettings("{")).toEqual(defaultReminderSettings);
    expect(parseReminderSettings(JSON.stringify({ enabled: true, minutes: 1440, restDays: false }))).toEqual(
      defaultReminderSettings,
    );
  });

  test("clockText writes the time of day in the locale", () => {
    expect(clockText(420, "en-GB")).toBe("7:00");
    expect(clockText(18 * 60 + 5, "en-US")).toBe("6:05 PM");
  });
});

describe("zonedTime", () => {
  test("reads the time in the account timezone", () => {
    expect(zonedTime("2026-11-23", 420, "UTC")).toBe(at("2026-11-23T07:00:00Z"));
    expect(zonedTime("2026-11-23", 420, "Australia/Brisbane")).toBe(at("2026-11-22T21:00:00Z"));
    expect(zonedTime("2026-11-23", 1380, "America/Los_Angeles")).toBe(at("2026-11-24T07:00:00Z"));
    expect(zonedTime("2026-11-23", 0, "Pacific/Kiritimati")).toBe(at("2026-11-22T10:00:00Z"));
    expect(zonedTime("2026-11-23", 0, "Australia/Brisbane")).toBe(at("2026-11-22T14:00:00Z"));
    expect(zonedTime("2026-11-23", 1439, "Europe/London")).toBe(at("2026-11-23T23:59:00Z"));
  });

  test("follows daylight saving on either side of a change", () => {
    // Sydney moves from +10 to +11 on 4 Oct 2026.
    expect(zonedTime("2026-10-03", 420, "Australia/Sydney")).toBe(at("2026-10-02T21:00:00Z"));
    expect(zonedTime("2026-10-04", 420, "Australia/Sydney")).toBe(at("2026-10-03T20:00:00Z"));
    // New York moves from -4 to -5 on 1 Nov 2026.
    expect(zonedTime("2026-10-31", 420, "America/New_York")).toBe(at("2026-10-31T11:00:00Z"));
    expect(zonedTime("2026-11-01", 420, "America/New_York")).toBe(at("2026-11-01T12:00:00Z"));
  });

  test("moves a skipped time forward and fires a repeated time once, the first time", () => {
    // 2:30 does not happen in Sydney on 4 Oct 2026; it fires at 3:30 (+11).
    expect(zonedTime("2026-10-04", 150, "Australia/Sydney")).toBe(at("2026-10-03T16:30:00Z"));
    // 1:30 happens twice in New York on 1 Nov 2026; the first is at -4.
    expect(zonedTime("2026-11-01", 90, "America/New_York")).toBe(at("2026-11-01T05:30:00Z"));
  });
});

describe("reminderText", () => {
  test("names the routine, its exercises and its length", () => {
    if (!routineA) throw new Error("The default plan has Strength A.");
    // The plan starts on 23 Nov, so its first two weeks are introduction weeks.
    expect(reminderText(settings, [], "2026-11-23", false)).toEqual({
      title: "Today: Strength A",
      body: `${routineA.exercises.length} exercises · about ${sessionMinutes(routineA, true)} min`,
    });
    if (!routineB) throw new Error("The default plan has Strength B.");
    expect(reminderText(settings, [], "2026-12-09", false)).toEqual({
      title: "Today: Strength B",
      body: `${routineB.exercises.length} exercises · about ${sessionMinutes(routineB, false)} min`,
    });
  });

  test("words a single exercise", () => {
    const single: Settings = {
      ...settings,
      routines: settings.routines.map((routine) => ({ ...routine, exercises: routine.exercises.slice(0, 1) })),
    };
    expect(reminderText(single, [], "2026-11-23", false)?.body).toMatch(/^1 exercise · about \d+ min$/);
  });

  test("describes a run", () => {
    expect(reminderText(settings, [], "2026-11-24", false)).toEqual({
      title: "Today: Easy run",
      body: "Keep it comfortable enough to talk in sentences.",
    });
  });

  test("gives rest days a reminder only when they are on, with the next session", () => {
    expect(reminderText(settings, [], "2026-11-26", false)).toBeNull();
    expect(reminderText(settings, [], "2026-11-26", true)).toEqual({
      title: "Today: Rest day",
      body: "Next: Fri 27 Nov · Strength A",
    });
    expect(reminderText(settings, [], "2026-11-29", true)?.body).toBe("Next: Mon 30 Nov · Strength B");
    const resting: Settings = { ...settings, schedule: ["rest", "rest", "rest", "rest", "rest", "rest", "rest"] };
    expect(reminderText(resting, [], "2026-11-26", true)?.body).toBe("Nothing planned in the next two weeks.");
  });

  test("skips a day whose session is recorded or started", () => {
    expect(reminderText(settings, [record(workout("2026-11-23", true))], "2026-11-23", false)).toBeNull();
    expect(reminderText(settings, [record(workout("2026-11-23", false))], "2026-11-23", false)).toBeNull();
    expect(reminderText(settings, [record(run("2026-11-24"))], "2026-11-24", false)).toBeNull();
    // A run on a rest day counts as activity, as the Week tab shows it.
    expect(reminderText(settings, [record(run("2026-11-26"))], "2026-11-26", true)).toBeNull();
    // A run on a strength day leaves the strength session to do, but the Week tab shows the day as done.
    expect(reminderText(settings, [record(run("2026-11-23"))], "2026-11-23", false)).toBeNull();
  });

  test("follows corrections: a removed workout frees its day and a moved one counts on its new date", () => {
    const original = record(workout("2026-11-23", true));
    const removed = record({
      kind: "workoutCorrection",
      workoutId: original.id,
      replacement: null,
      reason: "Removed from history",
    });
    expect(reminderText(settings, [original, removed], "2026-11-23", false)?.title).toBe("Today: Strength A");
    const movedWorkout = { ...workout("2026-11-25", true), date: "2026-11-25" };
    const moved = record({
      kind: "workoutCorrection",
      workoutId: original.id,
      replacement: movedWorkout,
      reason: "Wrong day",
    });
    expect(reminderText(settings, [original, moved], "2026-11-23", false)?.title).toBe("Today: Strength A");
    expect(reminderText(settings, [original, moved], "2026-11-25", false)).toBeNull();
  });

  test("follows a dated plan", () => {
    // Thursday's rest and Friday's Strength A swap.
    const moved = reorganiseDays(settings, "2026-11-27", "2026-11-26", "2026-11-23", []);
    expect(reminderText(moved, [], "2026-11-26", false)?.title).toBe("Today: Strength A");
    expect(reminderText(moved, [], "2026-11-27", false)).toBeNull();
    expect(reminderText(moved, [], "2026-11-27", true)?.title).toBe("Today: Rest day");
  });
});

describe("reminderPlan", () => {
  test("is empty while reminders are off", () => {
    expect(reminderPlan(settings, [], defaultReminderSettings, at("2026-11-23T00:00:00Z"))).toEqual([]);
  });

  test("covers 14 days from today, leaving out rest days", () => {
    const plan = reminderPlan(settings, [], on, at("2026-11-23T06:00:00Z"));
    // Two weeks hold ten sessions and four rest days.
    expect(plan.map((item) => item.day)).toEqual([
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
      "2026-11-27",
      "2026-11-28",
      "2026-11-30",
      "2026-12-01",
      "2026-12-02",
      "2026-12-04",
      "2026-12-05",
    ]);
    expect(plan[0]?.at).toBe(at("2026-11-23T07:00:00Z"));
    const all = reminderPlan(settings, [], { ...on, restDays: true }, at("2026-11-23T06:00:00Z"));
    expect(all).toHaveLength(reminderDays);
    expect(all.at(-1)?.day).toBe("2026-12-06");
  });

  test("starts tomorrow once today's time has passed, keeping 14 days", () => {
    const plan = reminderPlan(settings, [], { ...on, restDays: true }, at("2026-11-23T07:00:00Z"));
    expect(plan[0]?.day).toBe("2026-11-24");
    expect(plan).toHaveLength(reminderDays);
    expect(plan.at(-1)?.day).toBe("2026-12-07");
  });

  test("leaves out today once today's session is done", () => {
    const plan = reminderPlan(settings, [record(workout("2026-11-23", true))], on, at("2026-11-23T06:00:00Z"));
    expect(plan[0]?.day).toBe("2026-11-24");
  });

  test("uses today and the time in the account timezone", () => {
    const brisbane: Settings = { ...settings, timezone: "Australia/Brisbane" };
    // 22:00 UTC on Sunday is 8:00 on Monday in Brisbane, past 7:00.
    const plan = reminderPlan(brisbane, [], { ...on, restDays: true }, at("2026-11-22T22:00:00Z"));
    expect(plan[0]).toMatchObject({ day: "2026-11-24", at: at("2026-11-23T21:00:00Z"), title: "Today: Easy run" });
    // 20:00 UTC on Sunday is 6:00 on Monday in Brisbane.
    const early = reminderPlan(brisbane, [], on, at("2026-11-22T20:00:00Z"));
    expect(early[0]).toMatchObject({ day: "2026-11-23", at: at("2026-11-22T21:00:00Z") });
  });

  test("keeps the chosen time across a daylight-saving change", () => {
    const sydney: Settings = { ...settings, timezone: "Australia/Sydney" };
    const plan = reminderPlan(sydney, [], { ...on, restDays: true, minutes: 18 * 60 }, at("2026-10-01T00:00:00Z"));
    const local = plan.map((item) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" }).format(
        item.at,
      ),
    );
    expect(new Set(local)).toEqual(new Set(["18:00"]));
    expect(plan.map((item) => item.day)).toContain("2026-10-04");
  });
});

describe("tapped reminders", () => {
  test("open their day only for the account they were scheduled for", () => {
    expect(openedDay({ day: "2026-11-23", owner: "account-1" }, "account-1")).toBe("2026-11-23");
    expect(openedDay({ day: "2026-11-23", owner: "account-1" }, "account-2")).toBeNull();
    expect(openedDay({ day: "23 Nov", owner: "account-1" }, "account-1")).toBeNull();
    expect(openedDay(null, "account-1")).toBeNull();
  });
});

describe("fireTimeText", () => {
  test("shows when the reminder fires in the account timezone", () => {
    const at = zonedTime("2026-11-23", 420, "Australia/Brisbane");
    expect(fireTimeText(at, "Australia/Brisbane", "en-GB")).toBe("7:00");
    expect(fireTimeText(at, "Australia/Brisbane", "en-US")).toBe("7:00 AM");
  });

  test("shows the moved time when a daylight-saving change skips the chosen one", () => {
    const at = zonedTime("2026-10-04", 150, "Australia/Sydney");
    expect(fireTimeText(at, "Australia/Sydney", "en-GB")).toBe("3:30");
  });
});

describe("ReminderScheduler", () => {
  const reminder = (day: string): Reminder => ({ day, at: 0, title: "Today: Strength A", body: "" });
  const owner = "account-1";

  function fakeCenter(result: "scheduled" | "denied" | "fails" = "scheduled") {
    const calls: string[] = [];
    const gates: (() => void)[] = [];
    const center: ReminderCenter = {
      scheduleReminders: (owner, reminders) =>
        new Promise((resolve, reject) => {
          calls.push(`schedule ${owner} ${reminders.map((item) => item.day).join(",")}`);
          gates.push(() =>
            result === "fails" ? reject(new Error("1 workout reminders could not be scheduled.")) : resolve(result),
          );
        }),
      cancelReminders: () => {
        calls.push("cancel");
        return Promise.resolve();
      },
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    // Lets each schedule that has started finish, until none is waiting.
    const release = async () => {
      await tick();
      while (gates.length) {
        gates.shift()?.();
        await tick();
      }
    };
    return { center, calls, release, tick };
  }

  test("runs in order and skips a schedule the same as the last", async () => {
    const { center, calls, release } = fakeCenter();
    const scheduler = new ReminderScheduler(center);
    const first = scheduler.schedule(owner, [reminder("2026-11-23")]);
    const second = scheduler.schedule(owner, [reminder("2026-11-23")]);
    const forced = scheduler.schedule(owner, [reminder("2026-11-23")], true);
    await release();
    expect(await first).toBe("scheduled");
    expect(await second).toBe("unchanged");
    expect(await forced).toBe("scheduled");
    expect(calls).toEqual(["schedule account-1 2026-11-23", "schedule account-1 2026-11-23"]);
  });

  test("a cancel drops schedules still waiting and clears what was scheduled", async () => {
    const { center, calls, release, tick } = fakeCenter();
    const scheduler = new ReminderScheduler(center);
    const running = scheduler.schedule(owner, [reminder("2026-11-23")]);
    await tick();
    const waiting = scheduler.schedule(owner, [reminder("2026-11-24")]);
    const cancelled = scheduler.cancel();
    await release();
    await cancelled;
    expect(await running).toBe("scheduled");
    expect(await waiting).toBe("unchanged");
    expect(calls).toEqual(["schedule account-1 2026-11-23", "cancel"]);
    // After a cancel, the same reminders are scheduled again.
    const again = scheduler.schedule(owner, [reminder("2026-11-23")]);
    await release();
    expect(await again).toBe("scheduled");
  });

  test("schedules again after notifications were off", async () => {
    const { center, calls, release } = fakeCenter("denied");
    const scheduler = new ReminderScheduler(center);
    const first = scheduler.schedule(owner, [reminder("2026-11-23")]);
    await release();
    expect(await first).toBe("denied");
    const second = scheduler.schedule(owner, [reminder("2026-11-23")]);
    await release();
    expect(await second).toBe("denied");
    expect(calls).toHaveLength(2);
  });

  test("reports a refused reminder and runs the same schedule again next time", async () => {
    const { center, calls, release } = fakeCenter("fails");
    const scheduler = new ReminderScheduler(center);
    const first = scheduler.schedule(owner, [reminder("2026-11-23")]);
    await release();
    expect(await first).toBe("failed");
    const second = scheduler.schedule(owner, [reminder("2026-11-23")]);
    await release();
    expect(await second).toBe("failed");
    expect(calls).toHaveLength(2);
  });

  test("schedules again for another account", async () => {
    const { center, calls, release } = fakeCenter();
    const scheduler = new ReminderScheduler(center);
    const first = scheduler.schedule(owner, [reminder("2026-11-23")]);
    const other = scheduler.schedule("account-2", [reminder("2026-11-23")]);
    await release();
    expect([await first, await other]).toEqual(["scheduled", "scheduled"]);
    expect(calls).toEqual(["schedule account-1 2026-11-23", "schedule account-2 2026-11-23"]);
  });

  test("does nothing without the native module", async () => {
    const scheduler = new ReminderScheduler(null);
    expect(await scheduler.schedule(owner, [reminder("2026-11-23")])).toBe("unchanged");
    await scheduler.cancel();
  });
});

describe("ReminderRetry", () => {
  const reminder: Reminder = { day: "2026-12-01", at: 1, title: "Today: Strength A", body: "6 exercises" };
  function harness(results: ("scheduled" | "failed")[]) {
    const calls: { owner: string; force: boolean }[] = [];
    const resolvers: (() => void)[] = [];
    const scheduler = {
      schedule(owner: string, _reminders: Reminder[], force = false) {
        calls.push({ owner, force });
        const result = results.shift() ?? "scheduled";
        return new Promise<"scheduled" | "failed">((resolve) => resolvers.push(() => resolve(result)));
      },
    };
    const timers: (() => void)[] = [];
    let cleared = 0;
    let account = "user_a";
    const retry = new ReminderRetry(scheduler, () => ({ owner: account, reminders: [reminder] }), 60_000, {
      set: (run) => {
        timers.push(run);
        return setTimeout(() => undefined, 0);
      },
      clear: () => {
        cleared += 1;
      },
    });
    const settle = async () => {
      for (const resolve of resolvers.splice(0)) resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { retry, calls, timers, settle, cleared: () => cleared, switchTo: (owner: string) => (account = owner) };
  }

  test("schedules again a minute after iOS refuses a reminder", async () => {
    const { retry, calls, timers, settle } = harness(["failed", "scheduled"]);
    retry.run(false);
    await settle();
    expect(timers).toHaveLength(1);
    timers[0]?.();
    await settle();
    expect(calls).toEqual([
      { owner: "user_a", force: false },
      { owner: "user_a", force: true },
    ]);
  });

  test("a refusal that arrives after the session ends schedules nothing", async () => {
    const { retry, calls, timers, settle, switchTo } = harness(["failed"]);
    retry.run(false);
    // Signing out stops the session while iOS is still answering.
    retry.stop();
    switchTo("user_b");
    await settle();
    expect(timers).toHaveLength(0);
    retry.run(true);
    expect(calls).toEqual([{ owner: "user_a", force: false }]);
  });

  test("stopping cancels a waiting retry, and a retry that fires anyway does nothing", async () => {
    const { retry, calls, timers, settle, cleared } = harness(["failed"]);
    retry.run(false);
    await settle();
    expect(timers).toHaveLength(1);
    retry.stop();
    expect(cleared()).toBe(1);
    timers[0]?.();
    await settle();
    expect(calls).toHaveLength(1);
  });
});
