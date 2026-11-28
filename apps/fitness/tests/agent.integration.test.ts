import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { database } from "../src/server/db";
import { agentAccess } from "../src/server/auth";
import type { AgentAccess } from "../src/server/auth";
import { createFitnessMcpServer, instructions } from "../src/server/mcp";
import { advertisedScopes } from "../src/server/mcp-http";
import {
  BatchConflict,
  changeOnce,
  loadRecords,
  saveRecord,
} from "../src/server/store";
import { setMinimumAppContractForTests } from "../src/server/contract";
import {
  addDays,
  defaultSettings,
  localDate,
  settingsId,
} from "@bent/fitness-contracts/domain";
const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
if (configured)
  process.env.DATABASE_URL = process.env.FITNESS_TEST_DATABASE_URL;
const ownerA = "integration:" + crypto.randomUUID(),
  ownerB = "integration:" + crypto.randomUUID(),
  ownerC = "integration:" + crypto.randomUUID();
const timezone = "Australia/Brisbane";
const today = localDate(timezone);
beforeAll(async () => {
  if (!configured) return;
  await database().unsafe(
    await Bun.file(new URL("../schema.sql", import.meta.url)).text(),
  );
  await saveRecord(ownerA, {
    operationId: crypto.randomUUID(),
    id: settingsId,
    revision: 0,
    data: { ...defaultSettings(today, timezone), units: "lb" },
  });
  await saveRecord(ownerC, {
    operationId: crypto.randomUUID(),
    id: settingsId,
    revision: 0,
    data: defaultSettings(today, timezone),
  });
});
afterAll(async () => {
  if (!configured) return;
  const sql = database();
  for (const owner of [ownerA, ownerB, ownerC]) {
    await sql`DELETE FROM fitness_operations WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_records WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_accounts WHERE owner_id=${owner}`;
  }
});

const meal = z.object({
  id: z.string(),
  revision: z.number(),
  name: z.string(),
  calories: z.number(),
  protein: z.number(),
});
const amounts = z.object({ calories: z.number(), protein: z.number() });
const food = z.object({
  meals: z.array(meal),
  totals: amounts,
  remaining: amounts.nullable(),
});
const entry = z.object({ id: z.string(), revision: z.number() });
const weight = entry.extend({ kg: z.number(), display: z.string() });
const day = z.object({
  date: z.string(),
  timezone: z.string(),
  units: z.string(),
  targets: amounts.nullable(),
  plan: z.object({ type: z.string() }).nullable(),
  food,
  weight: weight.nullable(),
  runs: z.array(
    entry.extend({
      minutes: z.number(),
      distanceKm: z.number(),
      notes: z.string(),
    }),
  ),
});
const added = z.object({ date: z.string(), added: z.array(meal), food });
const updated = z.object({ updated: meal, food });
const deleted = z.object({
  deleted: z.array(
    z.object({ id: z.string(), kind: z.string(), date: z.string() }),
  ),
});
const savedList = z.object({ savedMeals: z.array(meal) });
const savedAdded = savedList.extend({
  added: z.array(meal),
  alreadySaved: z.array(meal),
});
const logged = z.object({ replacedKg: z.number().nullable(), weight });
const run = z.object({ run: entry });
const history = z.object({
  days: z.array(z.object({ date: z.string(), calories: z.number() })),
});
const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.unknown().optional(),
});

const full: AgentAccess = { read: true, write: true, targets: true, plan: false };
async function connect(owner: string, access = full) {
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
    instructions: () => client.getInstructions() ?? "",
    async tools() {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    },
    /** Calls a tool and validates its structured result. */
    async call<T>(
      name: string,
      args: Record<string, unknown>,
      schema: z.ZodType<T>,
    ): Promise<T> {
      const result = await invoke(name, args);
      if (result.isError)
        throw new Error(result.content.find((c) => c.type === "text")?.text);
      return schema.parse(result.structuredContent);
    },
    /** Calls a tool that should fail and returns its message. */
    async failure(name: string, args: Record<string, unknown>) {
      const result = await invoke(name, args);
      expect(result.isError).toBeTrue();
      return result.content.find((c) => c.type === "text")?.text ?? "";
    },
  };
}
const key = () => crypto.randomUUID();
const anything = z.record(z.string(), z.unknown());

