/**
 * Plan proposals: a training plan an assistant suggests and the owner
 * accepts in the app. A proposal names catalogue exercises by id with their
 * sets, ranges and rest. Accepting it replaces the repeating week, the
 * routines and the dated plans from that day on; earlier dated plans, the
 * plan start date and the food settings stay as they are.
 */
import { z } from "zod";
import { catalogueEntry } from "./catalogue";
import { settingsSchema } from "./domain";
import type { Settings } from "./domain";
import { checkPlan } from "./plan";
import type { PlanCheck } from "./plan";

const label = z.string().trim().min(1).max(160);

export const proposedExerciseSchema = z
  .object({
    id: label.describe("Catalogue exercise id"),
    sets: z.number().int().min(1).max(8),
    min: z
      .number()
      .positive()
      .max(600)
      .describe("Fewest reps, or seconds for a timed exercise"),
    max: z
      .number()
      .positive()
      .max(600)
      .describe("Most reps, or seconds for a timed exercise"),
    rest: z
      .number()
      .int()
      .min(15)
      .max(600)
      .optional()
      .describe("Rest between sets in seconds. Defaults to the catalogue's."),
  })
  .strict();
export type ProposedExercise = z.infer<typeof proposedExerciseSchema>;

const proposedRoutine = {
  name: label.describe("Routine name, e.g. 'Lower body'"),
  exercises: z.array(proposedExerciseSchema).min(1).max(15),
};
export const proposedRoutineSchema = z.object(proposedRoutine).strict();

/** The planning profile fields a proposal can set. */
export const planProfileSchema = settingsSchema
  .pick({
    experience: true,
    sessionMinutes: true,
    limitations: true,
    availableEquipment: true,
    kettlebellsKg: true,
    incrementsKg: true,
  })
  .strict();
export type PlanProfile = z.infer<typeof planProfileSchema>;

const proposalFields = {
  summary: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      "Why this plan suits the owner, in a few sentences. The app shows it with the plan.",
    ),
  goal: label.optional().describe("The training goal in the owner's words"),
  schedule: settingsSchema.shape.schedule.describe(
    "The repeating week from Monday to Sunday",
  ),
  dumbbellsKg: settingsSchema.shape.dumbbellsKg
    .optional()
    .describe("Each dumbbell weight available, in kg"),
  profile: planProfileSchema.optional(),
};

/** A plan as an assistant proposes it. */
export const planProposalSchema = z
  .object({
    ...proposalFields,
    routines: z.array(proposedRoutineSchema).min(1).max(8),
  })
  .strict();
export type PlanProposal = z.infer<typeof planProposalSchema>;

/** A proposal as Fitness keeps it, with an id for each routine. */
export const storedPlanSchema = z
  .object({
    ...proposalFields,
    routines: z
      .array(z.object({ ...proposedRoutine, id: z.uuid() }).strict())
      .min(1)
      .max(8),
  })
  .strict();
export type StoredPlan = z.infer<typeof storedPlanSchema>;

export const proposalStatuses = [
  "pending",
  "accepted",
  "dismissed",
  "replaced",
] as const;
export type ProposalStatus = (typeof proposalStatuses)[number];

export const planProposalRecordSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(proposalStatuses),
    createdAt: z.iso.datetime({ offset: true }),
    decidedAt: z.iso.datetime({ offset: true }).nullable(),
    plan: storedPlanSchema,
  })
  .strict();
export type PlanProposalRecord = z.infer<typeof planProposalRecordSchema>;

/** Gives each proposed routine a new id. */
export function storePlan(
  proposal: PlanProposal,
  newId: () => string = () => crypto.randomUUID(),
): StoredPlan {
  return storedPlanSchema.parse({
    ...proposal,
    routines: proposal.routines.map((routine) => ({ ...routine, id: newId() })),
  });
}

/**
 * The settings `plan` produces from `current` on `today`. The proposed
 * routines and week get the full plan checks, and the result must be valid
 * settings. Exercises take their name, mode and sides from the catalogue.
 */
export function reviewPlan(
  current: Settings,
  plan: StoredPlan,
  today: string,
): PlanCheck {
  const errors: PlanCheck["warnings"] = [];
  const routines = plan.routines.map((routine, r) => ({
    id: routine.id,
    name: routine.name,
    exercises: routine.exercises.flatMap((exercise, e) => {
      const entry = catalogueEntry(exercise.id);
      if (!entry) {
        errors.push({
          path: `routines.${r}.exercises.${e}.id`,
          message: `${routine.name}: ${exercise.id} is not in the exercise catalogue.`,
        });
        return [];
      }
      return [
        {
          id: entry.id,
          name: entry.name,
          mode: entry.mode,
          side: entry.side,
          sets: exercise.sets,
          min: exercise.min,
          max: exercise.max,
          rest: exercise.rest ?? entry.rest,
        },
      ];
    }),
  }));
  if (errors.length) return { ok: false, errors, warnings: [] };
  // The plan's own routines get the full plan checks. Earlier dated plans
  // stay as the owner recorded them and only need to remain valid settings.
  const check = checkPlan({
    ...current,
    ...plan.profile,
    ...(plan.goal === undefined ? {} : { goal: plan.goal }),
    ...(plan.dumbbellsKg === undefined
      ? {}
      : { dumbbellsKg: plan.dumbbellsKg }),
    schedule: plan.schedule,
    routines,
    dayPlans: {},
  });
  if (!check.ok) return check;
  const merged = settingsSchema.safeParse({
    ...check.settings,
    dayPlans: Object.fromEntries(
      Object.entries(current.dayPlans ?? {}).filter(([date]) => date < today),
    ),
  });
  if (!merged.success)
    return {
      ok: false,
      errors: merged.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
      warnings: check.warnings,
    };
  return { ok: true, settings: merged.data, warnings: check.warnings };
}
