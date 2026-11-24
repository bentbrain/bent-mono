/**
 * Reads Apple Health exports in the Health Auto Export JSON format: weigh-ins
 * from the body mass metric and running workouts. Other metrics and workout
 * types are counted and left out.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { localDate } from "../domain";

/** The payload is not in a shape this import reads. The message is safe to show. */
export class HealthImportError extends Error {}

export const healthImportLimits = { bytes: 4_000_000, samples: 2000 } as const;

const weightMetrics = new Set(["weight_body_mass", "body_mass", "weight"]);
const kgPer: Record<string, number> = {
  kg: 1,
  lb: 0.45359237,
  lbs: 0.45359237,
  st: 6.35029318,
};
const kmPer: Record<string, number> = {
  km: 1,
  m: 0.001,
  mi: 1.609344,
  yd: 0.0009144,
};
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

type HealthWeight = { date: string; at: string; kg: number };
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

const exportDate =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2}):?(\d{2})$/;
const isoDate =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Reads a timestamp with an offset, as Health Auto Export or ISO 8601 writes it. */
export function healthInstant(value: string): Date | null {
  const local = exportDate.exec(value.trim());
  const text = local
    ? `${local[1]}T${local[2]}${local[3]}:${local[4]}`
    : value.trim();
  if (!local && !isoDate.test(text)) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time) : null;
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
 * Reads weigh-ins and runs, dating each in the account timezone. One weigh-in
 * is kept per date: the earliest that day. Samples that cannot be recorded are
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
    const factor = kgPer[entry.units.toLowerCase()];
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
      const kg = sample.data.qty * factor;
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
      const previous = earliest.get(date);
      if (!previous || at.toISOString() < previous.at)
        earliest.set(date, { date, at: at.toISOString(), kg: round(kg, 3) });
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
    const minutes = seconds === null ? null : round(seconds / 60);
    const distance = entry.data.distance;
    const factor = distance ? kmPer[distance.units.toLowerCase()] : 0;
    let reason: string | null = null;
    if (date > today) reason = "Dated after today.";
    else if (minutes === null)
      reason = "The workout has no duration or end time.";
    else if (minutes <= 0 || minutes > 1440)
      reason = "Duration is outside 0–1440 minutes.";
    else if (factor === undefined) reason = "Send distance in km, m, mi or yd.";
    else if (distance && (distance.qty < 0 || distance.qty * factor > 500))
      reason = "Distance is outside 0–500 km.";
    if (reason !== null || minutes === null) {
      skipped.push({ type: "run", date, reason: reason ?? "" });
      continue;
    }
    const key = start.toISOString();
    if (starts.has(key)) continue;
    starts.add(key);
    runs.push({
      date,
      start: key,
      minutes,
      distanceKm: distance ? round(distance.qty * (factor ?? 0), 3) : 0,
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

/**
 * The record ID for an imported entry: the same Health sample always maps to
 * the same ID, so a later sync finds what an earlier one saved.
 */
export function healthRecordId(key: string) {
  const hex = createHash("sha256")
    .update("fitness-apple-health:" + key)
    .digest("hex")
    .split("");
  hex[12] = "8";
  hex[16] = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Whether a record ID came from `healthRecordId`. The app's own IDs are version 4. */
export function isHealthRecordId(id: string) {
  return id[14] === "8";
}

/** A run recorded in Fitness on the same date with about the same distance. */
export function sameRun(a: { distanceKm: number }, b: { distanceKm: number }) {
  return (
    Math.abs(a.distanceKm - b.distanceKm) <=
    Math.max(0.1, 0.05 * Math.max(a.distanceKm, b.distanceKm))
  );
}
