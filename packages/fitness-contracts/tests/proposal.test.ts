import { expect, test } from "bun:test";
import { defaultSettings, settingsSchema } from "../src/domain";
import type { Settings } from "../src/domain";
import {
  planChanges,
  planningProfile,
  planProposalSchema,
  reviewPlan,
  storePlan,
  storedPlanSchema,
} from "../src/proposal";
import type { PlanProposal } from "../src/proposal";

const today = "2026-11-30";
const proposal: PlanProposal = {
  summary: "Two full-body sessions a week with dumbbells.",
  goal: "Get stronger",
  schedule: ["strength", "rest", "run", "rest", "strength", "rest", "rest"],
  dumbbellsKg: [5, 10, 15],
  routines: [
    {
      name: "Full body",
      exercises: [
        { id: "squat", sets: 3, min: 8, max: 10 },
        { id: "row", sets: 3, min: 10, max: 12, rest: 90 },
        { id: "plank", sets: 2, min: 30, max: 45 },
      ],
    },
  ],
};
let next = 0;
const ids = () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;

function current(): Settings {
  return settingsSchema.parse({
    ...defaultSettings("2026-11-02", "UTC"),
    dayPlans: {
      "2026-11-27": { type: "rest", routine: null },
      "2026-11-30": { type: "rest", routine: null },
      "2026-12-02": { type: "run", routine: null },
    },
  });
}

test("a stored plan gives each routine its own id", () => {
  const plan = storePlan(proposal, ids);
  expect(storedPlanSchema.parse(plan)).toEqual(plan);
  expect(plan.routines.map((r) => r.id)).toEqual([
    "00000000-0000-4000-8000-000000000001",
  ]);
  expect(() =>
    planProposalSchema.parse({ ...proposal, routines: [], extra: 1 }),
  ).toThrow();
});

test("reviewing a plan fills catalogue details and keeps the rest of the account", () => {
  const plan = storePlan(proposal, ids);
  const check = reviewPlan(current(), plan, today);
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  const settings = check.settings;
  expect(settings.goal).toBe("Get stronger");
  expect(settings.schedule).toEqual(proposal.schedule);
  expect(settings.dumbbellsKg).toEqual([5, 10, 15]);
  expect(settings.routines).toEqual([
    {
      id: plan.routines[0]?.id ?? "",
      name: "Full body",
      exercises: [
        {
          id: "squat",
          name: "Goblet squat",
          mode: "reps",
          side: false,
          sets: 3,
          min: 8,
          max: 10,
          rest: 120,
        },
        {
          id: "row",
          name: "Supported one-arm row",
          mode: "reps",
          side: true,
          sets: 3,
          min: 10,
          max: 12,
          rest: 90,
        },
        {
          id: "plank",
          name: "Forearm plank",
          mode: "seconds",
          side: false,
          sets: 2,
          min: 30,
          max: 45,
          rest: 75,
        },
      ],
    },
  ]);
  // Dated plans from today on would override the new week; earlier ones stay.
  expect(settings.dayPlans).toEqual({
    "2026-11-27": { type: "rest", routine: null },
  });
  const before = current();
  expect(settings.startDate).toBe(before.startDate);
  expect(settings.introductionWeeks).toBe(before.introductionWeeks);
  expect(settings.calories).toBe(before.calories);
  expect(settings.timezone).toBe(before.timezone);
});

test("a plan keeps the goal and dumbbells it leaves out", () => {
  const rest = { ...proposal, goal: undefined, dumbbellsKg: undefined };
  const base = { ...current(), dumbbellsKg: [12.5] };
  const check = reviewPlan(base, storePlan(rest, ids), today);
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  expect(check.settings.goal).toBe(base.goal);
  expect(check.settings.dumbbellsKg).toEqual([12.5]);
});

