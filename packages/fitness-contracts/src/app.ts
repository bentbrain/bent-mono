/**
 * The Fitness app API under `/api/app`, used by the bent Fitness iPhone app
 * with OAuth access tokens issued to its own client.
 */
import { z } from "zod";
import { recordSchema } from "./domain";
import type { Entity, Exercise, Routine } from "./domain";

/**
 * The `/api/app` contract a client understands, sent in the
 * `X-Fitness-Contract` header. Builds without the header count as 1.
 *
 * - 1: the original settings, routines and records.
 * - 2: catalogue load types on exercises and the planning profile in settings.
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

/** Settings fields that contract 2 added. */
const contractTwoSettings = [
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
    const two =
      contractTwoSettings.some((key) => data[key] !== undefined) ||
      data.routines.some(routineHasLoad) ||
      Object.values(data.dayPlans ?? {}).some((plan) =>
        routineHasLoad(plan.routine),
      );
    return two ? 2 : 1;
  }
  const workout =
    data.kind === "workout"
      ? data
      : data.kind === "workoutCorrection"
        ? data.replacement
        : null;
  return workout?.exercises.some((item) => hasLoad(item.prescription)) ? 2 : 1;
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
});
export type AppRecords = z.infer<typeof AppRecords>;