test.skipIf(!configured)(
  "agents choose the nutrients the account tracks and log them",
  async () => {
    const { call, failure } = await connect(ownerC);
    // Fitness stores nutrients only while every served build reads them.
    setMinimumAppContractForTests(1);
    try {
      expect(
        await failure("fitness_update_food_targets", {
          requestId: key(),
          nutrients: { carbs: { track: true, target: 250 } },
        }),
      ).toContain("can't read yet");
    } finally {
      setMinimumAppContractForTests();
    }
    {
      const targets = await call(
        "fitness_update_food_targets",
        {
          requestId: key(),
          protein: 150,
          nutrients: {
            carbs: { track: true, target: 250 },
            fibre: { track: true },
          },
        },
        anything,
      );
      expect(targets).toEqual({
        targets: { calories: 2400, protein: 150, carbs: 250, fibre: null },
        trackedNutrients: ["carbs", "fibre"],
      });
      expect(
        await failure("fitness_update_food_targets", {
          requestId: key(),
          nutrients: { fibre: { track: false, target: 20 } },
        }),
      ).toContain("leave out the target");
      expect(
        await failure("fitness_update_food_targets", {
          requestId: key(),
          nutrients: { fat: { track: true, target: 2 } },
        }),
      ).toContain("fat");

      const logged = await call(
        "fitness_add_meals",
        {
          requestId: key(),
          meals: [
            {
              name: "Oats",
              calories: 400,
              protein: 20,
              carbs: 60,
              fibre: 8,
              fat: 9,
            },
            { name: "Coffee", calories: 10, protein: 0 },
          ],
        },
        anything,
      );
      const food = z
        .object({
          meals: z.array(anything),
          totals: anything,
          recordedIn: anything,
          remaining: anything,
        })
        .parse(logged.food);
      expect(food.totals).toEqual({
        calories: 410,
        protein: 20,
        carbs: 60,
        fibre: 8,
      });
      expect(food.recordedIn).toEqual({ carbs: 1, fibre: 1 });
      expect(food.remaining).toEqual({
        calories: 1990,
        protein: 130,
        carbs: 190,
        fibre: null,
      });
      const oats = z
        .object({ id: z.string(), revision: z.number() })
        .and(anything)
        .parse(food.meals[0]);
      // Values for nutrients the account doesn't track stay on the meal.
      expect(oats).toMatchObject({ carbs: 60, fibre: 8, fat: 9 });

      const edited = await call(
        "fitness_update_meal",
        {
          requestId: key(),
          id: oats.id,
          revision: oats.revision,
          fibre: null,
          carbs: 55,
        },
        anything,
      );
      expect(edited.updated).toEqual({
        id: oats.id,
        revision: 2,
        name: "Oats",
        calories: 400,
        protein: 20,
        carbs: 55,
        fat: 9,
      });

      const days = await call(
        "fitness_get_history",
        { from: today },
        z.object({ days: z.array(anything) }),
      );
      expect(days.days[0]).toMatchObject({
        calories: 410,
        carbs: 55,
        fibre: 0,
        meals: 2,
      });

      const saved = await call(
        "fitness_add_saved_meals",
        {
          requestId: key(),
          savedMeals: [
            { name: "Oats", calories: 400, protein: 20, carbs: 60 },
            { name: "Oats", calories: 400, protein: 20, carbs: 70 },
            { name: "oats", calories: 400, protein: 20, carbs: 60 },
          ],
        },
        z.object({ added: z.array(anything), alreadySaved: z.array(anything) }),
      );
      expect(saved.added).toHaveLength(2);
      expect(saved.alreadySaved).toHaveLength(1);
      const first = z
        .object({ id: z.string(), revision: z.number() })
        .parse(saved.added[0]);
      const savedEdit = await call(
        "fitness_update_saved_meal",
        {
          requestId: key(),
          id: first.id,
          revision: first.revision,
          carbs: null,
          fat: 7,
        },
        anything,
      );
      expect(savedEdit.updated).toEqual({
        id: first.id,
        revision: 2,
        name: "Oats",
        calories: 400,
        protein: 20,
        fat: 7,
      });

      const kept = await call(
        "fitness_update_food_targets",
        {
          requestId: key(),
          nutrients: { carbs: { track: true }, fibre: { track: false } },
        },
        anything,
      );
      expect(kept).toEqual({
        targets: { calories: 2400, protein: 150, carbs: 250 },
        trackedNutrients: ["carbs"],
      });
      const day = await call("fitness_get_day", {}, anything);
      expect(day).toMatchObject({
        trackedNutrients: ["carbs"],
        food: { totals: { calories: 410, protein: 20, carbs: 55 } },
      });

      const writer = await connect(ownerC, {
        read: false,
        write: false,
        targets: true,
        plan: false,
      });
      const receipt = await writer.call(
        "fitness_update_food_targets",
        { requestId: key(), nutrients: { fat: { track: true, target: 70 } } },
        anything,
      );
      expect(receipt).toEqual({ saved: true });
      // The receipt is the same whether or not the targets changed.
      const unchanged = await writer.call(
        "fitness_update_food_targets",
        { requestId: key(), nutrients: { fat: { track: true, target: 70 } } },
        anything,
      );
      expect(unchanged).toEqual(receipt);
      // A retry with the same request ID returns the first result without saving again.
      const retryId = key();
      const original = await call(
        "fitness_update_food_targets",
        { requestId: retryId, calories: 2500 },
        anything,
      );
      const before = (await loadRecords(ownerC)).find((r) => r.id === settingsId);
      const retried = await call(
        "fitness_update_food_targets",
        { requestId: retryId, calories: 2500 },
        anything,
      );
      expect(retried).toEqual(original);
      const after = (await loadRecords(ownerC)).find((r) => r.id === settingsId);
      expect(after?.revision).toBe(before?.revision);
      expect(
        await failure("fitness_update_food_targets", {
          requestId: retryId,
          calories: 2600,
        }),
      ).toContain("already used");
    }
  },
);

