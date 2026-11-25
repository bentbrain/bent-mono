/** Replies from `POST /api/health/import`, by the kind of key that sent it. */
import { z } from "zod";

const count = z.number().int().nonnegative();

/** Keys with `fitness:read` access, or without scopes: one outcome per date and run. */
export const LegacyOutcomeReply = z.object({
  added: z.object({ weights: count, runs: count }),
  weights: z.array(
    z.object({
      date: z.string(),
      status: z.enum(["added", "kept"]),
      reason: z.string().optional(),
    }),
  ),
  runs: z.array(
    z.object({
      date: z.string(),
      start: z.string(),
      status: z.enum(["added", "kept"]),
      reason: z.string().optional(),
    }),
  ),
  skipped: z.array(
    z.object({
      type: z.enum(["weight", "run"]),
      date: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  ignored: z.object({ metrics: count, workouts: count }),
});

/** Write-only keys: the weigh-ins and running workouts their payload held. */
export const ReceivedReply = z.object({
  received: z.object({ weights: count, runs: count }),
});

/** Codes for a sample that became a new entry. */
export const addedCodes = ["new"] as const;
/** Codes for a sample Fitness already has, or that matched an entry. */
export const keptCodes = [
  "already_imported",
  "matched_existing",
  "removed_in_fitness",
  "date_has_weighin",
  "duplicate_in_request",
] as const;
/** Codes for a sample Fitness cannot record. */
export const skippedCodes = ["future", "out_of_range"] as const;
export const outcomeCodes = [
  ...addedCodes,
  ...keptCodes,
  ...skippedCodes,
] as const;
export type OutcomeCode = (typeof outcomeCodes)[number];

const outcome = {
  ref: z.string(),
  type: z.enum(["weight", "run"]),
};
/** One sample's outcome. Each submitted ref gets exactly one. */
export const DeviceOutcome = z.discriminatedUnion("result", [
  z.object({
    ...outcome,
    result: z.literal("added"),
    code: z.enum(addedCodes),
  }),
  z.object({ ...outcome, result: z.literal("kept"), code: z.enum(keptCodes) }),
  z.object({
    ...outcome,
    result: z.literal("skipped"),
    code: z.enum(skippedCodes),
  }),
]);
export type DeviceOutcome = z.infer<typeof DeviceOutcome>;

/** Import-only device keys: an outcome for each ref the request sent. */
export const DeviceReply = z.object({
  kind: z.literal("device"),
  accountTimezone: z.string(),
  outcomes: z.array(DeviceOutcome),
});
export type DeviceReply = z.infer<typeof DeviceReply>;

export const HealthImportReply = z.union([
  DeviceReply,
  ReceivedReply,
  LegacyOutcomeReply,
]);
export type HealthImportReply = z.infer<typeof HealthImportReply>;
