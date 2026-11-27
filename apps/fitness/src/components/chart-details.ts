import {
  displayLoad,
  formatDate,
  formatShortDate,
} from "@bent/fitness-contracts/domain";
import type { Settings } from "@bent/fitness-contracts/domain";
import type {
  StrengthPoint,
  StrengthSeries,
} from "@bent/fitness-contracts/progress";
import type { ChartDetail } from "./chart-popover";

type Units = Settings["units"];

/** A weight to one decimal place with its unit, such as "80.4 kg". */
function shownWeight(kg: number, units: Units) {
  return `${(Math.round(displayLoad(kg, units) * 10) / 10).toFixed(1)} ${units}`;
}

/** A change in weight with its sign, such as "+0.4 kg" or "−1.2 kg". */
export function weightChange(kg: number, units: Units) {
  const shown = Math.round(displayLoad(Math.abs(kg), units) * 10) / 10;
  if (!shown) return "No change";
  return `${kg > 0 ? "+" : "−"}${shown.toFixed(1)} ${units}`;
}

/** One set result as the strength cards show it, such as "12 kg × 8". */
export function pointText(
  point: StrengthPoint,
  series: StrengthSeries,
  units: Units,
) {
  const amount =
    series.mode === "seconds"
      ? `${point.value} s`
      : `${displayLoad(point.loadKg, units)} ${units} × ${point.value}`;
  return series.side ? `${amount} each side` : amount;
}

/**
 * The change from one session to the next: the load when it changed,
 * otherwise the reps or seconds.
 */
export function strengthChange(
  from: StrengthPoint,
  to: StrengthPoint,
  series: StrengthSeries,
  units: Units,
) {
  const signed = (value: number, unit: string) =>
    `${value > 0 ? "+" : "−"}${Math.abs(value)} ${unit}`;
  if (series.mode === "reps") {
    const load =
      Math.round(
        (displayLoad(to.loadKg, units) - displayLoad(from.loadKg, units)) *
          100,
      ) / 100;
    if (load) return signed(load, units);
  }
  const delta = to.value - from.value;
  if (!delta) return "No change";
  if (series.mode === "seconds") return signed(delta, "s");
  return signed(delta, Math.abs(delta) === 1 ? "rep" : "reps");
}

/** The popover for one session on a strength chart. */
export function strengthDetail(
  series: StrengthSeries,
  index: number,
  units: Units,
): ChartDetail {
  const point = series.points[index];
  if (!point) return { title: "", rows: [] };
  const previous = series.points[index - 1];
  return {
    title: formatDate(point.date),
    rows: [
      {
        label: series.mode === "seconds" ? "Longest hold" : "Best set",
        value: pointText(point, series, units),
        marker: "line",
      },
      previous
        ? {
            label: `Since ${formatShortDate(previous.date)}`,
            value: strengthChange(previous, point, series, units),
          }
        : { label: "Session", value: "First in this chart" },
    ],
  };
}

/**
 * The popover for one weigh-in: its value, the average of up to 7
 * weigh-ins ending on that date when `average` is given, and the change
 * from the weigh-in before.
 */
export function weighInDetail(
  points: { date: string; kg: number }[],
  index: number,
  units: Units,
  average?: { kg: number; count: number },
): ChartDetail {
  const point = points[index];
  if (!point) return { title: "", rows: [] };
  const previous = points[index - 1];
  const rows: ChartDetail["rows"] = [
    { label: "Weigh-in", value: shownWeight(point.kg, units), marker: "line" },
  ];
  if (average)
    rows.push({
      label: `Average of ${average.count}`,
      value: shownWeight(average.kg, units),
      marker: "dash",
    });
  if (previous)
    rows.push({
      label: `Since ${formatShortDate(previous.date)}`,
      value: weightChange(point.kg - previous.kg, units),
    });
  return { title: formatDate(point.date), rows };
}

/** The popover for one day of the food chart. */
export function foodDayDetail(
  day: string,
  eaten: { calories: number; protein: number },
  target: number,
): ChartDetail {
  const calories = Math.round(eaten.calories);
  const left = target - calories;
  return {
    title: formatDate(day),
    rows: [
      { label: "Calories", value: `${calories} kcal`, marker: "bar" },
      { label: "Target", value: `${target} kcal`, marker: "target" },
      left >= 0
        ? { label: "Left", value: `${left} kcal` }
        : { label: "Over", value: `${-left} kcal` },
      { label: "Protein", value: `${Math.round(eaten.protein)} g` },
    ],
  };
}
