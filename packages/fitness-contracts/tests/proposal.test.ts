import { expect, test } from "bun:test";
import { defaultSettings, settingsSchema } from "../src/domain";
import type { Settings } from "../src/domain";
import {
  planChanges,
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
      from: "barbell None, machine None, cable None",
      to: "barbell 2.5 kg, machine None, cable None",
    },
  ]);
});
