import {
  addDays,
  completedActivity,
  mondayOf,
  scheduled,
  trainingRecords,
} from "./domain";
import type { Exercise, RecordEntry, Settings, Workout } from "./domain";

export type WeekSummary = {
  monday: string;
  strength: { done: number; planned: number };
  runs: { done: number; planned: number };
};

/**
 * Planned and completed sessions for each week, oldest first. Planned counts
 * use the repeating week from the plan start date; completed counts use
 * corrected results, so a removed workout does not count.
 */
export function weeklySummary(
  settings: Settings,
  records: RecordEntry[],
  today: string,
  weeks: number,
): WeekSummary[] {
  const activity = completedActivity(records);
  const current = mondayOf(today);
  return Array.from({ length: weeks }, (_, index) => {
    const monday = addDays(current, (index - weeks + 1) * 7);
    const summary: WeekSummary = {
      monday,
      strength: { done: 0, planned: 0 },
      runs: { done: 0, planned: 0 },
    };
    for (let offset = 0; offset < 7; offset++) {
      const day = addDays(monday, offset);
      // Days before the plan start date had no plan.
      const plan =
        day < settings.startDate ? "rest" : scheduled(settings, day).type;
      const done = activity.get(day);
      if (plan === "strength") summary.strength.planned++;
      if (plan === "run") summary.runs.planned++;
      if (done?.strength) summary.strength.done++;
      if (done?.run) summary.runs.done++;
    }
    return summary;
  });
}

/** One completed session's best set for an exercise. */
export type StrengthPoint = {
  date: string;
  /** Heaviest completed load in kilograms. Zero for timed exercises. */
  loadKg: number;
  /** Reps or seconds at that load. Sided exercises use the weaker side. */
  value: number;
};
export type StrengthSeries = {
  /** Exercise ID, measurement and sides. Variants are never mixed. */
  key: string;
  name: string;
  mode: Exercise["mode"];
  side: boolean;
  points: StrengthPoint[];
};

function bestSet(exercise: Workout["exercises"][number]) {
  let best: { loadKg: number; value: number } | undefined;
  for (const set of exercise.sets) {
    if (!set.done) continue;
    const value = exercise.prescription.side
      ? Math.min(set.value, set.right ?? 0)
      : set.value;
    if (
      !best ||
      set.loadKg > best.loadKg ||
      (set.loadKg === best.loadKg && value > best.value)
    )
      best = { loadKg: set.loadKg, value };
  }
  return best;
}

/**
 * The best completed set per session for each exercise, grouped by exercise,
 * measurement and sides, oldest session first. Corrections replace or hide
 * their original workouts.
 */
export function strengthSeries(records: RecordEntry[]): StrengthSeries[] {
  const workouts = trainingRecords(records)
    .flatMap((record) =>
      record.data.kind === "workout" && record.data.finishedAt
        ? [record.data]
        : [],
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""),
    );
  const series = new Map<string, StrengthSeries>();
  for (const workout of workouts)
    for (const exercise of workout.exercises) {
      const best = bestSet(exercise);
      if (!best) continue;
      const p = exercise.prescription;
      const key = `${p.id}:${p.mode}:${p.side ? "sides" : "single"}`;
      const entry = series.get(key) ?? {
        key,
        name: p.name,
        mode: p.mode,
        side: p.side,
        points: [],
      };
      entry.name = p.name;
      entry.points.push({ date: workout.date, ...best });
      series.set(key, entry);
    }
  return [...series.values()].sort(
    (a, b) =>
      (b.points.at(-1)?.date ?? "").localeCompare(
        a.points.at(-1)?.date ?? "",
      ) || a.name.localeCompare(b.name),
  );
}

/** The latest weigh-in for each date, oldest first. */
export function dailyWeights(records: RecordEntry[]) {
  const byDate = new Map<string, { id: string; date: string; kg: number }>();
  for (const record of records)
    if (record.data.kind === "weight")
      byDate.set(record.data.date, {
        id: record.id,
        date: record.data.date,
        kg: record.data.kg,
      });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The average of the latest seven weigh-ins and, once there are more than
 * seven, the change from the average of the seven before them.
 */
export function weightTrend(daily: { date: string; kg: number }[]) {
  const latest = daily.slice(-7);
  const before = daily.slice(-14, -7);
  return {
    average: latest.length ? mean(latest.map((w) => w.kg)) : null,
    count: latest.length,
    change:
      latest.length && before.length
        ? mean(latest.map((w) => w.kg)) - mean(before.map((w) => w.kg))
        : null,
    comparedCount: before.length,
  };
}
