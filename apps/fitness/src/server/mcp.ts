import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AgentError,
  addMeals,
  addSavedMeals,
  deleteEntries,
  getDay,
  getHistory,
  getPlanProposal,
  getTrainingPlan,
  listExercises,
  listSavedMeals,
  logRun,
  logWeight,
  planningProfileSaved,
  proposePlan,
  updateFoodTargets,
  updateMeal,
  updateSavedMeal,
} from "./agent";
import { nutrientInfo } from "@bent/fitness-contracts/domain";
import { planProposalSchema } from "@bent/fitness-contracts/proposal";
import { StoreRuleError } from "./store";
import type { AgentAccess } from "./auth";

const date = z.iso
  .date()
  .describe("Date as YYYY-MM-DD. Defaults to today in the account timezone.");
const id = z.string().uuid();
const revision = z
  .number()
  .int()
  .positive()
  .describe("The entry's current revision");
const requestId = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .describe(
    "A new unique ID for this change, such as a UUID. Send the same ID only when retrying the same call.",
  );
const mealInput = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .describe("What was eaten, e.g. 'Chicken burrito bowl'"),
  calories: z.number().nonnegative().max(10000).describe("Calories (kcal)"),
  protein: z.number().nonnegative().max(500).describe("Protein in grams"),
};
const grams = (label: string, max: number) =>
  z.number().nonnegative().max(max).describe(`${label} in grams`);
const mealNutrients = {
  carbs: grams("Carbohydrate", nutrientInfo.carbs.mealMax).optional(),
  fat: grams("Fat", nutrientInfo.fat.mealMax).optional(),
  fibre: grams("Fibre", nutrientInfo.fibre.mealMax).optional(),
};
/** In an update, null removes a nutrient's value. */
const nutrientChanges = {
  carbs: mealNutrients.carbs.unwrap().nullable().optional(),
  fat: mealNutrients.fat.unwrap().nullable().optional(),
  fibre: mealNutrients.fibre.unwrap().nullable().optional(),
};
const tracking = (nutrient: keyof typeof nutrientInfo) => {
  const { label, target } = nutrientInfo[nutrient];
  return z
    .object({
      track: z.boolean().describe(`Whether to track ${label.toLowerCase()}`),
      target: z
        .number()
        .min(target.min)
        .max(target.max)
        .nullable()
        .optional()
        .describe(
          `Daily target in grams, ${target.min} to ${target.max}, or null for no target. Omit to keep the current target. Leave out when track is false.`,
        ),
    })
    .optional();
};
const savedMealInput = {
  ...mealInput,
  ...mealNutrients,
  name: mealInput.name.describe("Saved meal name, e.g. 'Usual breakfast'"),
};

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const add = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const replace = { ...add, destructiveHint: true };

function reply(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** Validation and record rule messages are safe to show; other errors are not. */
function failure(error: unknown): CallToolResult {
  const safe = error instanceof AgentError || error instanceof StoreRuleError;
  if (!safe)
    console.error("fitness.mcp.tool_failed", {
      name: error instanceof Error ? error.name : typeof error,
    });
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: safe
          ? error.message
          : "Fitness could not complete this request. Try again shortly.",
      },
    ],
  };
}

function run(task: () => Promise<Record<string, unknown>>) {
  return task().then(reply, failure);
}

