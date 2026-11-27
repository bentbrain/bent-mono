import { displayLoad, formatShortDate, mondayOf, toKg, trainingRecords, weightSchema } from "@bent/fitness-contracts/domain";
import type { RecordEntry, Settings, Workout } from "@bent/fitness-contracts/domain";
import type { StrengthPoint, StrengthSeries, WeekSummary } from "@bent/fitness-contracts/progress";
import { runText } from "../../logic/format";

type Units = Settings["units"];
type Count = WeekSummary["strength"];

/** A weight rounded to one decimal place, such as "80.4". */
export function roundedWeight(kg: number, units: Units) {
  return (Math.round(displayLoad(kg, units) * 10) / 10).toFixed(1);
}

/** A weight with its unit, such as "80.4 kg". */
export function shownWeight(kg: number, units: Units) {
  return `${roundedWeight(kg, units)} ${units}`;
}

/** "3/4" for a planned week, "2 done" when nothing was planned. */
export function countText(count: Count) {
  return count.planned ? `${count.done}/${count.planned}` : `${count.done} done`;
}

/** A week's sessions in words, for VoiceOver. */
export function countSpoken(count: Count, noun: "strength session" | "run") {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return count.planned ? `${count.done} of ${plural(count.planned)} done` : `${plural(count.done)} done`;
}

/** The weeks the Progress screen shows: from the plan start, or any with sessions. */
export function shownWeeks(weeks: WeekSummary[], startDate: string) {
  const start = mondayOf(startDate);
  return weeks.filter((week) => week.monday >= start || week.strength.done > 0 || week.runs.done > 0);
}

/** "18 Nov", the label for the week starting on that Monday. */
export const weekLabel = (monday: string) => formatShortDate(monday).slice(4);

export type WeekBar = { x: string; y: number; part: "strength" | "runs" | "open" };

/**
 * Stacked bars for each week, oldest first: completed strength sessions,
 * completed runs, then planned sessions not recorded.
 */
export function weekBars(weeks: WeekSummary[]): WeekBar[] {
  return weeks.flatMap((week) => {
    const x = weekLabel(week.monday);
    const open =
      Math.max(0, week.strength.planned - week.strength.done) + Math.max(0, week.runs.planned - week.runs.done);
    return [
      { x, y: week.strength.done, part: "strength" as const },
      { x, y: week.runs.done, part: "runs" as const },
      { x, y: open, part: "open" as const },
    ];
  });
}

/** One set result as the strength cards show it. */
export function pointText(point: StrengthPoint, series: StrengthSeries, units: Units) {
  const amount = series.mode === "seconds" ? `${point.value} s` : `${displayLoad(point.loadKg, units)} ${units} × ${point.value}`;
  return series.side ? `${amount} each side` : amount;
}

/** What a strength card measures, how it changed and the values it charts. */
export function strengthSummary(series: StrengthSeries, units: Units) {
  const first = series.points[0];
  const latest = series.points.at(-1);
  if (!first || !latest) return null;
  const byLoad = series.mode === "reps" && series.points.some((point) => point.loadKg !== first.loadKg);
  const measure =
    series.mode === "seconds"
      ? "Longest completed hold"
      : byLoad
        ? `Heaviest completed set, ${units} per dumbbell`
        : `Reps at ${displayLoad(first.loadKg, units)} ${units}`;
  let change = "";
  if (series.points.length > 1) {
    if (byLoad) {
      const delta = displayLoad(latest.loadKg, units) - displayLoad(first.loadKg, units);
      change = delta ? `${delta > 0 ? "+" : ""}${Math.round(delta * 100) / 100} ${units}` : "No change";
    } else {
      const delta = latest.value - first.value;
      change = delta ? `${delta > 0 ? "+" : ""}${delta} ${series.mode === "seconds" ? "s" : "reps"}` : "No change";
    }
  }
  return {
    first,
    latest,
    measure,
    change,
    chip: `${series.mode === "seconds" ? "Timed" : "Reps"}${series.side ? " · each side" : ""}`,
    values: series.points.map((point) => (byLoad ? displayLoad(point.loadKg, units) : point.value)),
    spoken: `${series.name}: ${measure}, ${series.points.length} sessions from ${pointText(first, series, units)} to ${pointText(latest, series, units)}.`,
  };
}

