/**
 * Reads Apple Health exports in the Health Auto Export JSON format: weigh-ins
 * from the body mass metric and running workouts. Other metrics and workout
 * types are counted and left out.
 *
 * Device sync requests use the same format with a ref on every entry. They
 * are checked in full before anything is saved: an entry Fitness cannot read
 * fails the request, and each ref gets its own outcome.
 */
import { z } from "zod";
import {
  DeviceHealthImportRequest,
  HealthEnvelope,
  HealthPoint,
  HealthWorkout,
  HealthWorkoutName,
  isRunningWorkout,
  isWeightMetric,
} from "@bent/fitness-contracts";
import type {
  ApiErrorCode,
  DistanceUnit,
  SampleType,
  WeightUnit,
} from "@bent/fitness-contracts";
import { localDate } from "../domain";

/** The payload is not in a shape this import reads. The message is safe to show. */
export class HealthImportError extends Error {
  constructor(
    message: string,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
  }
}

export const healthImportLimits = { bytes: 4_000_000, samples: 2000 } as const;

const kgPerUnit: Record<WeightUnit, number> = {
  kg: 1,
  lb: 0.45359237,
  lbs: 0.45359237,
  st: 6.35029318,
};
const kmPerUnit: Record<DistanceUnit, number> = {
  km: 1,
  m: 0.001,
  mi: 1.609344,
  yd: 0.0009144,
};
// Maps, so inherited property names such as "constructor" are unknown units.
const kgPer = new Map<string, number>(Object.entries(kgPerUnit));
const kmPer = new Map<string, number>(Object.entries(kmPerUnit));

/** Every weigh-in sent for one account date, earliest first. */
type HealthWeight = { date: string; samples: { at: string; kg: number }[] };
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
/** Why a device sample is skipped. */
type SkipCode = "future" | "out_of_range";
/**
 * One device entry in request order. `at` is the instant Fitness keys the
 * sample by; a later entry with the same instant and type is a duplicate.
 */
export type DeviceEntry = {
  ref: string;
  type: SampleType;
  at: string | null;
  skip: SkipCode | null;
  duplicate: boolean;
};
type HealthSamples = {
  weights: HealthWeight[];
  runs: HealthRun[];
  skipped: HealthSkip[];
  ignored: { metrics: number; workouts: number };
  /** Weigh-ins and running workouts in the payload, counted before dating. */
  sent: { weights: number; runs: number };
  /** Device requests only: each entry, and the timezone a backfill expects. */
  entries: DeviceEntry[];
  expectedTimezone: string | null;
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
  const path = [prefix, ...(first?.path ?? [])].filter((p) => p !== "");
  return `${path.join(".") || "body"}: ${first?.message ?? "Check the value."}`;
}

