/**
 * Plan proposals: a training plan an assistant suggests and the owner
 * accepts in the app. A proposal names catalogue exercises by id with their
 * sets, ranges and rest. Accepting it replaces the repeating week, the
 * routines and the dated plans from that day on; earlier dated plans, the
 * plan start date and the food settings stay as they are.
 */
import { z } from "zod";
import { catalogueEntry, equipmentNames } from "./catalogue";
import { defaultIncrementsKg, displayLoad, settingsSchema } from "./domain";
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

const experienceNames = {
  new: "New to training",
  returning: "Returning to training",
  experienced: "Experienced",
} as const;

export type PlanChange = { label: string; from: string; to: string };

/**
 * Labels for every weight in `values` in the account's units. Weights get
 * the rounded text the app shows, except that distinct weights never share
 * a label: those that would get the full value in the account's units, and
 * in lb also their stored kg when even that matches.
 */
function weightLabels(values: readonly number[], units: Settings["units"]) {
  const distinct = [...new Set(values)];
  const unique = (label: (kg: number) => string) => {
    const counts = new Map<string, number>();
    for (const kg of distinct)
      counts.set(label(kg), (counts.get(label(kg)) ?? 0) + 1);
    return (kg: number) => counts.get(label(kg)) === 1;
  };
  const shown = (kg: number) => String(displayLoad(kg, units));
  const full = (kg: number) => String(units === "lb" ? kg * 2.2046226218 : kg);
  const shownUnique = unique(shown);
  const fullUnique = unique(full);
  return new Map(
    distinct.map((kg) => [
      kg,
      shownUnique(kg)
        ? shown(kg)
        : fullUnique(kg)
          ? full(kg)
          : `${full(kg)} (${String(kg)} kg)`,
    ]),
  );
}

/** Two weight lists as the owner reads them, with every change visible. */
function weightTexts(
  from: readonly number[] | undefined,
  to: readonly number[] | undefined,
  units: Settings["units"],
) {
  const labels = weightLabels([...(from ?? []), ...(to ?? [])], units);
  const text = (values: readonly number[] | undefined) =>
    values?.length
      ? values.map((kg) => labels.get(kg)).join(", ") + ` ${units}`
      : "None";
  return [text(from), text(to)] as const;
}

const sameValues = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Every setting besides the week and routines that accepting `plan` changes
 * on `current`, as it reads now and after, so the owner sees each change
 * before accepting it. Values are compared as stored, not as displayed.
 */
export function planChanges(current: Settings, plan: StoredPlan): PlanChange[] {
  const units = current.units;
  const profile = plan.profile ?? {};
  const changes: PlanChange[] = [];
  const add = (label: string, from: string, to: string) =>
    changes.push({ label, from, to });
  if (plan.goal !== undefined && plan.goal !== current.goal)
    add("Goal", current.goal, plan.goal);
  const weights = (
    label: string,
    from: number[] | undefined,
    to: number[] | undefined,
  ) => {
    if (to === undefined || sameValues(from ?? [], to)) return;
    const [before, after] = weightTexts(from, to, units);
    add(label, before, after);
  };
  weights("Dumbbells", current.dumbbellsKg, plan.dumbbellsKg);
  if (
    profile.experience !== undefined &&
    profile.experience !== current.experience
  )
    add(
      "Experience",
      current.experience ? experienceNames[current.experience] : "Not set",
      experienceNames[profile.experience],
    );
  if (
    profile.sessionMinutes !== undefined &&
    profile.sessionMinutes !== current.sessionMinutes
  )
    add(
      "Session length",
      current.sessionMinutes ? `${current.sessionMinutes} min` : "Not set",
      `${profile.sessionMinutes} min`,
    );
  if (
    profile.limitations !== undefined &&
    profile.limitations !== current.limitations
  )
    add(
      "Injuries and limits",
      current.limitations || "None",
      profile.limitations || "None",
    );
  if (
    profile.availableEquipment !== undefined &&
    !sameValues(current.availableEquipment, profile.availableEquipment)
  ) {
    const names = (items: Settings["availableEquipment"]) =>
      items?.length
        ? items.map((item) => equipmentNames[item]).join(", ")
        : "None";
    add(
      "Equipment",
      current.availableEquipment
        ? names(current.availableEquipment)
        : "Not set",
      names(profile.availableEquipment),
    );
  }
  weights("Kettlebells", current.kettlebellsKg, profile.kettlebellsKg);
  if (
    profile.incrementsKg !== undefined &&
    (["barbell", "machine", "cable"] as const).some(
      (kind) => current.incrementsKg?.[kind] !== profile.incrementsKg?.[kind],
    )
  ) {
    // A kind without its own step uses the step progression defaults to.
    const before = current.incrementsKg ?? {};
    const after = profile.incrementsKg;
    const texts = (["barbell", "machine", "cable"] as const).map((kind) => {
      const from = before[kind] ?? defaultIncrementsKg[kind];
      const to = after[kind] ?? defaultIncrementsKg[kind];
      const [fromText, toText] = weightTexts([from], [to], units);
      const label = (own: number | undefined, text: string) =>
        own === undefined ? `${kind} default (${text})` : `${kind} ${text}`;
      return [label(before[kind], fromText), label(after[kind], toText)];
    });
    add(
      "Weight steps",
      texts.map(([from]) => from).join(", "),
      texts.map(([, to]) => to).join(", "),
    );
  }
  return changes;
}
