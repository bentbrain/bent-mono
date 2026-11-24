/**
 * Reads Apple Health exports in the Health Auto Export JSON format: weigh-ins
 * from the body mass metric and running workouts. Other metrics and workout
 * types are counted and left out.
 */
import { z } from "zod";
import { localDate } from "../domain";

/** The payload is not in a shape this import reads. The message is safe to show. */
export class HealthImportError extends Error {}

export const healthImportLimits = { bytes: 4_000_000, samples: 2000 } as const;

const weightMetrics = new Set(["weight_body_mass", "body_mass", "weight"]);
const kgPer = new Map([
  ["kg", 1],
  ["lb", 0.45359237],
  ["lbs", 0.45359237],
  ["st", 6.35029318],
]);
const kmPer = new Map([
  ["km", 1],
  ["m", 0.001],
  ["mi", 1.609344],
  ["yd", 0.0009144],
]);
const running = /\brun(ning)?\b/i;

const quantity = z.object({ qty: z.number().finite(), units: z.string() });
const point = z.object({ date: z.string(), qty: z.number().finite() });
const metric = z.object({
  name: z.string(),
  units: z.string(),
  data: z.array(z.unknown()),
});
const workout = z.object({
  name: z.string(),
  start: z.string(),
  end: z.string().optional(),
  duration: z.number().finite().optional(),
  distance: quantity.nullish(),
});
const payload = z.object({
  data: z.object({
    metrics: z.array(metric).optional(),
    workouts: z.array(z.unknown()).optional(),
  }),
});

/** The earliest weigh-in of a date, and every weigh-in sent for that date. */
type HealthWeight = { date: string; at: string; kg: number; samples: string[] };
type HealthRun = {
  date: string;
  start: string;
  minutes: number;
  distanceKm: number;
};
type HealthSkip = {
  type: "weight" | "run";
  date: string | null;
  reason: string;
};
type HealthSamples = {
  weights: HealthWeight[];
  runs: HealthRun[];
  skipped: HealthSkip[];
  ignored: { metrics: number; workouts: number };
};

const timestamp =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)? ?(Z|[+-]\d{2}:?\d{2})$/;
const day = z.iso.date();

/**
 * Reads a timestamp with an offset, as Health Auto Export
 * (`yyyy-MM-dd HH:mm:ss +hhmm`) or ISO 8601 writes it. Dates that do not
 * exist, such as 30 February, are unreadable.
 */
