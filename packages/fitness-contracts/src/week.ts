import { addDays, formatShortDate, reorganiseDays, sameData, scheduled } from "./domain";
import type { Entity, RecordEntry, Settings } from "./domain";

/*
 * Week rules the website and the iPhone app share: weekly plan progress and
 * reorganising a week by dragging sessions between days.
 */

type Plan = ReturnType<typeof scheduled>;

/** The seven days of the week starting on `monday`. */
export function weekDays(monday: string) {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** "Strength A", "Easy run" or "Rest" for a planned day. */
export function sessionName(plan: Plan) {
  return plan.type === "strength" ? (plan.routine?.name ?? "Strength") : plan.type === "run" ? "Easy run" : "Rest";
}

/**
 * How far a weekly total is through its plan. The plan is met once every
 * planned session is done; a total with nothing planned or done has no progress.
 */
export function planProgress({ done, planned }: { done: number; planned: number }) {
  if (planned <= 0 && done <= 0) return null;
  return { met: done >= planned, fraction: planned > 0 ? Math.min(1, done / planned) : 1 };
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

/**
 * Whether two days hold the same session: the same type and, for strength,
 * the same routine snapshot. A dated plan keeps the routine as it was when
 * the day was moved, so a renamed or edited routine counts as different.
 */
function samePlan(a: Plan, b: Plan) {
  return a.type === b.type && (a.type !== "strength" || sameData(a.routine ?? null, b.routine ?? null));
}

/**
 * The fewest swaps that turn `start` into `goal`, as pairs of positions.
 * Each value names a session; a week has at most seven open days, so a
 * breadth-first search over the arrangements stays small.
 */
function fewestSwaps(start: number[], goal: number[]): [number, number][] | undefined {
  const target = goal.join(",");
  const paths = new Map<string, [number, number][]>([[start.join(","), []]]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: number[][] = [];
    for (const state of frontier) {
      const path = paths.get(state.join(",")) ?? [];
      if (state.join(",") === target) return path;
      state.forEach((key, i) => {
        if (key === goal[i]) return;
        for (let j = i + 1; j < state.length; j += 1) {
          // Days already holding their session stay out of the swaps.
          if (state[j] === key || state[j] === goal[j]) continue;
          const swapped = [...state];
          [swapped[i], swapped[j]] = [state[j] ?? key, key];
          const id = swapped.join(",");
          if (paths.has(id)) continue;
          paths.set(id, [...path, [i, j]]);
          next.push(swapped);
        }
      });
    }
    frontier = next;
  }
  return undefined;
}

/**
 * One row of the reorganise list. `source` is the day whose planned session
 * sits on `day`; a new arrangement starts with every session on its own day.
 */
export type WeekSlot = { day: string; source: string; session: string; locked: boolean };

/** The week as the reorganise list shows it, with `order[i]` placed on the week's day `i`. */
export function weekSlots(settings: Settings, days: string[], order: string[], today: string, records: RecordEntry[]): WeekSlot[] {
  return days.map((day, index) => {
    const source = order[index] ?? day;
    return { day, source, session: sessionName(scheduled(settings, source)), locked: lockedDay(day, today, records) };
  });
}

/**
 * Applies a drag in the reorganise list. The moved sessions land among the
 * open days in the order shown, and fixed days keep their sessions. Indices
 * follow SwiftUI's `onMove`, which the website's list follows too:
 * `destination` counts rows before the moved ones are taken out.
 */
export function reorderWeek(order: string[], locked: boolean[], sources: number[], destination: number) {
  const moving = sources.filter((index) => !locked[index] && index < order.length);
  if (moving.length === 0) return order;
  const stays = (index: number) => !locked[index] && !moving.includes(index);
  const open = order.filter((_, index) => stays(index));
  const at = order.slice(0, Math.max(0, destination)).filter((_, index) => stays(index)).length;
  open.splice(at, 0, ...moving.map((index) => order[index] ?? ""));
  let next = 0;
  return order.map((source, index) => (locked[index] ? source : (open[next++] ?? source)));
}

/**
 * The days whose session changes, as "2 days change: Sat 28, Sun 29." The
 * list shows the new sessions, so this names only the days.
 */
export function reorderPreview(settings: Settings, days: string[], order: string[]) {
  const changed = days.filter((day, index) => !samePlan(scheduled(settings, order[index] ?? day), scheduled(settings, day)));
  if (changed.length === 0) return "";
  const names = changed.map((day) => formatShortDate(day).split(" ").slice(0, 2).join(" "));
  return `${changed.length === 1 ? "1 day changes" : `${changed.length} days change`}: ${names.join(", ")}.`;
}

/**
 * Turns the arrangement the list shows into settings with the fewest swaps
 * of the shared reorganise rule, so only days whose session changes gain a
 * dated plan. A change saved on another device since the sheet opened stops
 * the save, so it never overwrites that edit.
 */
export function planWeek(
  origin: { settings: Settings; revision: number },
  latest: { revision: number; data: Entity | null },
  days: string[],
  order: string[],
  today: string,
  records: RecordEntry[],
): { settings: Settings } | { error: string } {
  if (latest.revision !== origin.revision || !sameData(latest.data, origin.settings))
    return { error: "Your plan changed. Close this sheet and reopen it to use the saved plan." };
  // The arrangement must hold exactly this week's days, so a draft never lands on another week.
  if (order.length !== days.length || [...order].sort().join() !== [...days].sort().join())
    return { error: "The week changed. Close this sheet and reopen it to arrange the week shown." };
  const sessions: Plan[] = [];
  const keyOf = (plan: Plan) => {
    const found = sessions.findIndex((session) => samePlan(session, plan));
    if (found >= 0) return found;
    sessions.push(plan);
    return sessions.length - 1;
  };
  const current = days.map((day) => keyOf(scheduled(origin.settings, day)));
  const wanted = days.map((day, index) => keyOf(scheduled(origin.settings, order[index] ?? day)));
  const open = days.flatMap((day, index) => (lockedDay(day, today, records) ? [] : [index]));
  const recorded = "A session was recorded or started on one of these days. Close this sheet and reopen it to see the current week.";
  if (current.some((key, index) => !open.includes(index) && key !== wanted[index])) return { error: recorded };
  const swaps = fewestSwaps(
    open.map((index) => current[index] ?? -1),
    open.map((index) => wanted[index] ?? -1),
  );
  if (!swaps) return { error: recorded };
  try {
    let settings = origin.settings;
    for (const [a, b] of swaps) {
      const [first, second] = [days[open[a] ?? -1] ?? "", days[open[b] ?? -1] ?? ""];
      // The shared rule moves a planned session, so a rest day is never the source.
      const [from, to] = scheduled(settings, first).type === "rest" ? [second, first] : [first, second];
      settings = reorganiseDays(settings, from, to, today, records);
    }
    return { settings };
  } catch (problem) {
    return { error: problem instanceof Error ? problem.message : "Check the selected days." };
  }
}