/** The averages comparison under the Progress bodyweight summary. */
export function trendText(
  trend: { change: number | null; comparedCount: number },
  units: Units,
) {
  if (trend.change === null) return "Record more than 7 weigh-ins to compare averages.";
  const sign = trend.change > 0 ? "+" : trend.change < 0 ? "−" : "±";
  return `${sign}${shownWeight(Math.abs(trend.change), units)} compared with the ${trend.comparedCount} weigh-in${trend.comparedCount === 1 ? "" : "s"} before.`;
}

export type Session = { id: string; data: Workout | Extract<RecordEntry["data"], { kind: "run" }> };

/** Completed workouts and runs with corrections applied, newest first. */
export function recentSessions(records: RecordEntry[], limit: number): Session[] {
  return trainingRecords(records)
    .flatMap((record): Session[] =>
      (record.data.kind === "workout" && record.data.finishedAt) || record.data.kind === "run"
        ? [{ id: record.id, data: record.data }]
        : [],
    )
    .sort((a, b) => b.data.date.localeCompare(a.data.date))
    .slice(0, limit);
}

/** "Easy run" or the workout name. */
export const sessionName = (session: Session) => (session.data.kind === "run" ? "Easy run" : session.data.name);

/** "30 min · 5 km" for a run, "12 sets done" for a workout. */
export function sessionDetail(session: Session) {
  if (session.data.kind === "run") return runText(session.data);
  const sets = session.data.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
  return `${sets} sets done`;
}

/**
 * Values for a chart drawn without axes, measured from just below the
 * lowest value so small changes stay visible. `pad` is the space kept
 * above and below.
 */
export function chartScale(values: number[], pad: number) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const base = low - pad;
  return { base, low, high, top: high - base + pad, shift: (value: number) => value - base };
}

export type Weigh = { id: string; date: string; kg: number };

/** Whole days from one date to another. */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * The bodyweight chart: the latest weigh-in for each of the last 60 dates
 * and the average of up to 7 weigh-ins ending on each of them.
 */
export function bodyChart(daily: Weigh[]) {
  const points = daily.slice(-60);
  const trend = points.map((point, index) => {
    const window = points.slice(Math.max(0, index - 6), index + 1);
    return { date: point.date, kg: window.reduce((sum, item) => sum + item.kg, 0) / window.length };
  });
  const recent = daily.slice(-7);
  return {
    points,
    trend,
    lowest: points.length ? Math.min(...points.map((w) => w.kg)) : null,
    highest: points.length ? Math.max(...points.map((w) => w.kg)) : null,
    average: recent.length ? recent.reduce((n, w) => n + w.kg, 0) / recent.length : null,
  };
}

/** The weights the entry form accepts, in the person's units. */
export function weightLimits(units: Units) {
  return {
    min: Math.ceil(displayLoad(20, units) * 10) / 10,
    max: Math.floor(displayLoad(500, units) * 10) / 10,
  };
}

/** Checks a typed weigh-in. Returns the record to save or a message. */
export function parseWeighIn(
  date: string,
  text: string,
  units: Units,
): { error: string } | { data: Extract<RecordEntry["data"], { kind: "weight" }> } {
  const trimmed = text.trim().replace(",", ".");
  const value = Number(trimmed);
  const limits = weightLimits(units);
  if (!trimmed || !Number.isFinite(value)) return { error: "Enter a valid date and weight." };
  if (value < limits.min || value > limits.max)
    return { error: `Enter a weight from ${limits.min} to ${limits.max} ${units}.` };
  const result = weightSchema.safeParse({ kind: "weight", date, kg: toKg(value, units) });
  return result.success ? { data: result.data } : { error: "Enter a valid date and weight." };
}

/** The latest weigh-in saved for a date, which a new weigh-in replaces. */
export function weighInOn(records: RecordEntry[], date: string) {
  let found: Weigh | undefined;
  for (const record of records)
    if (record.data.kind === "weight" && record.data.date === date) found = { id: record.id, date, kg: record.data.kg };
  return found;
}

/** The record a new weigh-in for this date replaces, as the web app finds it. */
export function replacedWeighIn(records: RecordEntry[], date: string) {
  return records.find((r) => r.data.kind === "weight" && r.data.date === date)?.id;
}