test.skipIf(!configured)(
  "agents log, edit and remove food for their own account",
  async () => {
    const { call, failure } = await connect(ownerA);
    const empty = await call("fitness_get_day", {}, day);
    expect(empty).toMatchObject({
      date: today,
      timezone,
      units: "lb",
      targets: { calories: 2400, protein: 120 },
      food: { meals: [], totals: { calories: 0, protein: 0 } },
    });
    expect(empty.plan?.type).toBeDefined();

    const meals = await call(
      "fitness_add_meals",
      {
        requestId: key(),
        meals: [
          { name: "Porridge with berries", calories: 420, protein: 14 },
          { name: "Chicken wrap", calories: 610, protein: 42.5 },
        ],
      },
      added,
    );
    expect(meals.added).toHaveLength(2);
    expect(meals.food.totals).toEqual({ calories: 1030, protein: 56.5 });
    expect(meals.food.remaining).toEqual({ calories: 1370, protein: 63.5 });

    const wrap = meals.added[1];
    if (!wrap) throw new Error("The wrap was not added.");
    const edit = await call(
      "fitness_update_meal",
      { requestId: key(), id: wrap.id, revision: wrap.revision, calories: 650 },
      updated,
    );
    expect(edit.updated).toEqual({
      id: wrap.id,
      revision: 2,
      name: "Chicken wrap",
      calories: 650,
      protein: 42.5,
    });
    expect(edit.food.totals.calories).toBe(1070);
    expect(
      await failure("fitness_update_meal", {
        requestId: key(),
        id: wrap.id,
        revision: wrap.revision,
        calories: 1,
      }),
    ).toContain("changed after you read it");

    const yesterday = addDays(today, -1);
    const moved = await call(
      "fitness_update_meal",
      { requestId: key(), id: wrap.id, revision: 2, date: yesterday },
      updated,
    );
    expect(moved.food.meals.map((m) => m.id)).toEqual([wrap.id]);
    const days = await call(
      "fitness_get_history",
      { from: yesterday },
      history,
    );
    expect(days.days.map((d) => d.calories)).toEqual([650, 420]);

    const removed = await call(
      "fitness_delete_entries",
      { requestId: key(), entries: [{ id: wrap.id, revision: 3 }] },
      deleted,
    );
    expect(removed.deleted).toEqual([
      { id: wrap.id, kind: "meal", date: yesterday },
    ]);
    const after = await call("fitness_get_day", { date: yesterday }, day);
    expect(after.food.meals).toEqual([]);

    expect(
      await failure("fitness_add_meals", {
        requestId: key(),
        meals: [{ name: "Too much", calories: 20000, protein: 1 }],
      }),
    ).toContain("calories");
  },
);