test("a plan with exercises outside the catalogue or uneven reps is refused", () => {
  const unknown = storePlan(
    {
      ...proposal,
      routines: [
        {
          name: "Gym",
          exercises: [{ id: "deadlift", sets: 3, min: 5, max: 5 }],
        },
      ],
    },
    ids,
  );
  expect(reviewPlan(current(), unknown, today)).toEqual({
    ok: false,
    errors: [
      {
        path: "routines.0.exercises.0.id",
        message: "Gym: deadlift is not in the exercise catalogue.",
      },
    ],
    warnings: [],
  });
  const fractional = storePlan(
    {
      ...proposal,
      routines: [
        {
          name: "Legs",
          exercises: [{ id: "squat", sets: 3, min: 8.5, max: 10 }],
        },
      ],
    },
    ids,
  );
  const check = reviewPlan(current(), fractional, today);
  expect(check.ok).toBe(false);
  expect(check.ok ? [] : check.errors.map((e) => e.message)).toEqual([
    "Legs: use whole numbers for the Goblet squat rep range.",
  ]);
});

test("a plan's profile is checked with it", () => {
  const plan = storePlan(
    {
      ...proposal,
      profile: { availableEquipment: ["dumbbells"], sessionMinutes: 20 },
    },
    ids,
  );
  const check = reviewPlan(current(), plan, today);
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  expect(check.settings.availableEquipment).toEqual(["dumbbells"]);
  expect(check.warnings.map((w) => w.message)).toEqual([
    "Full body: Supported one-arm row needs flat bench, which the equipment list does not include.",
  ]);
});

test("earlier dated routines the owner changed don't block a plan", () => {
  const base = current();
  const routine = base.routines[0];
  if (!routine) throw new Error("Expected a routine.");
  const edited = {
    ...routine,
    exercises: routine.exercises.map((e) =>
      e.id === "squat" ? { ...e, side: true } : e,
    ),
  };
  const withHistory = settingsSchema.parse({
    ...base,
    dayPlans: {
      ...base.dayPlans,
      "2026-11-25": { type: "strength", routine: edited },
    },
  });
  const check = reviewPlan(withHistory, storePlan(proposal, ids), today);
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  expect(check.settings.dayPlans?.["2026-11-25"]?.routine).toEqual(edited);
});

test("plan changes list each other setting a plan changes, compared as stored", () => {
  const base = { ...current(), dumbbellsKg: [8, 10] };
  const same = storePlan(
    { ...proposal, goal: base.goal, dumbbellsKg: [8, 10] },
    ids,
  );
  expect(planChanges(base, same)).toEqual([]);
  const cleared = storePlan({ ...proposal, dumbbellsKg: [] }, ids);
  expect(planChanges(base, cleared)).toEqual([
    { label: "Goal", from: base.goal, to: "Get stronger" },
    { label: "Dumbbells", from: "8, 10 kg", to: "None" },
  ]);
  // A change that rounds to the same label shows more decimals.
  const nudged = storePlan(
    { ...proposal, goal: base.goal, dumbbellsKg: [8.004, 10] },
    ids,
  );
  expect(planChanges(base, nudged)).toEqual([
    { label: "Dumbbells", from: "8, 10 kg", to: "8.004, 10 kg" },
  ]);
  const profiled = storePlan(
    {
      ...proposal,
      goal: base.goal,
      profile: {
        experience: "returning",
        sessionMinutes: 45,
        availableEquipment: ["dumbbells", "flat-bench"],
        incrementsKg: { barbell: 2.5 },
      },
    },
    ids,
  );
  expect(planChanges({ ...base, dumbbellsKg: [5, 10, 15] }, profiled)).toEqual([
    { label: "Experience", from: "Not set", to: "Returning to training" },
    { label: "Session length", from: "Not set", to: "45 min" },
    { label: "Equipment", from: "Not set", to: "Dumbbells, Flat bench" },
    {
      label: "Weight steps",
      from: "barbell default (2.5 kg), machine default (5 kg), cable default (2.5 kg)",
      to: "barbell 2.5 kg, machine default (5 kg), cable default (2.5 kg)",
    },
  ]);
});