function round(value: number, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * The outcome of dating one sample: the sample, or a skip with its reason.
 * `code` is null when the sample is unreadable, which fails a device request.
 */
type Dated<T> =
  { sample: T } | { skip: HealthSkip; code: SkipCode | null; field: string };

function datedWeight(
  point: { date: string; qty: number },
  factor: number,
  timezone: string,
  today: string,
): Dated<{ date: string; at: string; kg: number }> {
  const unreadable = {
    skip: {
      type: "weight" as const,
      date: null,
      reason: `Unreadable date "${point.date.slice(0, 40)}".`,
    },
    code: null,
    field: "date",
  };
  const at = healthInstant(point.date);
  if (!at) return unreadable;
  const date = localDate(timezone, at);
  const kg = round(point.qty * factor, 3);
  if (!day.safeParse(date).success) return unreadable;
  if (date > today)
    return {
      skip: { type: "weight", date, reason: "Dated after today." },
      code: "future",
      field: "date",
    };
  if (kg < 20 || kg > 500)
    return {
      skip: { type: "weight", date, reason: "Weight is outside 20–500 kg." },
      code: "out_of_range",
      field: "qty",
    };
  return { sample: { date, at: at.toISOString(), kg } };
}

function datedRun(
  entry: z.infer<typeof HealthWorkout>,
  timezone: string,
  today: string,
): Dated<HealthRun> {
  const start = healthInstant(entry.start);
  const end = entry.end === undefined ? null : healthInstant(entry.end);
  if (!start)
    return {
      skip: {
        type: "run",
        date: null,
        reason: `Unreadable start "${entry.start.slice(0, 40)}".`,
      },
      code: null,
      field: "start",
    };
  const date = localDate(timezone, start);
  const seconds =
    entry.duration ?? (end ? (end.getTime() - start.getTime()) / 1000 : null);
  const distance = entry.distance;
  const factor = distance ? kmPer.get(distance.units.toLowerCase()) : 0;
  // Full precision for matching; the importer rounds when saving.
  const distanceKm =
    distance && factor !== undefined ? distance.qty * factor : 0;
  const readable = day.safeParse(date).success;
  let failure: { reason: string; code: SkipCode | null; field: string } | null =
    null;
  if (!readable)
    failure = {
      reason: `Unreadable start "${entry.start.slice(0, 40)}".`,
      code: null,
      field: "start",
    };
  else if (date > today)
    failure = { reason: "Dated after today.", code: "future", field: "start" };
  else if (seconds === null)
    failure = {
      reason: "The workout has no duration or end time.",
      code: null,
      field: entry.end === undefined ? "duration" : "end",
    };
  else if (!(seconds > 0) || seconds > 86400)
    failure = {
      reason: "Duration is outside 0–1440 minutes.",
      code: "out_of_range",
      field: "duration",
    };
  else if (factor === undefined)
    failure = {
      reason: "Send distance in km, m, mi or yd.",
      code: null,
      field: "distance.units",
    };
  else if (distanceKm < 0 || distanceKm > 500)
    failure = {
      reason: "Distance is outside 0–500 km.",
      code: "out_of_range",
      field: "distance.qty",
    };
  if (failure !== null || seconds === null)
    return {
      skip: {
        type: "run",
        date: readable ? date : null,
        reason: failure?.reason ?? "",
      },
      code: failure?.code ?? null,
      field: failure?.field ?? "start",
    };
  return {
    sample: {
      date,
      start: start.toISOString(),
      // Keep a very short run above zero minutes.
      minutes: Math.min(1440, Math.max(0.01, round(seconds / 60))),
      distanceKm,
    },
  };
}

/** Collects dated samples, keeping one weigh-in per instant and one run per start. */
function collector() {
  const byDate = new Map<string, HealthWeight>();
  const runs: HealthRun[] = [];
  const starts = new Set<string>();
  return {
    /** Adds a weigh-in, or returns false when its instant was already sent. */
    weight(sample: { date: string; at: string; kg: number }) {
      const group = byDate.get(sample.date) ?? {
        date: sample.date,
        samples: [],
      };
      byDate.set(sample.date, group);
      if (group.samples.some((s) => s.at === sample.at)) return false;
      group.samples.push({ at: sample.at, kg: sample.kg });
      return true;
    },
    /** Adds a run, or returns false when its start was already sent. */
    run(sample: HealthRun) {
      if (starts.has(sample.start)) return false;
      starts.add(sample.start);
      runs.push(sample);
      return true;
    },
    done() {
      return {
        weights: [...byDate.values()]
          .map((w) => ({
            ...w,
            samples: w.samples.sort((a, b) => a.at.localeCompare(b.at)),
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        runs: runs.sort((a, b) => a.start.localeCompare(b.start)),
      };
    },
  };
}

const tooMany = (hint: string) =>
  new HealthImportError(
    `Send up to ${healthImportLimits.samples} weigh-ins and runs per request. ${hint}`,
    "too_many_samples",
  );

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
  const parsed = HealthEnvelope.safeParse(body);
  if (!parsed.success)
    throw new HealthImportError(
      `Send the Health Auto Export JSON format, with metrics or workouts under "data". ${issue(parsed.error, "body")}`,
    );
  const skipped: HealthSkip[] = [];
  const ignored = { metrics: 0, workouts: 0 };
  const collected = collector();
  const sent = { weights: 0, runs: 0 };
  let samples = 0;
  const count = () => {
    if (++samples > healthImportLimits.samples)
      throw tooMany(
        "Turn on Batch Requests in Health Auto Export, or sync a shorter date range.",
      );
  };

  for (const [m, entry] of (parsed.data.data.metrics ?? []).entries()) {
    if (!isWeightMetric(entry.name)) {
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
      const sample = HealthPoint.safeParse(raw);
      if (!sample.success)
        throw new HealthImportError(
          issue(sample.error, `data.metrics.${m}.data.${p}`),
        );
      sent.weights++;
      const dated = datedWeight(sample.data, factor, timezone, today);
      if ("skip" in dated) skipped.push(dated.skip);
      else collected.weight(dated.sample);
    }
  }

  for (const [w, raw] of (parsed.data.data.workouts ?? []).entries()) {
    const name = HealthWorkoutName.safeParse(raw);
    if (!name.success)
      throw new HealthImportError(issue(name.error, `data.workouts.${w}`));
    if (!isRunningWorkout(name.data.name)) {
      ignored.workouts++;
      continue;
    }
    count();
    const entry = HealthWorkout.safeParse(raw);
    if (!entry.success)
      throw new HealthImportError(issue(entry.error, `data.workouts.${w}`));
    sent.runs++;
    const dated = datedRun(entry.data, timezone, today);
    if ("skip" in dated) skipped.push(dated.skip);
    else collected.run(dated.sample);
  }

  return {
    ...collected.done(),
    skipped,
    ignored,
    sent,
    entries: [],
    expectedTimezone: null,
  };
}

/**
 * Reads a device sync request. Every entry is checked before anything is
 * saved: a missing, malformed or repeated ref, an unsupported entry or one
 * Fitness cannot read fails the whole request with the entry's path. Samples
 * dated after today or outside the app's limits are skipped. The first ref
 * at each instant, per type, gets its own outcome, skipped or not; later
 * refs at that instant are duplicates.
 */
export function readDeviceExport(
  body: unknown,
  timezone: string,
  today = localDate(timezone),
): HealthSamples {
  const parsed = DeviceHealthImportRequest.safeParse(body);
  if (!parsed.success)
    throw new HealthImportError(
      issue(parsed.error, ""),
      "invalid_device_request",
    );
  const { metrics = [], workouts = [] } = parsed.data.data;
  const total =
    metrics.reduce((sum, metric) => sum + metric.data.length, 0) +
    workouts.length;
  if (total > healthImportLimits.samples)
    throw tooMany("Split the samples across requests.");
  const skipped: HealthSkip[] = [];
  const entries: DeviceEntry[] = [];
  const collected = collector();
  const sent = { weights: 0, runs: 0 };
  const unreadable = (path: string, reason: string) =>
    new HealthImportError(`${path}: ${reason}`, "invalid_device_request");
  // Instants claimed in request order, per type.
  const weightInstants = new Set<string>();
  const runStarts = new Set<string>();

  for (const [m, metric] of metrics.entries()) {
    const factor = kgPer.get(metric.units.toLowerCase());
    if (factor === undefined)
      throw unreadable(
        `data.metrics.${m}.units`,
        "Send weight in kg, lb or st.",
      );
    for (const [p, point] of metric.data.entries()) {
      sent.weights++;
      const dated = datedWeight(point, factor, timezone, today);
      if ("skip" in dated && dated.code === null)
        throw unreadable(
          `data.metrics.${m}.data.${p}.${dated.field}`,
          dated.skip.reason,
        );
      // The first ref at an instant claims it, whatever its outcome.
      const at = healthInstant(point.date)?.toISOString() ?? null;
      const entry = { ref: point.ref, type: "weight" as const, at };
      if (at === null || weightInstants.has(at)) {
        entries.push({ ...entry, skip: null, duplicate: true });
        continue;
      }
      weightInstants.add(at);
      if ("skip" in dated) {
        skipped.push(dated.skip);
        entries.push({ ...entry, skip: dated.code, duplicate: false });
        continue;
      }
      collected.weight(dated.sample);
      entries.push({ ...entry, skip: null, duplicate: false });
    }
  }

  for (const [w, workout] of workouts.entries()) {
    sent.runs++;
    if (workout.end !== undefined && !healthInstant(workout.end))
      throw unreadable(
        `data.workouts.${w}.end`,
        `Unreadable end "${workout.end.slice(0, 40)}".`,
      );
    const dated = datedRun(workout, timezone, today);
    if ("skip" in dated && dated.code === null)
      throw unreadable(`data.workouts.${w}.${dated.field}`, dated.skip.reason);
    const at = healthInstant(workout.start)?.toISOString() ?? null;
    const entry = { ref: workout.ref, type: "run" as const, at };
    if (at === null || runStarts.has(at)) {
      entries.push({ ...entry, skip: null, duplicate: true });
      continue;
    }
    runStarts.add(at);
    if ("skip" in dated) {
      skipped.push(dated.skip);
      entries.push({ ...entry, skip: dated.code, duplicate: false });
      continue;
    }
    collected.run(dated.sample);
    entries.push({ ...entry, skip: null, duplicate: false });
  }

  return {
    ...collected.done(),
    skipped,
    ignored: { metrics: 0, workouts: 0 },
    sent,
    entries,
    expectedTimezone: parsed.data.expectedTimezone ?? null,
  };
}

/** A run recorded in Fitness on the same date with about the same distance. */
export function sameRun(a: { distanceKm: number }, b: { distanceKm: number }) {
  const limit = Math.max(0.1, 0.05 * Math.max(a.distanceKm, b.distanceKm));
  // Allow for floating-point error, so a gap of exactly the limit matches.
  return Math.abs(a.distanceKm - b.distanceKm) <= limit + 1e-9;
}

type Distance = { distanceKm: number };

/**
 * Pairs one day's Health runs with runs entered in Fitness, each entered run
 * used at most once. The pairing matches as many runs as possible, then has
 * the smallest total distance difference, then keeps the most pairs from
 * earlier syncs, which `initial` gives. An earlier pair can move to another
 * entered run or give way to a closer match. Returns the entered index for
 * each Health run, or null.
 *
 * This is a minimum-cost maximum flow, found with successive shortest paths.
 */
export function assignRuns(
  health: Distance[],
  entered: Distance[],
  initial: (number | null)[] = [],
) {
  const pick: (number | null)[] = health.map(() => null);
  const n = health.length;
  const m = entered.length;
  if (!n || !m) return pick;
  // Any pair other than an earlier one costs a millionth of a kilometre more,
  // so earlier pairs win ties.
  const change = 1e-6;
  type Edge = { to: number; cap: number; cost: number; rev: number };
  const source = 0;
  const sink = n + m + 1;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const add = (from: number, to: number, cost: number) => {
    const forward = graph[from];
    const backward = graph[to];
    if (!forward || !backward) return;
    forward.push({ to, cap: 1, cost, rev: backward.length });
    backward.push({ to: from, cap: 0, cost: -cost, rev: forward.length - 1 });
  };
  health.forEach((run, i) => {
    const held = initial[i] ?? null;
    add(source, 1 + i, 0);
    entered.forEach((other, j) => {
      if (held !== j && !sameRun(run, other)) return;
      const gap = Math.abs(run.distanceKm - other.distanceKm);
      add(1 + i, 1 + n + j, gap + (held === j ? 0 : change));
    });
  });
  entered.forEach((_, j) => add(1 + n + j, sink, 0));

  for (let round = 0; round < Math.min(n, m); round++) {
    // Bellman-Ford over the residual graph, which can hold negative costs.
    const distance = graph.map(() => Infinity);
    const via: ({ node: number; edge: number } | null)[] = graph.map(
      () => null,
    );
    distance[source] = 0;
    for (let pass = 0; pass < graph.length; pass++) {
      let changed = false;
      graph.forEach((edges, node) => {
        const base = distance[node] ?? Infinity;
        if (base === Infinity) return;
        edges.forEach((edge, index) => {
          if (
            edge.cap > 0 &&
            base + edge.cost < (distance[edge.to] ?? Infinity) - 1e-9
          ) {
            distance[edge.to] = base + edge.cost;
            via[edge.to] = { node, edge: index };
            changed = true;
          }
        });
      });
      if (!changed) break;
    }
    if (distance[sink] === Infinity) break;
    for (let node = sink; node !== source;) {
      const step = via[node];
      const edge = step ? graph[step.node]?.[step.edge] : undefined;
      if (!step || !edge) break;
      edge.cap -= 1;
      const back = graph[edge.to]?.[edge.rev];
      if (back) back.cap += 1;
      node = step.node;
    }
  }
  health.forEach((_, i) => {
    const used = graph[1 + i]?.find(
      (edge) => edge.to > n && edge.to <= n + m && edge.cap === 0,
    );
    pick[i] = used ? used.to - n - 1 : null;
  });
  return pick;
}
