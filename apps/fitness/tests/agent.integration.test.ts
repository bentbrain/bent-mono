import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { database } from "../src/server/db";
import { createFitnessMcpServer } from "../src/server/mcp";
import {
  BatchConflict,
  loadRecords,
  saveRecord,
  saveRecords,
} from "../src/server/store";
import { addDays, defaultSettings, localDate, settingsId } from "../src/domain";
const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
if (configured)
  process.env.DATABASE_URL = process.env.FITNESS_TEST_DATABASE_URL;
const ownerA = "integration:" + crypto.randomUUID(),
  ownerB = "integration:" + crypto.randomUUID();
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
});
afterAll(async () => {
  if (!configured) return;
  const sql = database();
  for (const owner of [ownerA, ownerB]) {
    await sql`DELETE FROM fitness_operations WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_records WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_accounts WHERE owner_id=${owner}`;
  }
});

async function connect(owner: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([
    createFitnessMcpServer(owner).connect(serverSide),
    client.connect(clientSide),
  ]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return {
      error: result.isError ? (content[0]?.text ?? "") : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool output is checked by assertions
      data: result.structuredContent as any,
    };
  };
}

test.skipIf(!configured)(
  "agents log, edit and remove food for their own account",
  async () => {
    const call = await connect(ownerA);
    const empty = await call("fitness_get_day");
    expect(empty.data).toMatchObject({
      date: today,
      timezone,
      units: "lb",
      targets: { calories: 2400, protein: 120 },
      food: { meals: [], totals: { calories: 0, protein: 0 } },
    });
    expect(empty.data.plan.type).toBeDefined();

    const added = await call("fitness_add_meals", {
      meals: [
        { name: "Porridge with berries", calories: 420, protein: 14 },
        { name: "Chicken wrap", calories: 610, protein: 42.5 },
      ],
    });
    expect(added.error).toBeNull();
    expect(added.data.added).toHaveLength(2);
    expect(added.data.food.totals).toEqual({ calories: 1030, protein: 56.5 });
    expect(added.data.food.remaining).toEqual({
      calories: 1370,
      protein: 63.5,
    });

    const wrap = added.data.added[1].id;
    const updated = await call("fitness_update_meal", {
      id: wrap,
      calories: 650,
    });
    expect(updated.data.updated).toEqual({
      id: wrap,
      name: "Chicken wrap",
      calories: 650,
      protein: 42.5,
    });
    expect(updated.data.food.totals.calories).toBe(1070);

    const yesterday = addDays(today, -1);
    const moved = await call("fitness_update_meal", {
      id: wrap,
      date: yesterday,
    });
    expect(moved.data.food.meals.map((m: { id: string }) => m.id)).toEqual([
      wrap,
    ]);
    const history = await call("fitness_get_history", { from: yesterday });
    expect(
      history.data.days.map((d: { calories: number }) => d.calories),
    ).toEqual([650, 420]);

    const removed = await call("fitness_delete_entries", { ids: [wrap] });
    expect(removed.data.deleted).toEqual([
      { id: wrap, kind: "meal", date: yesterday },
    ]);
    expect(
      (await call("fitness_get_day", { date: yesterday })).data.food,
    ).toMatchObject({ meals: [] });

    const invalid = await call("fitness_add_meals", {
      meals: [{ name: "Too much", calories: 20000, protein: 1 }],
    });
    expect(invalid.error).toContain("calories");
  },
);

test.skipIf(!configured)(
  "weigh-ins replace the day's value and runs follow the date rules",
  async () => {
    const call = await connect(ownerA);
    const first = await call("fitness_log_weight", { weight: 176.4 });
    expect(first.data).toMatchObject({
      replaced: false,
      weight: { display: "176.4 lb" },
    });
    expect(first.data.weight.kg).toBeCloseTo(80.01, 2);
    const second = await call("fitness_log_weight", {
      weight: 79.5,
      unit: "kg",
    });
    expect(second.data).toMatchObject({
      replaced: true,
      weight: { kg: 79.5 },
    });
    const weights = (await loadRecords(ownerA)).filter(
      (r) => r.data.kind === "weight",
    );
    expect(weights).toHaveLength(1);

    const run = await call("fitness_log_run", {
      minutes: 31,
      distanceKm: 5.2,
    });
    expect(run.error).toBeNull();
    const future = await call("fitness_log_run", {
      date: addDays(today, 2),
      minutes: 30,
      distanceKm: 5,
    });
    expect(future.error).toContain("today or an earlier date");
    const day = await call("fitness_get_day");
    expect(day.data.runs).toEqual([
      { id: run.data.run.id, minutes: 31, distanceKm: 5.2, notes: "" },
    ]);
    expect(day.data.weight.kg).toBe(79.5);
  },
);

test.skipIf(!configured)(
  "agents only reach the authenticated account",
  async () => {
    const own = await connect(ownerA);
    const meal = (
      await own("fitness_add_meals", {
        meals: [{ name: "Apple", calories: 95, protein: 0.5 }],
      })
    ).data.added[0].id;
    const other = await connect(ownerB);
    const day = await other("fitness_get_day");
    expect(day.data.food.meals).toEqual([]);
    expect(day.data.targets).toBeNull();
    const update = await other("fitness_update_meal", {
      id: meal,
      calories: 1,
    });
    expect(update.error).toContain("No meal entry has that ID");
    const remove = await other("fitness_delete_entries", { ids: [meal] });
    expect(remove.error).toContain("No meal, run, weight entry");
    expect((await loadRecords(ownerA)).some((r) => r.id === meal)).toBeTrue();
  },
);

test.skipIf(!configured)(
  "a conflicting change rolls back the whole batch",
  async () => {
    const before = (await loadRecords(ownerB)).length;
    const stale = await saveRecord(ownerB, {
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
    if (stale.status !== "saved" || !stale.record) throw new Error("setup");
    const attempt = saveRecords(ownerB, [
      {
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
      },
      {
        operationId: crypto.randomUUID(),
        id: stale.record.id,
        revision: 0,
        data: null,
      },
    ]);
    expect(attempt).rejects.toBeInstanceOf(BatchConflict);
    await attempt.catch(() => undefined);
    const after = await loadRecords(ownerB);
    expect(after).toHaveLength(before + 1);
    expect(
      after.some((r) => r.data.kind === "meal" && r.data.name === "Eggs"),
    ).toBeFalse();
  },
);
