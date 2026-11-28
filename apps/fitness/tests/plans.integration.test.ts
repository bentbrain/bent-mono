import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { database } from "../src/server/db";
import type { AgentAccess } from "../src/server/auth";
import { createFitnessMcpServer, setUpTraining } from "../src/server/mcp";
import { advertisedScopes } from "../src/server/mcp-http";
import {
  ProposalReviewStale,
  StoreRuleError,
  decideProposal,
  loadRecords,
  pendingProposal,
  saveRecord,
} from "../src/server/store";
import { setMinimumAppContractForTests } from "../src/server/contract";
import { exportResponse } from "../src/server/export";
import {
  addDays,
  defaultSettings,
  localDate,
  settingsId,
} from "@bent/fitness-contracts/domain";
import type { Settings } from "@bent/fitness-contracts/domain";
import { catalogue } from "@bent/fitness-contracts/catalogue";

const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
if (configured)
  process.env.DATABASE_URL = process.env.FITNESS_TEST_DATABASE_URL;
const owners = Array.from(
  { length: 6 },
  () => "integration:" + crypto.randomUUID(),
);
const [planner, newcomer, decider, dismisser, profiler, refused] = owners as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const timezone = "Australia/Brisbane";
const today = localDate(timezone);
const yesterday = addDays(today, -1);
const tomorrow = addDays(today, 1);
const plan: AgentAccess = {
  read: false,
  write: false,
  targets: false,
  plan: true,
};

function settings(): Settings {
  return {
    ...defaultSettings(addDays(today, -28), timezone),
    dayPlans: {
      [yesterday]: { type: "rest", routine: null },
      [tomorrow]: { type: "run", routine: null },
    },
  };
}
beforeAll(async () => {
  if (!configured) return;
  await database().unsafe(
    await Bun.file(new URL("../schema.sql", import.meta.url)).text(),
  );
  for (const owner of [planner, decider, dismisser, profiler, refused])
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: 0,
      data: settings(),
    });
});
afterEach(() => setMinimumAppContractForTests());
afterAll(async () => {
  if (!configured) return;
  const sql = database();
  for (const owner of owners) {
    await sql`DELETE FROM fitness_plan_proposals WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_operations WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_records WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_accounts WHERE owner_id=${owner}`;
  }
});