export function healthInstant(value: string): Date | null {
  const parts = timestamp.exec(value.trim());
  if (!parts) return null;
  const [, y, mo, d, h, mi, s = "0", fraction = "0", zone = "Z"] = parts;
  const fields = [y, mo, d, h, mi, s].map(Number);
  const [year = 0, month = 0, date = 0, hour = 0, minute = 0, second = 0] =
    fields;
  const local = new Date(Date.UTC(year, month - 1, date, hour, minute, second));
  if (
    year < 1900 ||
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== date ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  )
    return null;
  let offset = 0;
  if (zone !== "Z") {
    const digits = zone.replace(":", "");
    const hours = Number(digits.slice(1, 3));
    const minutes = Number(digits.slice(3, 5));
    if (hours > 14 || minutes > 59) return null;
    offset = (digits.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
  }
  const milliseconds = Math.floor(Number("0." + fraction) * 1000);
  return new Date(local.getTime() - offset * 60000 + milliseconds);
}

function issue(error: z.ZodError, prefix: string) {
  const first = error.issues[0];
  const path = [prefix, ...(first?.path ?? [])].join(".");
  return `${path}: ${first?.message ?? "Check the value."}`;
}

function round(value: number, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * Reads weigh-ins and runs, dating each in the account timezone. Each date
 * gets the earliest weigh-in sent for it. Samples that cannot be recorded are
 * listed in `skipped` with the reason.
 */
export function readHealthExport(
  body: unknown,
  timezone: string,
  today = localDate(timezone),
): HealthSamples {
  const parsed = payload.safeParse(body);
  if (!parsed.success)
    throw new HealthImportError(
      `Send the Health Auto Export JSON format, with metrics or workouts under "data". ${issue(parsed.error, "body")}`,
    );
  const skipped: HealthSkip[] = [];
  const ignored = { metrics: 0, workouts: 0 };
  const earliest = new Map<string, HealthWeight>();
  let samples = 0;
  const count = () => {
    if (++samples > healthImportLimits.samples)
      throw new HealthImportError(
        `Send up to ${healthImportLimits.samples} weigh-ins and runs per request. Turn on Batch Requests in Health Auto Export, or sync a shorter date range.`,
      );
  };

  for (const [m, entry] of (parsed.data.data.metrics ?? []).entries()) {
    if (!weightMetrics.has(entry.name.toLowerCase())) {
      ignored.metrics++;
      continue;
    }
    const factor = kgPer.get(entry.units.toLowerCase());
    if (factor === undefined)
      throw new HealthImportError(
        `data.metrics.${m}.units: Send weight in kg, lb or st.`,
      );
    for (const [p, raw] of entry.data.entries()) {
      count();
      const sample = point.safeParse(raw);
      if (!sample.success)
        throw new HealthImportError(
          issue(sample.error, `data.metrics.${m}.data.${p}`),
        );
      const at = healthInstant(sample.data.date);
      if (!at) {
        skipped.push({
          type: "weight",
          date: null,
          reason: `Unreadable date "${sample.data.date.slice(0, 40)}".`,
        });
        continue;
      }
      const date = localDate(timezone, at);
      const kg = round(sample.data.qty * factor, 3);
      if (!day.safeParse(date).success) {
        skipped.push({
          type: "weight",
          date: null,
          reason: `Unreadable date "${sample.data.date.slice(0, 40)}".`,
        });
        continue;
      }
      if (date > today) {
        skipped.push({ type: "weight", date, reason: "Dated after today." });
        continue;
      }
      if (kg < 20 || kg > 500) {
        skipped.push({
          type: "weight",
          date,
          reason: "Weight is outside 20–500 kg.",
        });
        continue;
      }
      const instant = at.toISOString();
      const previous = earliest.get(date);
      if (!previous)
        earliest.set(date, { date, at: instant, kg, samples: [instant] });
      else {
        if (!previous.samples.includes(instant)) previous.samples.push(instant);
        if (instant < previous.at) {
          previous.at = instant;
          previous.kg = kg;
        }
      }
    }
  }

  const runs: HealthRun[] = [];
  const starts = new Set<string>();
  for (const [w, raw] of (parsed.data.data.workouts ?? []).entries()) {
    const name = z.object({ name: z.string() }).safeParse(raw);
    if (!name.success)
      throw new HealthImportError(issue(name.error, `data.workouts.${w}`));
    if (!running.test(name.data.name)) {
      ignored.workouts++;
      continue;
    }
    count();
    const entry = workout.safeParse(raw);
    if (!entry.success)
      throw new HealthImportError(issue(entry.error, `data.workouts.${w}`));
    const start = healthInstant(entry.data.start);
    const end =
      entry.data.end === undefined ? null : healthInstant(entry.data.end);
    if (!start) {
      skipped.push({
        type: "run",
        date: null,
        reason: `Unreadable start "${entry.data.start.slice(0, 40)}".`,
      });
      continue;
    }
    const date = localDate(timezone, start);
    const seconds =
      entry.data.duration ??
      (end ? (end.getTime() - start.getTime()) / 1000 : null);
    const distance = entry.data.distance;
    const factor = distance ? kmPer.get(distance.units.toLowerCase()) : 0;
    const distanceKm =
      distance && factor !== undefined ? round(distance.qty * factor, 3) : 0;
    const readable = day.safeParse(date).success;
    let reason: string | null = null;
    if (!readable)
      reason = `Unreadable start "${entry.data.start.slice(0, 40)}".`;
    else if (date > today) reason = "Dated after today.";
    else if (seconds === null)
      reason = "The workout has no duration or end time.";
    else if (!(seconds > 0) || seconds > 86400)
      reason = "Duration is outside 0–1440 minutes.";
    else if (factor === undefined) reason = "Send distance in km, m, mi or yd.";
    else if (distanceKm < 0 || distanceKm > 500)
      reason = "Distance is outside 0–500 km.";
    if (reason !== null || seconds === null) {
      skipped.push({
        type: "run",
        date: readable ? date : null,
        reason: reason ?? "",
      });
      continue;
    }
    const key = start.toISOString();
    if (starts.has(key)) continue;
    starts.add(key);
    runs.push({
      date,
      start: key,
      // Keep a very short run above zero minutes.
      minutes: Math.min(1440, Math.max(0.01, round(seconds / 60))),
      distanceKm,
    });
  }

  return {
    weights: [...earliest.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
    runs: runs.sort((a, b) => a.start.localeCompare(b.start)),
    skipped,
    ignored,
  };
}

/** A run recorded in Fitness on the same date with about the same distance. */
export function sameRun(a: { distanceKm: number }, b: { distanceKm: number }) {
  return (
    Math.abs(a.distanceKm - b.distanceKm) <=
    Math.max(0.1, 0.05 * Math.max(a.distanceKm, b.distanceKm))
  );
}
