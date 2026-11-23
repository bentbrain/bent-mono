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
  listSavedMeals,
  logRun,
  logWeight,
  updateMeal,
  updateSavedMeal,
} from "./agent";
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
const savedMealInput = {
  ...mealInput,
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
        ? "When the user describes what they ate, estimate calories and protein for each item, call fitness_add_meals once with every item, then tell them what you logged and the day's totals."
        : "When the user describes what they ate, estimate calories and protein for each item, call fitness_add_meals once with every item, then tell them what you logged.",
      access.read
        ? "When the user wants a meal kept for reuse, save it with fitness_add_saved_meals. A meal already saved with the same name, calories and protein is not saved again."
        : "When the user wants a meal kept for reuse, save it with fitness_add_saved_meals. This connection cannot see saved meals, so each call saves every distinct meal it lists. Save each meal once.",
      access.read
        ? "Before editing or removing entries, call fitness_get_day, or fitness_list_saved_meals for saved meals, to find their IDs and revisions. Do not add a meal that is already logged for that day unless the user ate it again."
        : "This connection can change entries but not read them. Edit or remove only entries this connection saved, using the IDs and revisions from their receipts. Report what each call saved.",
      "Give every change a new requestId. Reuse a requestId only to retry the same call after a failed connection.",
      "Weights are stored in kilograms; pass the unit the user gave.",
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
          "Returns one day's meals with IDs, calorie and protein totals against targets, bodyweight, planned training, workouts and runs.",
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
          "Summarises each day in a date range of up to 62 days: calories, protein, meal count, bodyweight, workouts and runs.",
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
          "Lists the user's saved meals with their IDs, revisions, calories and protein. Use these values when the user mentions one of them.",
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
          meals: z.array(z.object(mealInput)).min(1).max(30),
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
          "Changes a logged food entry's name, calories, protein or date. Omitted fields keep their current values. Fails if the entry changed after it was read.",
        inputSchema: {
          requestId,
          id: id.describe("Meal ID"),
          revision,
          name: mealInput.name.optional(),
          calories: mealInput.calories.optional(),
          protein: mealInput.protein.optional(),
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
          ? "Saves one or more meals with their calories and protein, ready to log in one tap from the app's Food section. Skips a meal already saved with the same name, calories and protein. To record food eaten on a day, use fitness_add_meals."
          : "Saves one or more meals with their calories and protein, ready to log in one tap from the app's Food section. Saves each distinct meal in the request once. To record food eaten on a day, use fitness_add_meals.",
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
          "Changes a saved meal's name, calories or protein. Omitted fields keep their current values. Meals already logged keep their values. Fails if the saved meal changed after it was read.",
        inputSchema: {
          requestId,
          id: id.describe("Saved meal ID"),
          revision,
          name: savedMealInput.name.optional(),
          calories: mealInput.calories.optional(),
          protein: mealInput.protein.optional(),
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

  return server;
}
