import { z } from "zod";
import {
  addDays,
  completedActivity,
  formatShortDate,
  localDate,
  nextSession,
  sessionMinutes,
  trainingRecords,
} from "@bent/fitness-contracts/domain";
import type { RecordEntry, Settings } from "@bent/fitness-contracts/domain";
import { dayInfo, isDay } from "../screens/week/logic";

/*
 * Daily workout reminders: what each day's notification says and when it
 * fires. The app schedules them as local notifications on this iPhone, so
 * these rules stay apart from React Native for Bun tests.
 */

/** How many days of reminders stay scheduled. iOS keeps up to 64 pending notifications. */
export const reminderDays = 14;

/** The reminder settings kept on this iPhone. `minutes` is the time of day, from midnight. */
const reminderSettingsSchema = z.object({
  enabled: z.boolean(),
  minutes: z.number().int().min(0).max(1439),
  restDays: z.boolean(),
});
export type ReminderSettings = z.infer<typeof reminderSettingsSchema>;

export const defaultReminderSettings: ReminderSettings = { enabled: false, minutes: 7 * 60, restDays: false };

/** Reads stored reminder settings, falling back to the defaults for a missing or unreadable value. */
export function parseReminderSettings(text: string | null): ReminderSettings {
  if (!text) return defaultReminderSettings;
  try {
    const parsed = reminderSettingsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : defaultReminderSettings;
  } catch {
    return defaultReminderSettings;
  }
}

/** One scheduled reminder. `at` is milliseconds since 1970. */
export type Reminder = { day: string; at: number; title: string; body: string };

/** The wall-clock time `at` shows in `timezone`, as milliseconds of a UTC date with the same fields. */
function wallClock(timezone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  // Some engines write midnight as 24 in 24-hour time.
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second"));
}

/**
 * The moment `day` reaches `minutes` past midnight in `timezone`. A time
 * that a daylight-saving change skips moves forward by the change, so 2:30
 * on a day that jumps from 2:00 to 3:00 fires at 3:30. A time that happens
 * twice, when the clocks go back, fires the first time.
 */
export function zonedTime(day: string, minutes: number, timezone: string) {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, date, Math.floor(minutes / 60), minutes % 60);
  const offset = (at: number) => wallClock(timezone, at) - Math.floor(at / 1000) * 1000;
  const before = wall - offset(wall - 86_400_000);
  const after = wall - offset(wall + 86_400_000);
  const valid = [before, after].filter((at) => wallClock(timezone, at) === wall);
  // With neither valid, the time falls in a gap; the offset before it lands just after the gap.
  return valid.length ? Math.min(...valid) : before;
}

/** "7:00 am" or "07:00", as the locale writes a time of day. */
export function clockText(minutes: number, locale?: string) {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)),
  );
}

/** What the reminder for `day` says, or null when the day gets none. */
export function reminderText(
  settings: Settings,
  records: RecordEntry[],
  day: string,
  restDays: boolean,
): { title: string; body: string } | null {
  // Corrections apply first, so a removed workout frees its day and a moved one counts on its new date.
  const training = trainingRecords(records);
  const info = dayInfo(settings, completedActivity(training), day, day);
  // A day with a recorded or started session needs no reminder.
  if (info.state === "done") return null;
  if (training.some(({ data }) => data.kind === "workout" && data.date === day)) return null;
  const { plan } = info;
  if (plan.type === "strength") {
    if (!plan.routine) return { title: `Today: ${info.name}`, body: "Strength session" };
    const count = plan.routine.exercises.length;
    return {
      title: `Today: ${plan.routine.name}`,
      body: `${count} ${count === 1 ? "exercise" : "exercises"} · about ${sessionMinutes(plan.routine, plan.intro)} min`,
    };
  }
  if (plan.type === "run") return { title: "Today: Easy run", body: "Keep it comfortable enough to talk in sentences." };
  if (!restDays) return null;
  const upcoming = nextSession(settings, addDays(day, 1), records);
  const next =
    upcoming?.plan.type === "strength" ? (upcoming.plan.routine?.name ?? "Strength") : upcoming ? "Easy run" : null;
  return {
    title: "Today: Rest day",
    body: upcoming && next ? `Next: ${formatShortDate(upcoming.date)} · ${next}` : "Nothing planned in the next two weeks.",
  };
}