test.skipIf(!configured)(
  "a retried request saves once and a reused request ID fails",
  async () => {
    const { call, failure } = await connect(ownerA);
    const date = addDays(today, -3);
    const request = {
      requestId: key(),
      date,
      meals: [{ name: "Banana", calories: 105, protein: 1.3 }],
    };
    const first = await call("fitness_add_meals", request, added);
    const retry = await call("fitness_add_meals", request, added);
    expect(retry).toEqual(first);
    const stored = (await loadRecords(ownerA)).filter(
      (r) => r.data.kind === "meal" && r.data.date === date,
    );
    expect(stored).toHaveLength(1);
    expect(
      await failure("fitness_add_meals", {
        ...request,
        meals: [{ name: "Apple", calories: 95, protein: 0.5 }],
      }),
    ).toContain("already used");

    const banana = first.added[0];
    if (!banana) throw new Error("The banana was not added.");
    const removal = {
      requestId: key(),
      entries: [{ id: banana.id, revision: banana.revision }],
    };
    const removed = await call("fitness_delete_entries", removal, deleted);
    expect(await call("fitness_delete_entries", removal, deleted)).toEqual(
      removed,
    );
  },
);

test.skipIf(!configured)(
  "weigh-ins replace the day's value and runs follow the date rules",
  async () => {
    const { call, failure } = await connect(ownerA);
    const first = await call(
      "fitness_log_weight",
      { requestId: key(), weight: 176.4 },
      logged,
    );
    expect(first).toMatchObject({
      replacedKg: null,
      weight: { display: "176.4 lb" },
    });
    expect(first.weight.kg).toBeCloseTo(80.01, 2);
    const second = await call(
      "fitness_log_weight",
      { requestId: key(), weight: 79.5, unit: "kg" },
      logged,
    );
    expect(second).toMatchObject({ replacedKg: 80.01, weight: { kg: 79.5 } });
    const heavy = await call(
      "fitness_log_weight",
      { requestId: key(), date: addDays(today, -1), weight: 1101, unit: "lb" },
      logged,
    );
    expect(heavy.weight.display).toBe("1101 lb");
    const weights = (await loadRecords(ownerA)).filter(
      (r) => r.data.kind === "weight",
    );
    expect(weights).toHaveLength(2);

    const logRun = await call(
      "fitness_log_run",
      { requestId: key(), minutes: 31, distanceKm: 5.2 },
      run,
    );
    expect(
      await failure("fitness_log_run", {
        requestId: key(),
        date: addDays(today, 2),
        minutes: 30,
        distanceKm: 5,
      }),
    ).toContain("today or an earlier date");
    const current = await call("fitness_get_day", {}, day);
    expect(current.runs).toEqual([
      {
        id: logRun.run.id,
        revision: 1,
        minutes: 31,
        distanceKm: 5.2,
        notes: "",
      },
    ]);
    expect(current.weight?.kg).toBe(79.5);
  },
);

test.skipIf(!configured)(
  "agents only reach the authenticated account",
  async () => {
    const own = await connect(ownerA);
    const apple = (
      await own.call(
        "fitness_add_meals",
        {
          requestId: key(),
          meals: [{ name: "Apple", calories: 95, protein: 0.5 }],
        },
        added,
      )
    ).added[0];
    if (!apple) throw new Error("The apple was not added.");
    const other = await connect(ownerB);
    const otherDay = await other.call("fitness_get_day", {}, day);
    expect(otherDay.food.meals).toEqual([]);
    expect(otherDay.targets).toBeNull();
    expect(
      await other.failure("fitness_update_meal", {
        requestId: key(),
        id: apple.id,
        revision: apple.revision,
        calories: 1,
      }),
    ).toContain("No meal entry has the ID");
    expect(
      await other.failure("fitness_delete_entries", {
        requestId: key(),
        entries: [{ id: apple.id, revision: apple.revision }],
      }),
    ).toContain("No meal, saved meal, run, weigh-in entry");
    expect((await loadRecords(ownerA)).some((r) => r.id === apple.id)).toBe(
      true,
    );
  },
);