/** Guidance for the tools and results this connection's grant includes. */
export function instructions(access: AgentAccess) {
  const lines = [
    "Fitness holds one person's food log, bodyweight, runs and strength training.",
    "Dates are YYYY-MM-DD in the account timezone; omit the date for today.",
  ];
  if (access.read && !access.write)
    lines.push(
      "This connection can read entries. Logging, editing and removing entries need write access.",
    );
  if (access.write)
    lines.push(
      access.read
        ? "When the user describes what they ate, estimate calories and protein for each item, and grams of each nutrient in trackedNutrients from fitness_get_day, call fitness_add_meals once with every item, then tell them what you logged and the day's totals."
        : "When the user describes what they ate, estimate calories and protein for each item, and grams of carbs, fat or fibre when the user tracks them, call fitness_add_meals once with every item, then tell them what you logged.",
      access.read
        ? "When the user wants a meal kept for reuse, save it with fitness_add_saved_meals. A meal already saved with the same name, calories, protein and nutrients is not saved again."
        : "When the user wants a meal kept for reuse, save it with fitness_add_saved_meals. This connection cannot see saved meals, so each call saves every distinct meal it lists. Save each meal once.",
      access.read
        ? "Before editing or removing entries, call fitness_get_day, or fitness_list_saved_meals for saved meals, to find their IDs and revisions. Do not add a meal that is already logged for that day unless the user ate it again."
        : "This connection can change entries but not read them. Edit or remove only entries this connection saved, using the IDs and revisions from their receipts. Report what each call saved.",
      "Weights are stored in kilograms; pass the unit the user gave.",
    );
  if (access.targets)
    lines.push(
      "Use fitness_update_food_targets when the user wants to change their calorie or protein target, or start or stop tracking carbs, fat or fibre and set their daily targets.",
    );
  if (access.plan)
    lines.push(
      "To set up or change the user's training, ask about their goal, training experience, the days a week and minutes a session they have, the equipment they can use and any injuries or movements to avoid. Then call fitness_get_training_plan and fitness_list_exercises, build a plan from catalogue exercises that fit their equipment and time, and call fitness_propose_plan.",
      "A proposal changes nothing until the user accepts it in Fitness. Tell them what the plan contains and any warnings it returned, and give them the review link.",
    );
  if (access.write || access.targets || access.plan)
    lines.push(
      "Give every change a new requestId. Reuse a requestId only to retry the same call after a failed connection.",
    );
  return lines.join(" ");
}

