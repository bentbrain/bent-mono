import { addDays, completedActivity, localDate } from "@bent/fitness-contracts/domain";
import type { RecordEntry, Settings } from "@bent/fitness-contracts/domain";
import { daySummary } from "../screens/food/meals";
import { activeWorkout, dayInfo, isDay, nextSessionText, sessionText, workoutProgress } from "../screens/week/logic";
import { zonedTime } from "./reminders";

/*
 * The Today widget's snapshot. The widget extension can't sign in or load
 * the account, so the app writes what the widget shows to a file both can
 * read: the plan and food for today and the next few days, each with the
 * moment its day starts in the account timezone. At midnight the widget
 * moves to the next day without the app. These rules stay apart from
 * React Native for Bun tests.
 */

/** How many days, from today, the snapshot covers. */
export const widgetDays = 7;

/** The snapshot format the widget extension reads. */
const snapshotVersion = 1;

type Tone = "default" | "done" | "missed";

/** An amount eaten against its daily target. `target` is null for a nutrient tracked without one. */
type WidgetAmount = { label: string; unit: "kcal" | "g"; value: number; target: number | null; tone: Tone };

export type WidgetDay = {
  day: string;
  /** When the day starts and ends in the account timezone, in milliseconds since 1970. */
  start: number;
  end: number;
  plan: {
    kind: "strength" | "run" | "rest";
    title: string;
    detail: string | null;
    state: "planned" | "done" | "inProgress" | "rest" | "missed";
    status: string;
  };
  food: { calories: WidgetAmount; protein: WidgetAmount; nutrients: WidgetAmount[] };
  /** The app links that open the day in the Week and Food tabs. */
  links: { week: string; food: string };
};

export type WidgetSnapshot =
  | { version: typeof snapshotVersion; status: "signedIn"; timezone: string; days: WidgetDay[] }
  | { version: typeof snapshotVersion; status: "signedOut" };

/** The snapshot while signed out. It holds no account data, so the widget asks to sign in. */
export const signedOutSnapshot: WidgetSnapshot = { version: snapshotVersion, status: "signedOut" };

/** The link to `tab` at `day`, such as build.bent.fitness://food?day=2026-11-28. */
function link(scheme: string, tab: WidgetTab, day: string) {
  return `${scheme}://${tab}?day=${day}`;
}

type WidgetTab = "week" | "food";

/** The Week or Food tab and day a widget link opens, or null for any other URL. */
export function widgetLink(url: string, scheme: string): { tab: WidgetTab; day: string } | null {
  const prefix = `${scheme}://`;
  if (!url.startsWith(prefix)) return null;
  const match = /^(week|food)\?day=(\d{4}-\d{2}-\d{2})$/.exec(url.slice(prefix.length));
  const tab = match?.[1];
  const day = match?.[2];
  if ((tab !== "week" && tab !== "food") || !isDay(day)) return null;
  return { tab, day };
}

/** The plan part of a day: the session, or the workout in progress on that day. */
function dayPlan(settings: Settings, records: RecordEntry[], day: string, today: string): WidgetDay["plan"] {
  const info = dayInfo(settings, completedActivity(records), day, today);
  const active = activeWorkout(records);
  if (active?.data.kind === "workout" && active.data.date === day) {
    const { handled, total } = workoutProgress(active.data);
    return {
      kind: "strength",
      title: active.data.name,
      detail: `${handled}/${total} sets handled`,
      state: "inProgress",
      status: "In progress",
    };
  }
  const { title, detail } = sessionText(info);
  return {
    kind: info.plan.type,
    title,
    detail: info.plan.type === "rest" && info.state !== "done" ? nextSessionText(settings, records, day) : detail,
    state: info.state,
    status: info.status,
  };
}

/** The food part of a day: calories, protein and each tracked nutrient against its target. */
function dayFood(settings: Settings, records: RecordEntry[], day: string): WidgetDay["food"] {
  const summary = daySummary(records, day, settings);
  return {
    calories: {
      label: "Calories",
      unit: "kcal",
      value: summary.calories.value,
      target: summary.calories.target,
      tone: summary.calories.over ? "missed" : "default",
    },
    protein: {
      label: "Protein",
      unit: "g",
      value: summary.protein.value,
      target: summary.protein.target,
      tone: summary.protein.reached ? "done" : "default",
    },
    nutrients: summary.nutrients.map((nutrient) => ({
      label: nutrient.label,
      unit: "g",
      value: nutrient.value,
      target: nutrient.target,
      tone: nutrient.tone,
    })),
  };
}

/**
 * The snapshot at `now`: today and the following days in the account
 * timezone, each with its plan, its food against the targets and its links.
 * `scheme` is the app's URL scheme.
 */
export function widgetSnapshot(settings: Settings, records: RecordEntry[], now: number, scheme: string): WidgetSnapshot {
  const timezone = settings.timezone;
  const today = localDate(timezone, new Date(now));
  const days = Array.from({ length: widgetDays }, (_, index) => addDays(today, index)).map(
    (day): WidgetDay => ({
      day,
      start: zonedTime(day, 0, timezone),
      end: zonedTime(addDays(day, 1), 0, timezone),
      plan: dayPlan(settings, records, day, today),
      food: dayFood(settings, records, day),
      links: { week: link(scheme, "week", day), food: link(scheme, "food", day) },
    }),
  );
  return { version: snapshotVersion, status: "signedIn", timezone, days };
}

/** Writes the snapshot where the widget reads it, and asks iOS to refresh the widget. */
export type WidgetStore = { save(json: string): Promise<void> };

/**
 * Writes snapshots one at a time, in order. Signing out drops snapshots
 * still waiting before it and writes the signed-out snapshot, so a slow
 * write never brings account data back afterwards. A snapshot the same as
 * the last one written is skipped.
 */
export class WidgetPublisher {
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private last: string | null = null;

  constructor(private readonly store: WidgetStore | null) {}

  publish(snapshot: WidgetSnapshot): Promise<"saved" | "unchanged"> {
    const generation = this.generation;
    return this.write(snapshot, () => generation === this.generation);
  }

  signOut(): Promise<"saved" | "unchanged"> {
    this.generation += 1;
    return this.write(signedOutSnapshot, () => true);
  }

  private write(snapshot: WidgetSnapshot, current: () => boolean): Promise<"saved" | "unchanged"> {
    const json = JSON.stringify(snapshot);
    const run = this.chain.then(async (): Promise<"saved" | "unchanged"> => {
      if (!this.store || !current() || json === this.last) return "unchanged";
      try {
        await this.store.save(json);
        this.last = json;
        return "saved";
      } catch {
        this.last = null;
        return "unchanged";
      }
    });
    this.chain = run;
    return run;
  }
}