test.skipIf(!configured)(
  "a conflicting change rolls back the request and its receipt",
  async () => {
    const toast = await saveRecord(ownerB, {
      operationId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      revision: 0,
      data: {
        kind: "meal",
        date: today,
        name: "Toast",
        calories: 200,
        protein: 6,
      },
    });
    if (toast.status !== "saved" || !toast.record) throw new Error("setup");
    const toastId = toast.record.id;
    const before = await loadRecords(ownerB);
    const receipt = { id: crypto.randomUUID(), fingerprint: "conflict" };
    const attempt = changeOnce(ownerB, receipt, async (change) => {
      await change.save({
        operationId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        revision: 0,
        data: {
          kind: "meal",
          date: today,
          name: "Eggs",
          calories: 150,
          protein: 12,
        },
      });
      await change.save({
        operationId: crypto.randomUUID(),
        id: toastId,
        revision: 0,
        data: null,
      });
      return {};
    });
    expect(attempt).rejects.toBeInstanceOf(BatchConflict);
    await attempt.catch(() => undefined);
    expect(await loadRecords(ownerB)).toEqual(before);
    const [stored] =
      await database()`SELECT id FROM fitness_operations WHERE owner_id=${ownerB} AND id=${receipt.id}`;
    expect(stored).toBeUndefined();
  },
);

test("token scopes grant read and write access separately", () => {
  const none = { read: false, write: false, targets: false, plan: false };
  expect(agentAccess("oauth_token", ["profile", "email"])).toEqual(none);
  expect(agentAccess("oauth_token", ["fitness:read"])).toEqual({
    ...none,
    read: true,
  });
  // Food targets need their own consent; earlier write grants don't cover them.
  expect(agentAccess("oauth_token", ["fitness:read", "fitness:write"])).toEqual(
    { ...full, targets: false, plan: false },
  );
  expect(agentAccess("oauth_token", ["fitness:targets"])).toEqual({
    ...none,
    targets: true,
    plan: false,
  });
  expect(
    agentAccess("oauth_token", [
      "fitness:read",
      "fitness:write",
      "fitness:targets",
    ]),
  ).toEqual(full);
  expect(agentAccess("oauth_token", [])).toEqual({ read: false, write: false, targets: false, plan: false });
  expect(agentAccess("api_key", [])).toEqual({ ...full, plan: true });
  expect(agentAccess("oauth_token", ["fitness:plan"])).toEqual({
    ...none,
    plan: true,
  });
  expect(agentAccess("api_key", ["fitness:read"])).toEqual({
    ...none,
    read: true,
  });
  expect(agentAccess("api_key", ["other"])).toEqual(none);
});

test("assistants are told to request fitness:targets once Clerk issues it", () => {
  const before = process.env.FITNESS_TARGETS_SCOPE;
  try {
    delete process.env.FITNESS_TARGETS_SCOPE;
    expect(advertisedScopes()).toEqual(["fitness:read", "fitness:write"]);
    process.env.FITNESS_TARGETS_SCOPE = "enabled";
    expect(advertisedScopes()).toEqual([
      "fitness:read",
      "fitness:write",
      "fitness:targets",
    ]);
  } finally {
    if (before === undefined) delete process.env.FITNESS_TARGETS_SCOPE;
    else process.env.FITNESS_TARGETS_SCOPE = before;
  }
});

test("instructions mention only the tools and results a grant includes", () => {
  const tools = /fitness_[a-z_]+/g;
  const reader = instructions({ read: true, write: false, targets: false, plan: false });
  expect(reader.match(tools) ?? []).toEqual([]);
  expect(reader).toContain("need write access");
  const writer = instructions({ read: false, write: true, targets: false, plan: false });
  expect(writer.match(tools)).toEqual([
    "fitness_add_meals",
    "fitness_add_saved_meals",
  ]);
  expect(instructions({ ...full, targets: false, plan: false })).not.toContain(
    "fitness_update_food_targets",
  );
  const targetsOnly = instructions({ read: false, write: false, targets: true, plan: false });
  expect(targetsOnly.match(tools)).toEqual(["fitness_update_food_targets"]);
  expect(targetsOnly).toContain("requestId");
  expect(writer).not.toContain("totals");
  expect(writer).toContain("receipts");
  const both = instructions(full);
  expect(both).toContain("fitness_get_day");
  expect(both).toContain("fitness_list_saved_meals");
  expect(both).toContain("totals");
});