/**
 * The reminders for the next 14 days in the account timezone, from today.
 * A time already past today starts the window tomorrow. Days with no
 * reminder, such as rest days with rest-day reminders off and days with a
 * recorded session, are left out.
 */
export function reminderPlan(
  settings: Settings,
  records: RecordEntry[],
  reminder: ReminderSettings,
  now: number,
): Reminder[] {
  if (!reminder.enabled) return [];
  const today = localDate(settings.timezone, new Date(now));
  const days = Array.from({ length: reminderDays + 1 }, (_, index) => addDays(today, index))
    .map((day) => ({ day, at: zonedTime(day, reminder.minutes, settings.timezone) }))
    .filter(({ at }) => at > now)
    .slice(0, reminderDays);
  return days.flatMap(({ day, at }) => {
    const text = reminderText(settings, records, day, reminder.restDays);
    return text ? [{ day, at, ...text }] : [];
  });
}

/** Schedules and cancels reminders on the iPhone. */
export type ReminderCenter = {
  /**
   * Brings the pending reminders for the account `owner` in line with
   * these. Resolves "denied" when notifications are off for the app, and
   * rejects when iOS refused to add one.
   */
  scheduleReminders(owner: string, reminders: Reminder[]): Promise<"scheduled" | "denied">;
  /** Removes pending and delivered reminders, and forgets a tap not yet handled. */
  cancelReminders(): Promise<void>;
};

export type ScheduleResult = "scheduled" | "denied" | "unchanged" | "failed";

/**
 * Sends schedules and cancels to the iPhone one at a time, in order. A
 * cancel, as on signing out, drops schedules still waiting before it, so a
 * slow schedule never brings reminders back after it. A schedule the same
 * as the last one is skipped unless it is forced; after a failure, the next
 * schedule always runs.
 */
export class ReminderScheduler {
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private last: string | null = null;

  constructor(private readonly center: ReminderCenter | null) {}

  schedule(owner: string, reminders: Reminder[], force = false): Promise<ScheduleResult> {
    const generation = this.generation;
    const key = JSON.stringify({ owner, reminders });
    const run = this.chain.then(async (): Promise<ScheduleResult> => {
      if (!this.center || generation !== this.generation) return "unchanged";
      if (!force && key === this.last) return "unchanged";
      try {
        const result = await this.center.scheduleReminders(owner, reminders);
        this.last = result === "scheduled" ? key : null;
        return result;
      } catch {
        this.last = null;
        return "failed";
      }
    });
    this.chain = run;
    return run;
  }

  cancel(): Promise<void> {
    this.generation += 1;
    const run = this.chain.then(async () => {
      this.last = null;
      await this.center?.cancelReminders().catch(() => undefined);
    });
    this.chain = run;
    return run;
  }
}

type Timers = {
  set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * Schedules reminders for one signed-in session and, when iOS refuses one,
 * schedules again `retryMs` later. Once stopped, as when the session ends,
 * it schedules nothing more, even for a schedule that fails afterwards, so
 * a retry never brings back an earlier account's reminders.
 */
export class ReminderRetry {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly scheduler: Pick<ReminderScheduler, "schedule">,
    private readonly plan: () => { owner: string; reminders: Reminder[] } | null,
    private readonly retryMs = 60_000,
    private readonly timers: Timers = { set: setTimeout, clear: clearTimeout },
  ) {}

  run(force: boolean) {
    if (this.stopped) return;
    this.clearTimer();
    const next = this.plan();
    if (!next) return;
    void this.scheduler.schedule(next.owner, next.reminders, force).then((result) => {
      if (result !== "failed" || this.stopped || this.timer) return;
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.run(true);
      }, this.retryMs);
    });
  }

  stop() {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }
}

/** "7:00 am" in `timezone`, the moment a reminder fires. */
export function fireTimeText(at: number, timezone: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(at));
}

/** The day a tapped reminder opens: only a calendar day scheduled for the account signed in. */
export function openedDay(tap: { day: string; owner: string } | null | undefined, owner: string) {
  return tap && tap.owner === owner && isDay(tap.day) ? tap.day : null;
}
