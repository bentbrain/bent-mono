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
type HealthSamples = {
  weights: HealthWeight[];
  runs: HealthRun[];
  skipped: HealthSkip[];
  ignored: { metrics: number; workouts: number };
  /** Weigh-ins and running workouts in the payload, counted before dating. */
  sent: { weights: number; runs: number };
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
  const byDate = new Map<string, HealthWeight>();
  const sent = { weights: 0, runs: 0 };
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
      sent.weights++;
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
      const group = byDate.get(date) ?? { date, samples: [] };
      byDate.set(date, group);
      if (!group.samples.some((s) => s.at === instant))
        group.samples.push({ at: instant, kg });
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
    sent.runs++;
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
    // Full precision for matching; the importer rounds when saving.
    const distanceKm =
      distance && factor !== undefined ? distance.qty * factor : 0;
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
    weights: [...byDate.values()]
      .map((w) => ({
        ...w,
        samples: w.samples.sort((a, b) => a.at.localeCompare(b.at)),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    runs: runs.sort((a, b) => a.start.localeCompare(b.start)),
    skipped,
    ignored,
    sent,
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