test.skipIf(!configured)(
  "a connection lists only the tools its grant allows",
  async () => {
    const reader = await connect(ownerB, { read: true, write: false, targets: false, plan: false });
    expect(await reader.tools()).toEqual([
      "fitness_get_day",
      "fitness_get_history",
      "fitness_list_saved_meals",
    ]);
    expect(
      await reader.failure("fitness_add_meals", {
        requestId: key(),
        meals: [{ name: "Apple", calories: 95, protein: 0.5 }],
      }),
    ).toContain("not found");
    expect(reader.instructions()).toBe(
      instructions({ read: true, write: false, targets: false, plan: false }),
    );
    const writer = await connect(ownerB, { read: false, write: true, targets: false, plan: false });
    expect(writer.instructions()).toBe(
      instructions({ read: false, write: true, targets: false, plan: false }),
    );
    expect(await writer.tools()).toEqual([
      "fitness_add_meals",
      "fitness_add_saved_meals",
      "fitness_delete_entries",
      "fitness_log_run",
      "fitness_log_weight",
      "fitness_update_meal",
      "fitness_update_saved_meal",
    ]);
    // A connection granted fitness:read and fitness:write before food
    // targets existed can't change them.
    const legacy = await connect(ownerB, { ...full, targets: false, plan: false });
    expect(await legacy.tools()).not.toContain("fitness_update_food_targets");
    expect(
      await legacy.failure("fitness_update_food_targets", {
        requestId: key(),
        calories: 2000,
      }),
    ).toContain("not found");
    const targets = await connect(ownerB, {
      read: false,
      write: false,
      targets: true,
      plan: false,
    });
    expect(await targets.tools()).toEqual(["fitness_update_food_targets"]);
  },
);

test.skipIf(!configured)(
  "history accepts ranges at the end of the calendar",
  async () => {
    const { call, failure } = await connect(ownerB);
    const last = await call(
      "fitness_get_history",
      { from: "9999-12-31", to: "9999-12-31" },
      history,
    );
    expect(last.days.map((d) => d.date)).toEqual(["9999-12-31"]);
    const span = await call(
      "fitness_get_history",
      { from: "9999-10-31", to: "9999-12-31" },
      history,
    );
    expect(span.days).toHaveLength(62);
    expect(span.days.at(-1)?.date).toBe("9999-12-31");
    expect(
      await failure("fitness_get_history", {
        from: "9999-10-30",
        to: "9999-12-31",
      }),
    ).toContain("up to 62 days");
  },
);

test.skipIf(!configured)(
  "write-only connections receive receipts without other entries",
  async () => {
    const owner = await connect(ownerB);
    const date = addDays(today, -5);
    await owner.call(
      "fitness_add_meals",
      {
        requestId: key(),
        date,
        meals: [{ name: "Private dinner", calories: 800, protein: 40 }],
      },
      added,
    );
    await owner.call(
      "fitness_log_weight",
      { requestId: key(), date, weight: 70, unit: "kg" },
      logged,
    );
    const writer = await connect(ownerB, { read: false, write: true, targets: false, plan: false });
    const request = {
      requestId: key(),
      date,
      meals: [{ name: "Snack", calories: 150, protein: 5 }],
    };
    const receipts = [
      await writer.call("fitness_add_meals", request, z.unknown()),
      await writer.call("fitness_add_meals", request, z.unknown()),
    ];
    for (const receipt of receipts) {
      expect(JSON.stringify(receipt)).not.toContain("Private dinner");
      expect(receipt).toEqual({
        date,
        added: [expect.objectContaining({ name: "Snack", calories: 150 })],
      });
    }
    const snack = z.object({ added: z.array(entry) }).parse(receipts[0])
      .added[0];
    if (!snack) throw new Error("The snack was not added.");
    const edit = await writer.call(
      "fitness_update_meal",
      { requestId: key(), ...snack, protein: 6 },
      z.unknown(),
    );
    expect(edit).toEqual({ updated: { id: snack.id, revision: 2 } });
    const weigh = await writer.call(
      "fitness_log_weight",
      { requestId: key(), date, weight: 71, unit: "kg" },
      z.unknown(),
    );
    expect(weigh).toEqual({
      date,
      weight: expect.objectContaining({ kg: 71 }),
    });
    const removal = await writer.call(
      "fitness_delete_entries",
      { requestId: key(), entries: [{ id: snack.id, revision: 2 }] },
      z.unknown(),
    );
    expect(removal).toEqual({ deleted: [{ id: snack.id }] });

    // A full result stored for a reader stays hidden from a writer's retry.
    const shared = {
      requestId: key(),
      date,
      meals: [{ name: "Tea", calories: 5, protein: 0 }],
    };
    const full = await owner.call("fitness_add_meals", shared, added);
    expect(full.food.meals.map((m) => m.name)).toContain("Private dinner");
    const replay = await writer.call("fitness_add_meals", shared, z.unknown());
    expect(JSON.stringify(replay)).not.toContain("Private dinner");
    expect(replay).toEqual({ date, added: full.added });
  },
);

