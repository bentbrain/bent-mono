/**
 * Checks a complete training plan, such as one an assistant proposes or one
 * pasted into the app, before it replaces the account's settings. Errors
 * stop the plan; warnings describe choices worth confirming with the owner.
 */
import { catalogueEntry, equipmentNames, missingEquipment } from "./catalogue";
import { sessionMinutes, settingsSchema } from "./domain";
import type { Exercise, Routine, Settings } from "./domain";

export type PlanIssue = { path: string; message: string };
export type PlanCheck =
  | { ok: true; settings: Settings; warnings: PlanIssue[] }
  | { ok: false; errors: PlanIssue[]; warnings: PlanIssue[] };

const pathText = (path: readonly PropertyKey[]) =>
  path.map((part) => String(part)).join(".");

/** A custom exercise an account defines, by id, with the load it records. */
export type KnownExercise = Pick<Exercise, "id" | "mode" | "side"> & {
  load?: Exercise["load"];
};

/**
 * Validates `candidate` as settings and checks its routines against the
 * catalogue, the account's equipment and its session length. `custom` lists
 * exercises the account defines outside the catalogue.
 */
export function checkPlan(
  candidate: unknown,
  custom: readonly KnownExercise[] = [],
): PlanCheck {
  const parsed = settingsSchema.safeParse(candidate);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: pathText(issue.path),
        message: issue.message,
      })),
      warnings: [],
    };
  const settings = parsed.data;
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const customById = new Map(custom.map((item) => [item.id, item]));
  const routineIds = new Set<string>();

  const checkRoutine = (routine: Routine, at: string) => {
    const seen = new Set<string>();
    routine.exercises.forEach((exercise, e) => {
      const here = `${at}.exercises.${e}`;
      if (seen.has(exercise.id))
        warnings.push({
          path: `${here}.id`,
          message: `${routine.name}: ${exercise.name} appears more than once.`,
        });
      seen.add(exercise.id);
      const entry = catalogueEntry(exercise.id);
      const defined = entry ? undefined : customById.get(exercise.id);
      const known = entry ?? defined;
      if (!known) {
        errors.push({
          path: `${here}.id`,
          message: `${routine.name}: ${exercise.id} is not in the exercise catalogue.`,
        });
        return;
      }
      if (known.mode !== exercise.mode || known.side !== exercise.side)
        errors.push({
          path: here,
          message: `${routine.name}: record ${exercise.name} ${describe(known)}.`,
        });
      if (
        exercise.mode === "reps" &&
        !(Number.isInteger(exercise.min) && Number.isInteger(exercise.max))
      )
        errors.push({
          path: here,
          message: `${routine.name}: use whole numbers for the ${exercise.name} rep range.`,
        });
      // Catalogue exercises take their load type from the catalogue; others
      // name the load type the account defined for them.
      if (entry && exercise.load !== undefined)
        errors.push({
          path: `${here}.load`,
          message: `${routine.name}: leave out the load type for ${exercise.name}; the catalogue sets it.`,
        });
      if (
        defined &&
        (exercise.load ?? "dumbbell") !== (defined.load ?? "dumbbell")
      )
        errors.push({
          path: `${here}.load`,
          message: `${routine.name}: ${exercise.name} records ${defined.load ?? "dumbbell"} load.`,
        });
      if (entry && settings.availableEquipment) {
        const missing = missingEquipment(entry, settings.availableEquipment);
        if (missing.length)
          warnings.push({
            path: here,
            message: `${routine.name}: ${exercise.name} needs ${missing
              .map((item) => equipmentNames[item].toLowerCase())
              .join(", ")}, which the equipment list does not include.`,
          });
      }
    });
    if (settings.sessionMinutes !== undefined) {
      const minutes = sessionMinutes(routine, false);
      if (minutes > settings.sessionMinutes + 10)
        warnings.push({
          path: at,
          message: `${routine.name} takes about ${minutes} minutes, longer than the ${settings.sessionMinutes} available.`,
        });
    }
  };

  settings.routines.forEach((routine, r) => {
    const at = `routines.${r}`;
    if (routineIds.has(routine.id))
      errors.push({
        path: `${at}.id`,
        message: `${routine.name}: give each routine its own id.`,
      });
    routineIds.add(routine.id);
    checkRoutine(routine, at);
  });
  for (const [date, plan] of Object.entries(settings.dayPlans ?? {}))
    if (plan.routine) checkRoutine(plan.routine, `dayPlans.${date}.routine`);

  const strengthDays = settings.schedule.filter(
    (day) => day === "strength",
  ).length;
  if (strengthDays === 0)
    warnings.push({
      path: "schedule",
      message: "The repeating week has no strength days.",
    });
  else if (settings.routines.length > strengthDays * 2)
    warnings.push({
      path: "routines",
      message: `${settings.routines.length} routines take turns over ${strengthDays} strength ${strengthDays === 1 ? "day" : "days"} a week, so each comes round less than once a fortnight.`,
    });

  return errors.length
    ? { ok: false, errors, warnings }
    : { ok: true, settings, warnings };
}

function describe(exercise: Pick<Exercise, "mode" | "side">) {
  const unit = exercise.mode === "seconds" ? "seconds" : "reps";
  return exercise.side ? `in ${unit} for each side` : `in ${unit}`;
}