test("each changed weight stays visible however it rounds", () => {
  const base = { ...current(), dumbbellsKg: [8, 10] };
  const plan = (dumbbellsKg: number[]) =>
    storePlan({ ...proposal, goal: base.goal, dumbbellsKg }, ids);
  // Another weight changing too doesn't hide the one that rounds the same.
  expect(planChanges(base, plan([8.004, 12]))).toEqual([
    { label: "Dumbbells", from: "8, 10 kg", to: "8.004, 12 kg" },
  ]);
  expect(planChanges(base, plan([8.00000001, 10]))).toEqual([
    { label: "Dumbbells", from: "8, 10 kg", to: "8.00000001, 10 kg" },
  ]);
  // A cleared step shows the default progression then uses.
  const steps = storePlan(
    {
      ...proposal,
      goal: base.goal,
      dumbbellsKg: [8, 10],
      profile: { incrementsKg: { barbell: 1 } },
    },
    ids,
  );
  expect(planChanges({ ...base, incrementsKg: { machine: 1 } }, steps)).toEqual(
    [
      {
        label: "Weight steps",
        from: "barbell default (2.5 kg), machine 1 kg, cable default (2.5 kg)",
        to: "barbell 1 kg, machine default (5 kg), cable default (2.5 kg)",
      },
    ],
  );
});

test("distinct weights never share a label", () => {
  const base = { ...current(), dumbbellsKg: [8, 8.004] };
  const plan = (dumbbellsKg: number[], incrementsKg?: { barbell: number }) =>
    storePlan(
      {
        ...proposal,
        goal: base.goal,
        dumbbellsKg,
        ...(incrementsKg ? { profile: { incrementsKg } } : {}),
      },
      ids,
    );
  // A weight both lists share can't hide one that is removed.
  expect(planChanges(base, plan([8.004, 8.004]))).toEqual([
    { label: "Dumbbells", from: "8, 8.004 kg", to: "8.004, 8.004 kg" },
  ]);
  expect(
    planChanges(
      { ...base, incrementsKg: { barbell: 2.5 } },
      plan(base.dumbbellsKg, { barbell: 2.500000000000001 }),
    )[0]?.to,
  ).toStartWith("barbell 2.500000000000001 kg");
  // In lb, weights that round alike show their full pound value.
  const pounds = { ...base, units: "lb" as const, dumbbellsKg: [8] };
  expect(planChanges(pounds, plan([8.000000000000002]))[0]).toMatchObject({
    from: "17.6369809744 lb",
    to: "17.636980974400004 lb",
  });
  // Weights whose pound values match exactly show their stored kg too.
  expect(
    planChanges(
      { ...pounds, dumbbellsKg: [7.5] },
      plan([7.500000000000001]),
    )[0],
  ).toMatchObject({
    from: "16.5346696635 (7.5 kg) lb",
    to: "16.5346696635 (7.500000000000001 kg) lb",
  });
  // Every weight step that stays the same shows no change.
  expect(planChanges({ ...base }, plan(base.dumbbellsKg, undefined))).toEqual(
    [],
  );
  const empty = storePlan(
    {
      ...proposal,
      goal: base.goal,
      dumbbellsKg: base.dumbbellsKg,
      profile: { incrementsKg: {} },
    },
    ids,
  );
  expect(planChanges(base, empty)).toEqual([]);
});

test("the planning profile lists the fields settings hold", () => {
  const base = current();
  expect(planningProfile(base)).toEqual([]);
  expect(
    planningProfile({
      ...base,
      experience: "returning",
      sessionMinutes: 45,
      limitations: "",
      availableEquipment: ["dumbbells", "flat-bench"],
      kettlebellsKg: [8, 12],
      incrementsKg: { machine: 1 },
    }),
  ).toEqual([
    { label: "Experience", value: "Returning to training" },
    { label: "Session length", value: "45 min" },
    { label: "Injuries and limits", value: "None" },
    { label: "Equipment", value: "Dumbbells, Flat bench" },
    { label: "Kettlebells", value: "8, 12 kg" },
    {
      label: "Weight steps",
      value: "barbell default (2.5 kg), machine 1 kg, cable default (2.5 kg)",
    },
  ]);
});