test.skipIf(!configured)(
  "agents save, edit and remove saved meals",
  async () => {
    const owner = "integration:" + crypto.randomUUID();
    try {
      const { call, failure } = await connect(owner);
      const request = {
        requestId: key(),
        savedMeals: [
          { name: "Usual breakfast", calories: 420, protein: 32 },
          { name: "usual breakfast", calories: 420, protein: 32 },
          { name: "Protein shake", calories: 180, protein: 30 },
        ],
      };
      const first = await call("fitness_add_saved_meals", request, savedAdded);
      expect(first.added.map((m) => [m.name, m.revision])).toEqual([
        ["Usual breakfast", 1],
        ["Protein shake", 1],
      ]);
      expect(first.alreadySaved.map((m) => m.id)).toEqual([first.added[0]?.id]);
      expect(first.savedMeals).toHaveLength(2);
      expect(
        await call("fitness_add_saved_meals", request, savedAdded),
      ).toEqual(first);
      const again = await call(
        "fitness_add_saved_meals",
        {
          requestId: key(),
          savedMeals: [
            { name: "USUAL BREAKFAST", calories: 420, protein: 32 },
            { name: "Usual breakfast", calories: 450, protein: 32 },
          ],
        },
        savedAdded,
      );
      expect(again.alreadySaved.map((m) => m.name)).toEqual([
        "Usual breakfast",
      ]);
      expect(again.added.map((m) => m.calories)).toEqual([450]);
      const listed = await call("fitness_list_saved_meals", {}, savedList);
      expect(listed.savedMeals).toHaveLength(3);
      const shake = listed.savedMeals.find((m) => m.name === "Protein shake");
      if (!shake) throw new Error("The shake was not saved.");
      expect(
        await failure("fitness_add_saved_meals", {
          requestId: key(),
          savedMeals: [{ name: "Too much", calories: 20000, protein: 1 }],
        }),
      ).toContain("savedMeals");
      expect(
        await failure("fitness_update_saved_meal", {
          requestId: key(),
          id: shake.id,
          revision: shake.revision + 1,
          protein: 35,
        }),
      ).toContain("changed after you read it");
      const edit = await call(
        "fitness_update_saved_meal",
        {
          requestId: key(),
          id: shake.id,
          revision: shake.revision,
          protein: 35,
        },
        z.object({ updated: meal }),
      );
      expect(edit.updated).toEqual({ ...shake, revision: 2, protein: 35 });
      const logged = await call(
        "fitness_add_meals",
        {
          requestId: key(),
          meals: [{ name: "Protein shake", calories: 180, protein: 35 }],
        },
        added,
      );
      const loggedMeal = logged.added[0];
      if (!loggedMeal) throw new Error("The meal was not logged.");
      expect(
        await failure("fitness_update_saved_meal", {
          requestId: key(),
          ...loggedMeal,
          name: "Not saved",
        }),
      ).toContain("No saved meal entry");
      expect(
        await failure("fitness_update_meal", {
          requestId: key(),
          id: shake.id,
          revision: 2,
          name: "Not logged",
        }),
      ).toContain("No meal entry");
      const removal = await call(
        "fitness_delete_entries",
        { requestId: key(), entries: [{ id: shake.id, revision: 2 }] },
        z.object({
          deleted: z.array(
            z.object({ id: z.string(), kind: z.string(), date: z.null() }),
          ),
        }),
      );
      expect(removal.deleted).toEqual([
        { id: shake.id, kind: "savedMeal", date: null },
      ]);
      const remaining = await call("fitness_list_saved_meals", {}, savedList);
      expect(remaining.savedMeals.map((m) => m.name)).toEqual([
        "Usual breakfast",
        "Usual breakfast",
      ]);
      const day = await call("fitness_get_day", {}, z.object({ food }));
      expect(day.food.meals.map((m) => m.name)).toEqual(["Protein shake"]);

      // A write-only connection cannot tell which meals are already saved.
      const writer = await connect(owner, { read: false, write: true, targets: false, plan: false });
      const receipt = await writer.call(
        "fitness_add_saved_meals",
        {
          requestId: key(),
          savedMeals: [
            { name: "Usual breakfast", calories: 420, protein: 32 },
            { name: "Late snack", calories: 200, protein: 10 },
            { name: "late snack", calories: 200, protein: 10 },
          ],
        },
        z.unknown(),
      );
      expect(receipt).toEqual({
        added: [
          expect.objectContaining({ name: "Usual breakfast", revision: 1 }),
          expect.objectContaining({ name: "Late snack", revision: 1 }),
        ],
      });
      const snack = z.object({ added: z.array(entry) }).parse(receipt).added[1];
      if (!snack) throw new Error("The snack was not saved.");
      expect(
        await writer.call(
          "fitness_update_saved_meal",
          { requestId: key(), ...snack, calories: 210 },
          z.unknown(),
        ),
      ).toEqual({ updated: { id: snack.id, revision: 2 } });
      // Without read access, a missing entry and a changed one fail alike.
      const missing = crypto.randomUUID();
      const errors = [
        await writer.failure("fitness_update_saved_meal", {
          requestId: key(),
          id: snack.id,
          revision: 1,
          calories: 1,
        }),
        await writer.failure("fitness_update_saved_meal", {
          requestId: key(),
          id: missing,
          revision: 1,
          calories: 1,
        }),
        await writer.failure("fitness_delete_entries", {
          requestId: key(),
          entries: [{ id: snack.id, revision: 1 }],
        }),
        await writer.failure("fitness_delete_entries", {
          requestId: key(),
          entries: [{ id: missing, revision: 1 }],
        }),
      ].map((message) => message.replace(missing, snack.id));
      expect(errors[0]).toBe(errors[1]);
      expect(errors[2]).toBe(errors[3]);
      expect(errors[0]).toContain("this connection's latest receipt");
      // A failed batch does not show which of its other entries matched.
      const batches = [
        await writer.failure("fitness_delete_entries", {
          requestId: key(),
          entries: [
            { id: snack.id, revision: 2 },
            { id: missing, revision: 1 },
          ],
        }),
        await writer.failure("fitness_delete_entries", {
          requestId: key(),
          entries: [
            { id: snack.id, revision: 1 },
            { id: missing, revision: 1 },
          ],
        }),
      ];
      expect(batches[0]).toBe(batches[1]);
      expect(batches[0]).not.toContain(snack.id);
      expect(batches[0]).toContain("Nothing was removed");
      const kept = await call("fitness_list_saved_meals", {}, savedList);
      expect(kept.savedMeals.find((m) => m.id === snack.id)?.revision).toBe(2);
      expect(
        await writer.failure("fitness_add_saved_meals", request),
      ).toContain("already used for a different change");
      const writerRequest = {
        requestId: key(),
        savedMeals: [{ name: "Oats", calories: 300, protein: 10 }],
      };
      await writer.call("fitness_add_saved_meals", writerRequest, z.unknown());
      expect(await failure("fitness_add_saved_meals", writerRequest)).toContain(
        "already used for a different change",
      );
      const reused = {
        requestId: key(),
        savedMeals: [{ name: "Tea", calories: 5, protein: 0 }],
      };
      await call("fitness_add_saved_meals", reused, savedAdded);
      expect(
        await failure("fitness_add_saved_meals", {
          ...reused,
          savedMeals: [{ name: "Coffee", calories: 5, protein: 0 }],
        }),
      ).toContain("already used for a different change");
    } finally {
      const sql = database();
      await sql`DELETE FROM fitness_operations WHERE owner_id=${owner}`;
      await sql`DELETE FROM fitness_records WHERE owner_id=${owner}`;
      await sql`DELETE FROM fitness_accounts WHERE owner_id=${owner}`;
    }
  },
);