const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.unknown().optional(),
});
async function connect(owner: string, access = plan) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([
    createFitnessMcpServer(owner, access).connect(serverSide),
    client.connect(clientSide),
  ]);
  async function invoke(name: string, args: Record<string, unknown>) {
    return toolResult.parse(await client.callTool({ name, arguments: args }));
  }
  return {
    client,
    instructions: () => client.getInstructions() ?? "",
    async call<T>(
      name: string,
      args: Record<string, unknown>,
      schema: z.ZodType<T>,
    ) {
      const result = await invoke(name, args);
      if (result.isError)
        throw new Error(result.content.find((c) => c.type === "text")?.text);
      return schema.parse(result.structuredContent);
    },
    async failure(name: string, args: Record<string, unknown>) {
      const result = await invoke(name, args);
      expect(result.isError).toBe(true);
      return result.content.find((c) => c.type === "text")?.text ?? "";
    },
  };
}
const key = () => crypto.randomUUID();
const proposal = {
  summary: "Three full-body sessions a week that fit 45 minutes.",
  goal: "Get stronger",
  schedule: [
    "strength",
    "rest",
    "strength",
    "run",
    "strength",
    "rest",
    "rest",
  ] as Settings["schedule"],
  routines: [
    {
      name: "Full body A",
      exercises: [
        { id: "squat", sets: 3, min: 8, max: 10 },
        { id: "bench", sets: 3, min: 8, max: 10 },
        { id: "row", sets: 3, min: 10, max: 12, rest: 90 },
      ],
    },
    {
      name: "Full body B",
      exercises: [
        { id: "rdl", sets: 3, min: 8, max: 10 },
        { id: "press", sets: 3, min: 8, max: 10 },
        { id: "plank", sets: 2, min: 30, max: 45 },
      ],
    },
  ],
};
const summary = z.object({
  id: z.uuid(),
  status: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  summary: z.string(),
});
const proposed = z.object({
  proposal: summary,
  warnings: z.array(z.object({ path: z.string(), message: z.string() })),
  reviewUrl: z.string().nullable(),
});
const trainingPlan = z.object({
  today: z.string(),
  plan: z
    .object({
      schedule: z.array(z.string()),
      routines: z.array(
        z.object({
          name: z.string(),
          exercises: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      ),
      profile: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  profileSaved: z.boolean(),
  pendingProposal: summary.nullable(),
});
const settingsOf = async (owner: string) =>
  (await loadRecords(owner)).find((r) => r.id === settingsId);
/** Accepts a proposal as reviewed against the account's current settings. */
const accept = async (owner: string, id: string) =>
  decideProposal(owner, id, {
    status: "accepted",
    reviewedRevision: (await settingsOf(owner))?.revision ?? 0,
  });
const dismiss = (owner: string, id: string) =>
  decideProposal(owner, id, { status: "dismissed" });

test("assistants are told to request fitness:plan once Clerk issues it", () => {
  const before = process.env.FITNESS_PLAN_SCOPE;
  try {
    delete process.env.FITNESS_PLAN_SCOPE;
    expect(advertisedScopes()).not.toContain("fitness:plan");
    process.env.FITNESS_PLAN_SCOPE = "enabled";
    expect(advertisedScopes()).toContain("fitness:plan");
  } finally {
    if (before === undefined) delete process.env.FITNESS_PLAN_SCOPE;
    else process.env.FITNESS_PLAN_SCOPE = before;
  }
});

test.skipIf(!configured)(
  "a plan connection lists the planning tools and the set-up prompt",
  async () => {
    // Below contract 3 the planning profile isn't offered.
    setMinimumAppContractForTests(2);
    const { client, instructions } = await connect(planner);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "fitness_get_plan_proposal",
      "fitness_get_training_plan",
      "fitness_list_exercises",
      "fitness_propose_plan",
    ]);
    // The planning profile is offered once every served app build reads it.
    const input = tools.find((t) => t.name === "fitness_propose_plan")
      ?.inputSchema.properties;
    expect(Object.keys(input ?? {})).not.toContain("profile");
    expect(
      tools.find((t) => t.name === "fitness_propose_plan")?.inputSchema
        .additionalProperties,
    ).toBe(false);
    expect(instructions()).toContain("fitness_propose_plan");
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["set_up_training"]);
    const prompt = await client.getPrompt({ name: "set_up_training" });
    expect(prompt.messages[0]?.content).toEqual({
      type: "text",
      text: setUpTraining,
    });

    setMinimumAppContractForTests(3);
    const later = await connect(planner);
    const offered = (await later.client.listTools()).tools.find(
      (t) => t.name === "fitness_propose_plan",
    )?.inputSchema.properties;
    expect(Object.keys(offered ?? {})).toContain("profile");

    const other = await connect(planner, { ...plan, plan: false, read: true });
    const names = (await other.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("fitness_propose_plan");
    expect(other.instructions()).not.toContain("fitness_propose_plan");
  },
);

test.skipIf(!configured)(
  "the catalogue and current plan are available to plan from",
  async () => {
    const { call } = await connect(planner);
    const listed = await call(
      "fitness_list_exercises",
      {},
      z.object({
        exercises: z.array(
          z.object({ id: z.string(), equipment: z.array(z.string()) }),
        ),
        equipment: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    );
    expect(listed.exercises.map((e) => e.id)).toEqual(
      catalogue.map((e) => e.id),
    );
    expect(listed.equipment.find((e) => e.id === "dumbbells")?.name).toBe(
      "Dumbbells",
    );
    const current = await call("fitness_get_training_plan", {}, trainingPlan);
    expect(current).toMatchObject({
      today,
      profileSaved: true,
      pendingProposal: null,
      plan: {
        routines: [{ name: "Strength A" }, { name: "Strength B" }],
        profile: {},
      },
    });
  },
);

test.skipIf(!configured)(
  "proposing a plan records it for review without changing the account",
  async () => {
    const { call } = await connect(planner);
    const before = await settingsOf(planner);
    const requestId = key();
    const first = await call(
      "fitness_propose_plan",
      { requestId, ...proposal },
      proposed,
    );
    expect(first.proposal).toMatchObject({
      status: "pending",
      decidedAt: null,
      summary: proposal.summary,
    });
    expect(first.reviewUrl).toEndWith("/proposal");
    expect(await settingsOf(planner)).toEqual(before);
    // A retry returns the same proposal.
    const retry = await call(
      "fitness_propose_plan",
      { requestId, ...proposal },
      proposed,
    );
    expect(retry).toEqual(first);
    const current = await call("fitness_get_training_plan", {}, trainingPlan);
    expect(current.pendingProposal?.id).toBe(first.proposal.id);

    // A new proposal replaces the one still pending.
    const second = await call(
      "fitness_propose_plan",
      { requestId: key(), ...proposal, summary: "A shorter week." },
      proposed,
    );
    expect(second.proposal.id).not.toBe(first.proposal.id);
    const replaced = await call(
      "fitness_get_plan_proposal",
      { id: first.proposal.id },
      summary,
    );
    expect(replaced.status).toBe("replaced");
    expect((await pendingProposal(planner))?.id).toBe(second.proposal.id);
    expect(await settingsOf(planner)).toEqual(before);
  },
);

test.skipIf(!configured)(
  "plans that don't fit are refused with every problem",
  async () => {
    const { failure } = await connect(refused);
    const text = await failure("fitness_propose_plan", {
      requestId: key(),
      ...proposal,
      routines: [
        {
          name: "Gym",
          exercises: [
            { id: "deadlift", sets: 3, min: 5, max: 5 },
            { id: "hip-thrust", sets: 3, min: 8, max: 12 },
          ],
        },
      ],
    });
    expect(text).toBe(
      "routines.0.exercises.0.id: Gym: deadlift is not in the exercise catalogue.\nroutines.0.exercises.1.id: Gym: hip-thrust is not in the exercise catalogue.",
    );
    expect(
      await failure("fitness_propose_plan", {
        requestId: key(),
        ...proposal,
        routines: [
          {
            name: "Legs",
            exercises: [{ id: "squat", sets: 3, min: 8.5, max: 10 }],
          },
        ],
      }),
    ).toContain("use whole numbers for the Goblet squat rep range");
    expect(await pendingProposal(refused)).toBeNull();

    const { failure: withoutSettings } = await connect(newcomer);
    expect(
      await withoutSettings("fitness_propose_plan", {
        requestId: key(),
        ...proposal,
      }),
    ).toBe("Set up Fitness in the app before proposing a plan.");
  },
);

test.skipIf(!configured)(
  "accepting a proposal replaces the plan from today on",
  async () => {
    const { call } = await connect(decider);
    const before = await settingsOf(decider);
    const { proposal: made } = await call(
      "fitness_propose_plan",
      { requestId: key(), ...proposal },
      proposed,
    );
    // A review of settings that have since changed can't be accepted.
    expect(
      decideProposal(decider, made.id, {
        status: "accepted",
        reviewedRevision: (before?.revision ?? 0) - 1,
      }),
    ).rejects.toBeInstanceOf(ProposalReviewStale);
    expect((await pendingProposal(decider))?.id).toBe(made.id);
    const accepted = await accept(decider, made.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.decidedAt).not.toBeNull();
    const after = await settingsOf(decider);
    if (after?.data.kind !== "settings" || before?.data.kind !== "settings")
      throw new Error("Expected settings.");
    expect(after.revision).toBe(before.revision + 1);
    expect(after.data.schedule).toEqual(proposal.schedule);
    expect(after.data.goal).toBe("Get stronger");
    expect(after.data.routines.map((r) => r.id)).toEqual(
      accepted.plan.routines.map((r) => r.id),
    );
    expect(after.data.routines[0]?.exercises.map((e) => e.name)).toEqual([
      "Goblet squat",
      "Flat dumbbell bench press",
      "Supported one-arm row",
    ]);
    expect(after.data.dayPlans).toEqual({
      [yesterday]: { type: "rest", routine: null },
    });
    expect(after.data.startDate).toBe(before.data.startDate);
    expect(after.data.calories).toBe(before.data.calories);

    // Repeating the decision returns the same result; a different one is refused.
    expect(await accept(decider, made.id)).toEqual(accepted);
    // A client that lost the reply resends the revision it reviewed.
    expect(
      await decideProposal(decider, made.id, {
        status: "accepted",
        reviewedRevision: before.revision,
      }),
    ).toEqual(accepted);
    expect((await settingsOf(decider))?.revision).toBe(after.revision);
    expect(dismiss(decider, made.id)).rejects.toThrow(
      new StoreRuleError("This plan proposal was accepted."),
    );
    expect(accept(decider, crypto.randomUUID())).rejects.toThrow(
      new StoreRuleError("This plan proposal is no longer available."),
    );
    const status = await call(
      "fitness_get_plan_proposal",
      { id: made.id },
      summary,
    );
    expect(status.status).toBe("accepted");
  },
);

test.skipIf(!configured)("dismissing a proposal keeps the plan", async () => {
  const { call } = await connect(dismisser);
  const before = await settingsOf(dismisser);
  const first = await call(
    "fitness_propose_plan",
    { requestId: key(), ...proposal },
    proposed,
  );
  const second = await call(
    "fitness_propose_plan",
    { requestId: key(), ...proposal },
    proposed,
  );
  expect(accept(dismisser, first.proposal.id)).rejects.toThrow(
    new StoreRuleError("This plan proposal was replaced by a newer proposal."),
  );
  const dismissed = await dismiss(dismisser, second.proposal.id);
  expect(dismissed.status).toBe("dismissed");
  expect(await settingsOf(dismisser)).toEqual(before);
  expect(await pendingProposal(dismisser)).toBeNull();

  // Another account can't read or decide this account's proposals.
  const stranger = await connect(planner);
  expect(
    await stranger.failure("fitness_get_plan_proposal", {
      id: second.proposal.id,
    }),
  ).toBe("No plan proposal has this ID.");
  expect(accept(planner, second.proposal.id)).rejects.toThrow(
    new StoreRuleError("This plan proposal is no longer available."),
  );

  // The account export includes its proposals with their status.
  const exported = (await exportResponse(dismisser).json()) as {
    planProposals: { id: string; status: string }[];
  };
  expect(
    exported.planProposals.map(({ id, status }) => ({ id, status })),
  ).toEqual([
    { id: first.proposal.id, status: "replaced" },
    { id: second.proposal.id, status: "dismissed" },
  ]);
});

test.skipIf(!configured)(
  "a planning profile is saved only while every served build reads it",
  async () => {
    const withProfile = {
      ...proposal,
      profile: {
        experience: "returning",
        sessionMinutes: 45,
        availableEquipment: ["dumbbells", "adjustable-bench"],
        limitations: "Sore left shoulder overhead.",
      },
    };
    // Below contract 3 the tool doesn't offer a profile and refuses one sent
    // anyway, so an assistant never reports a profile Fitness didn't keep.
    setMinimumAppContractForTests(2);
    const early = await connect(profiler);
    expect(
      await early.failure("fitness_propose_plan", {
        requestId: key(),
        ...withProfile,
      }),
    ).toContain("profile");
    expect(await pendingProposal(profiler)).toBeNull();

    setMinimumAppContractForTests(3);
    const { call } = await connect(profiler);
    const made = await call(
      "fitness_propose_plan",
      { requestId: key(), ...withProfile },
      proposed,
    );
    // The press needs an adjustable bench, which the list includes, and each
    // session fits 45 minutes, so nothing needs a warning.
    expect(made.warnings).toEqual([]);

    // A proposal made while the profile could be saved is refused once it can't.
    setMinimumAppContractForTests(2);
    expect(accept(profiler, made.proposal.id)).rejects.toThrow(
      new StoreRuleError(
        "This change uses fields the bent Fitness app can't read yet. Remove them and try again.",
      ),
    );
    expect((await pendingProposal(profiler))?.id).toBe(made.proposal.id);

    setMinimumAppContractForTests(3);
    await accept(profiler, made.proposal.id);
    const after = await settingsOf(profiler);
    expect(after?.data).toMatchObject({
      experience: "returning",
      sessionMinutes: 45,
      availableEquipment: ["dumbbells", "adjustable-bench"],
    });
  },
);
