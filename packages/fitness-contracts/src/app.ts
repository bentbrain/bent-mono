/**
 * The Fitness app API under `/api/app`, used by the bent Fitness iPhone app
 * with OAuth access tokens issued to its own client.
 */
import { z } from "zod";
import { nutrients, recordSchema } from "./domain";
import type { Entity, Exercise, Routine } from "./domain";

/**
 * The `/api/app` contract a client understands, sent in the
 * `X-Fitness-Contract` header. Builds without the header count as 1.
 *
 * - 1: the original settings, routines and records. Weights are per dumbbell.
 * - 2: carbs, fat and fibre on meals and saved meals, and the nutrients
 *   settings track.
 * - 3: load types on exercises outside the catalogue and the planning profile
 *   in settings.
 *
 * A build declares a contract only once its screens show and keep every
 * field it adds, since Fitness serves those records to any build that
 * declares it. A build declaring 3 declares everything 2 adds.
 */
export const appContract = 2;
export const appContractHeader = "X-Fitness-Contract";
/** The contract a request declares, or 1 when it names none or an invalid one. */
export function requestContract(value: string | null) {
  const contract = Number(value);
  return value !== null && Number.isSafeInteger(contract) && contract > 0
    ? contract
    : 1;
}

/** Settings fields that contract 3 added. */
const contractThreeSettings = [
  "experience",
  "sessionMinutes",
  "limitations",
  "availableEquipment",
  "kettlebellsKg",
  "incrementsKg",
] as const;
const hasLoad = (exercise: Exercise) => exercise.load !== undefined;
const routineHasLoad = (routine: Routine | null | undefined) =>
  routine?.exercises.some(hasLoad) ?? false;
/** The oldest contract that can read `data`. */
export function requiredContract(data: Entity): number {
  if (data.kind === "settings") {
    const three =
      contractThreeSettings.some((key) => data[key] !== undefined) ||
      data.routines.some(routineHasLoad) ||
      Object.values(data.dayPlans ?? {}).some((plan) =>
        routineHasLoad(plan.routine),
      );
    if (three) return 3;
    return data.nutrients === undefined ? 1 : 2;
  }
  if (data.kind === "meal" || data.kind === "regular")
    return nutrients.some((nutrient) => data[nutrient] !== undefined) ? 2 : 1;
  const workout =
    data.kind === "workout"
      ? data
      : data.kind === "workoutCorrection"
        ? data.replacement
        : null;
  return workout?.exercises.some((item) => hasLoad(item.prescription)) ? 3 : 1;
}

export const photoTypes = ["image/jpeg", "image/png", "image/webp"] as const;

/** `POST /api/app/photos`: a JPEG, PNG or WebP photo of up to 2 MB. */
export const PhotoUpload = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(160),
    type: z.enum(photoTypes),
    base64: z
      .string()
      .max(2796204)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
export type PhotoUpload = z.infer<typeof PhotoUpload>;

export const PhotoSummary = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(photoTypes),
});
export type PhotoSummary = z.infer<typeof PhotoSummary>;

/** `GET /api/app/photos`. */
export const PhotoList = z.object({ photos: z.array(PhotoSummary) });

/** `GET /api/app/records`: every record the account holds. */
export const AppRecords = z.object({
  owner: z.string(),
  records: z.array(recordSchema),
  /**
   * The newest records contract Fitness stores, so a build offers only
   * fields Fitness can save. Fitness releases before contract 2 leave it
   * out, which means 1.
   */
  contract: z.number().int().positive().optional(),
});
export type AppRecords = z.infer<typeof AppRecords>;
