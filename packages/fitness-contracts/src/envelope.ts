/**
 * Apple Health import request bodies for `POST /api/health/import`.
 *
 * `HealthEnvelope` is the Health Auto Export JSON shape that Shortcuts and
 * exports send. It reads structure only: unknown metrics and workouts are
 * counted and left out by the importer, which also converts units, reads
 * timestamps and decides which samples to skip.
 *
 * `DeviceHealthImportRequest` is the same shape for import-only device keys,
 * with a required `ref` on every entry and only weigh-ins and runs allowed.
 */
import { z } from "zod";

/** Metric names read as weigh-ins, compared in lower case. */
export const weightMetricNames = [
  "weight_body_mass",
  "body_mass",
  "weight",
] as const;
/** Weight units the importer converts to kg, compared in lower case. */
export const weightUnits = ["kg", "lb", "lbs", "st"] as const;
/** Distance units the importer converts to km, compared in lower case. */
export const distanceUnits = ["km", "m", "mi", "yd"] as const;
export type WeightUnit = (typeof weightUnits)[number];
export type DistanceUnit = (typeof distanceUnits)[number];

const running = /\brun(ning)?\b/i;
/** Workouts whose name contains Run or Running are runs. */
export function isRunningWorkout(name: string) {
  return running.test(name);
}
export function isWeightMetric(name: string) {
  return (weightMetricNames as readonly string[]).includes(name.toLowerCase());
}
function listed<T extends string>(values: readonly T[], value: string) {
  return (values as readonly string[]).includes(value.toLowerCase());
}

export const HealthQuantity = z.object({
  qty: z.number().finite(),
  units: z.string(),
});
/** One metric sample, such as a weigh-in. */
export const HealthPoint = z.object({
  date: z.string(),
  qty: z.number().finite(),
});
export const HealthMetric = z.object({
  name: z.string(),
  units: z.string(),
  data: z.array(z.unknown()),
});
/** Every workout entry has a name; only running workouts are read further. */
export const HealthWorkoutName = z.object({ name: z.string() });
export const HealthWorkout = z.object({
  name: z.string(),
  start: z.string(),
  end: z.string().optional(),
  duration: z.number().finite().optional(),
  distance: HealthQuantity.nullish(),
});
/** The top-level Health Auto Export shape. Entries are read one at a time. */
export const HealthEnvelope = z.object({
  data: z.object({
    metrics: z.array(HealthMetric).optional(),
    workouts: z.array(z.unknown()).optional(),
  }),
});

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const refPattern = new RegExp(`^([a-z]):(${uuid})$`, "i");
/** Ref prefixes: `w:` for weigh-ins and `r:` for runs. */
export const refPrefix = { weight: "w", run: "r" } as const;
export type SampleType = keyof typeof refPrefix;

/** The canonical form of a ref, with its UUID in lower case. */
export function canonicalRef(ref: string) {
  const parts = refPattern.exec(ref);
  return parts ? `${parts[1]?.toLowerCase()}:${parts[2]?.toLowerCase()}` : null;
}

function refFor(type: SampleType) {
  const prefix = refPrefix[type];
  const label = type === "weight" ? "weigh-in" : "run";
  return z.string().superRefine((value, context) => {
    const canonical = canonicalRef(value);
    if (!canonical)
      context.addIssue({
        code: "custom",
        message: `Send the ${label}'s ref as ${prefix}:<uuid>.`,
      });
    else if (!canonical.startsWith(prefix + ":"))
      context.addIssue({
        code: "custom",
        message: `A ${label} ref starts with ${prefix}:.`,
      });
  });
}

/** ISO 8601 with seconds and an offset, as `ISO8601DateFormatter` writes it. */
const deviceTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/,
    "Send an ISO 8601 timestamp with seconds and an offset.",
  );

export const DeviceWeightPoint = z.object({
  ref: refFor("weight"),
  date: deviceTimestamp,
  qty: z.number().finite(),
});
export const DeviceWeightMetric = z.object({
  name: z
    .string()
    .refine(isWeightMetric, "Send weigh-ins as the weight_body_mass metric."),
  units: z
    .string()
    .refine((u) => listed(weightUnits, u), "Send weight in kg, lb or st."),
  data: z.array(DeviceWeightPoint),
});
export const DeviceRun = z
  .object({
    ref: refFor("run"),
    name: z.string().refine(isRunningWorkout, "Send running workouts only."),
    start: deviceTimestamp,
    end: deviceTimestamp.optional(),
    duration: z.number().finite().optional(),
    distance: z
      .object({
        qty: z.number().finite(),
        units: z
          .string()
          .refine(
            (u) => listed(distanceUnits, u),
            "Send distance in km, m, mi or yd.",
          ),
      })
      .nullish(),
  })
  .refine((run) => run.duration !== undefined || run.end !== undefined, {
    message: "Send the run's duration or end time.",
    path: ["duration"],
  });

/**
 * A device sync request. Every entry carries a ref, and each ref appears
 * once. `expectedTimezone` is the account timezone a backfill grouped its
 * days in; the import fails with `timezone_changed` when the account uses
 * another one.
 */
export const DeviceHealthImportRequest = z
  .object({
    expectedTimezone: z.string().min(1).max(64).optional(),
    data: z.object({
      metrics: z.array(DeviceWeightMetric).optional(),
      workouts: z.array(DeviceRun).optional(),
    }),
  })
  .superRefine((request, context) => {
    const seen = new Map<string, string>();
    const check = (ref: string, path: (string | number)[]) => {
      const canonical = canonicalRef(ref);
      if (!canonical) return;
      const first = seen.get(canonical);
      if (first)
        context.addIssue({
          code: "custom",
          path,
          message: `This ref was already sent at ${first}.`,
        });
      else seen.set(canonical, path.join("."));
    };
    request.data.metrics?.forEach((metric, m) =>
      metric.data.forEach((point, p) =>
        check(point.ref, ["data", "metrics", m, "data", p, "ref"]),
      ),
    );
    request.data.workouts?.forEach((run, w) =>
      check(run.ref, ["data", "workouts", w, "ref"]),
    );
  });
export type DeviceHealthImportRequest = z.infer<
  typeof DeviceHealthImportRequest
>;