/** Registers the read tools and write tools the connection's grant allows. */
export function createFitnessMcpServer(owner: string, access: AgentAccess) {
  const server = new McpServer(
    { name: "bent-fitness", version: "1.0.0" },
    {
      instructions: instructions(access),
    },
  );

  if (access.read) {
    server.registerTool(
      "fitness_get_day",
      {
        title: "Get a day",
        description:
          "Returns one day's meals with IDs, totals of calories, protein and each tracked nutrient against targets, bodyweight, planned training, workouts and runs. trackedNutrients lists the nutrients the user tracks besides calories and protein; recordedIn counts the meals that recorded each one.",
        inputSchema: { date: date.optional() },
        annotations: read,
      },
      (input) => run(() => getDay(owner, input)),
    );

    server.registerTool(
      "fitness_get_history",
      {
        title: "Get history",
        description:
          "Summarises each day in a date range of up to 62 days: calories, protein, each tracked nutrient, meal count, bodyweight, workouts and runs.",
        inputSchema: {
          from: z.iso.date().describe("First date, YYYY-MM-DD"),
          to: date.optional(),
        },
        annotations: read,
      },
      (input) => run(() => getHistory(owner, input)),
    );

    server.registerTool(
      "fitness_list_saved_meals",
      {
        title: "List saved meals",
        description:
          "Lists the user's saved meals with their IDs, revisions, calories, protein and any recorded carbs, fat and fibre. Use these values when the user mentions one of them.",
        inputSchema: {},
        annotations: read,
      },
      () => run(() => listSavedMeals(owner)),
    );
  }

  if (access.write) {
    server.registerTool(
      "fitness_add_meals",
      {
        title: "Add meals",
        description:
          "Logs one or more food entries to a day in a single change. Returns the new entries, and with read access the day's updated totals.",
        inputSchema: {
          requestId,
          date: date.optional(),
          meals: z
            .array(z.object({ ...mealInput, ...mealNutrients }))
            .min(1)
            .max(30),
        },
        annotations: add,
      },
      (input) => run(() => addMeals(owner, access, input)),
    );

    server.registerTool(
      "fitness_update_meal",
      {
        title: "Update a meal",
        description:
          "Changes a logged food entry's name, calories, protein, carbs, fat, fibre or date. Omitted fields keep their current values, and a null nutrient removes its value. Fails if the entry changed after it was read.",
        inputSchema: {
          requestId,
          id: id.describe("Meal ID"),
          revision,
          name: mealInput.name.optional(),
          calories: mealInput.calories.optional(),
          protein: mealInput.protein.optional(),
          ...nutrientChanges,
          date: z.iso.date().optional().describe("Move the entry to this date"),
        },
        annotations: { ...replace, idempotentHint: true },
      },
      (input) => run(() => updateMeal(owner, access, input)),
    );

    server.registerTool(
      "fitness_delete_entries",
      {
        title: "Delete entries",
        description:
          "Removes meals, saved meals, runs or weigh-ins in a single change. Fails without removing anything if an entry changed after it was read. Strength workouts are managed in the app.",
        inputSchema: {
          requestId,
          entries: z
            .array(z.object({ id, revision }))
            .min(1)
            .max(30)
            .describe("Entry IDs and their current revisions"),
        },
        annotations: { ...replace, idempotentHint: true },
      },
      (input) => run(() => deleteEntries(owner, access, input)),
    );

    server.registerTool(
      "fitness_add_saved_meals",
      {
        title: "Add saved meals",
        description: access.read
          ? "Saves one or more meals with their calories, protein and nutrients, ready to log in one tap from the app's Food section. Skips a meal already saved with the same name, calories, protein and nutrients. To record food eaten on a day, use fitness_add_meals."
          : "Saves one or more meals with their calories, protein and nutrients, ready to log in one tap from the app's Food section. Saves each distinct meal in the request once. To record food eaten on a day, use fitness_add_meals.",
        inputSchema: {
          requestId,
          savedMeals: z.array(z.object(savedMealInput)).min(1).max(30),
        },
        annotations: add,
      },
      (input) => run(() => addSavedMeals(owner, access, input)),
    );

    server.registerTool(
      "fitness_update_saved_meal",
      {
        title: "Update a saved meal",
        description:
          "Changes a saved meal's name, calories, protein, carbs, fat or fibre. Omitted fields keep their current values, and a null nutrient removes its value. Meals already logged keep their values. Fails if the saved meal changed after it was read.",
        inputSchema: {
          requestId,
          id: id.describe("Saved meal ID"),
          revision,
          name: savedMealInput.name.optional(),
          calories: mealInput.calories.optional(),
          protein: mealInput.protein.optional(),
          ...nutrientChanges,
        },
        annotations: { ...replace, idempotentHint: true },
      },
      (input) => run(() => updateSavedMeal(owner, access, input)),
    );

    server.registerTool(
      "fitness_log_weight",
      {
        title: "Log bodyweight",
        description:
          "Records bodyweight for a day. A day keeps one weigh-in, so this replaces any existing value for that date.",
        inputSchema: {
          requestId,
          date: date.optional(),
          weight: z.number().positive(),
          unit: z
            .enum(["kg", "lb"])
            .optional()
            .describe("Defaults to the account's units"),
        },
        annotations: { ...replace, idempotentHint: true },
      },
      (input) => run(() => logWeight(owner, access, input)),
    );

    server.registerTool(
      "fitness_log_run",
      {
        title: "Log a run",
        description: "Records a completed run on today or an earlier date.",
        inputSchema: {
          requestId,
          date: date.optional(),
          minutes: z.number().positive().max(1440),
          distanceKm: z.number().nonnegative().max(500),
          notes: z.string().max(2000).optional(),
        },
        annotations: add,
      },
      (input) => run(() => logRun(owner, access, input)),
    );
  }

  if (access.targets) {
    server.registerTool(
      "fitness_update_food_targets",
      {
        title: "Update food targets",
        description:
          "Changes the daily calorie and protein targets, and which of carbs, fat and fibre the user tracks with their daily targets. Omitted values keep their current settings. Tracked nutrients show on the Food screen and in day totals.",
        inputSchema: {
          requestId,
          calories: z
            .number()
            .int()
            .min(800)
            .max(10000)
            .optional()
            .describe("Daily calorie target (kcal)"),
          protein: z
            .number()
            .min(20)
            .max(400)
            .optional()
            .describe("Daily protein target in grams"),
          nutrients: z
            .object({
              carbs: tracking("carbs"),
              fat: tracking("fat"),
              fibre: tracking("fibre"),
            })
            .optional(),
        },
        annotations: { ...replace, idempotentHint: true },
      },
      (input) => run(() => updateFoodTargets(owner, access, input)),
    );
  }

  if (access.plan) {
    server.registerTool(
      "fitness_list_exercises",
      {
        title: "List exercises",
        description:
          "Lists the exercises a plan can use, with the equipment each needs, how its load is measured, its movement pattern, muscles, level, whether it is timed or done for each side, and its starting sets, range and rest. Also lists the equipment types an account can have.",
        inputSchema: {},
        annotations: read,
      },
      () => run(async () => listExercises()),
    );

    server.registerTool(
      "fitness_get_training_plan",
      {
        title: "Get the training plan",
        description:
          "Returns the user's goal, repeating week from Monday, routines with their exercises, dumbbell weights, planning profile and any plan proposal waiting for review. profileSaved says whether fitness_propose_plan accepts a planning profile.",
        inputSchema: {},
        annotations: read,
      },
      () => run(() => getTrainingPlan(owner)),
    );

    // Strict, so a field this connection isn't offered fails the call
    // instead of being dropped. The planning profile is offered once Fitness
    // can save it.
    const proposalInput = planProposalSchema.extend({ requestId }).strict();
    server.registerTool(
      "fitness_propose_plan",
      {
        title: "Propose a training plan",
        description:
          "Proposes a new repeating week and routines for the user to review and accept in Fitness. Each exercise names a catalogue id from fitness_list_exercises with its sets, rep range or seconds for timed exercises, and rest. Accepting the proposal replaces the routines, the repeating week and planned sessions from that day on; workouts already recorded keep their results. goal and dumbbellsKg replace the current values; leave them out to keep them. A new proposal replaces one still waiting. Fails with every problem listed when the plan doesn't fit; warnings describe choices to confirm with the user.",
        inputSchema: planningProfileSaved()
          ? proposalInput
          : proposalInput.omit({ profile: true }),
        annotations: add,
      },
      (input) => run(() => proposePlan(owner, access, input)),
    );

    server.registerTool(
      "fitness_get_plan_proposal",
      {
        title: "Get a plan proposal",
        description:
          "Returns whether a plan proposal is pending, accepted, dismissed or replaced by a newer one.",
        inputSchema: { id: id.describe("Proposal ID") },
        annotations: read,
      },
      (input) => run(() => getPlanProposal(owner, input)),
    );

    server.registerPrompt(
      "set_up_training",
      {
        title: "Set up my training",
        description:
          "Interview me about my goals, time and equipment, then propose a training plan in Fitness.",
      },
      () => ({
        messages: [
          { role: "user", content: { type: "text", text: setUpTraining } },
        ],
      }),
    );
  }

  return server;
}

/** The interview the set_up_training prompt starts. */
export const setUpTraining = [
  "Help me set up my strength training in Fitness.",
  "First call fitness_get_training_plan to see my current plan. If plan is null, ask me to open Fitness, choose Set up my plan and tell you once it has saved, then call it again.",
  "Then ask me, one or two questions at a time:",
  "- what I want from training, such as strength, muscle, fitness or general health",
  "- how much training I've done before",
  "- how many days a week I can train and how long each session can be",
  "- what equipment I can use, including dumbbell weights",
  "- any injuries, conditions or movements to avoid",
  "Then call fitness_list_exercises and build a plan from catalogue exercises that suit my answers and equipment.",
  "Show me the plan and explain it briefly. When I'm happy with it, call fitness_propose_plan and give me the link to review and accept it in Fitness.",
].join("\n");
