import { afterAll, beforeAll, expect, test } from "bun:test";
import { database } from "../src/server/db";
import { importHealth } from "../src/server/health";
import { healthRecordId } from "../src/server/health-export";
import { loadRecords, saveRecord } from "../src/server/store";
import { addDays, defaultSettings, localDate, settingsId } from "../src/domain";
import type { Entity } from "../src/domain";

const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
if (configured)
  process.env.DATABASE_URL = process.env.FITNESS_TEST_DATABASE_URL;
const owner = "integration:" + crypto.randomUUID();
const timezone = "Australia/Brisbane";
const today = localDate(timezone);
const day = (offset: number) => addDays(today, offset);
const at = (date: string, time: string) => `${date} ${time} +1000`;
const both = { read: true, write: true };

beforeAll(async () => {
  if (!configured) return;
  await database().unsafe(
    await Bun.file(new URL("../schema.sql", import.meta.url)).text(),
  );
  await saveRecord(owner, {
    operationId: crypto.randomUUID(),
    id: settingsId,
    revision: 0,
    data: defaultSettings(today, timezone),
  });
});
afterAll(async () => {
  if (!configured) return;
  const sql = database();
  await sql`DELETE FROM fitness_operations WHERE owner_id=${owner}`;
  await sql`DELETE FROM fitness_records WHERE owner_id=${owner}`;
  await sql`DELETE FROM fitness_accounts WHERE owner_id=${owner}`;
});

async function save(data: Entity) {
  const result = await saveRecord(owner, {
    operationId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    revision: 0,
    data,
  });
  if (result.status !== "saved" || !result.record)
    throw new Error("Not saved.");
  return result.record;
}

function exportOf(
  weights: { date: string; qty: number }[],
  workouts: object[] = [],
) {
  return {
    data: {
      metrics: [{ name: "weight_body_mass", units: "kg", data: weights }],
      workouts,
    },
  };
}
const running = (date: string, km: number, time = "06:00:00") => ({
  id: crypto.randomUUID(),
  name: "Running",
  start: at(date, time),
  end: at(date, "06:30:00"),
  duration: 1800,
  distance: { qty: km, units: "km" },
});

test.skipIf(!configured)(
  "imports weigh-ins and runs once across repeated syncs",
  async () => {
    const body = exportOf(
      [
        { date: at(day(-2), "06:00:00"), qty: 80.4 },
        { date: at(day(-2), "18:00:00"), qty: 81.1 },
        { date: at(day(-1), "06:00:00"), qty: 80.2 },
      ],
      [running(day(-1), 5.2)],
    );
    const first = await importHealth(owner, both, body);
    expect(first).toMatchObject({
      added: { weights: 2, runs: 1 },
      weights: [
        { date: day(-2), status: "added" },
        { date: day(-1), status: "added" },
      ],
      runs: [{ date: day(-1), status: "added" }],
    });
    const records = await loadRecords(owner);
    const weigh = records.find(
      (r) => r.data.kind === "weight" && r.data.date === day(-2),
    );
    expect(weigh?.id).toBe(healthRecordId("weight:" + day(-2)));
    expect(weigh?.data).toEqual({ kind: "weight", date: day(-2), kg: 80.4 });
    const run = records.find((r) => r.data.kind === "run");
    expect(run?.data).toEqual({
      kind: "run",
      date: day(-1),
      minutes: 30,
      distanceKm: 5.2,
      notes: "Apple Health",
    });

    const again = await importHealth(owner, both, body);
    expect(again).toMatchObject({
      added: { weights: 0, runs: 0 },
      weights: [
        { status: "kept", reason: "Imported in an earlier sync." },
        { status: "kept", reason: "Imported in an earlier sync." },
      ],
      runs: [{ status: "kept", reason: "Imported in an earlier sync." }],
    });
    expect(await loadRecords(owner)).toHaveLength(records.length);
  },
);

test.skipIf(!configured)(
  "keeps entries recorded or removed in Fitness",
  async () => {
    await save({ kind: "weight", date: day(-5), kg: 79 });
    await save({
      kind: "run",
      date: day(-5),
      minutes: 31,
      distanceKm: 5,
      notes: "",
    });
    const body = exportOf(
      [{ date: at(day(-5), "06:00:00"), qty: 80 }],
      [running(day(-5), 5.1), running(day(-5), 10, "17:00:00")],
    );
    const result = await importHealth(owner, both, body);
    expect(result).toMatchObject({
      added: { weights: 0, runs: 1 },
      weights: [
        {
          status: "kept",
          reason: "A weigh-in is already recorded for this date.",
        },
      ],
      runs: [
        {
          status: "kept",
          reason:
            "A run with about the same distance is already recorded for this date.",
        },
        { status: "added" },
      ],
    });
    const records = await loadRecords(owner);
    expect(
      records.find((r) => r.data.kind === "weight" && r.data.date === day(-5))
        ?.data,
    ).toEqual({ kind: "weight", date: day(-5), kg: 79 });

    const imported = records.find(
      (r) => r.data.kind === "run" && r.data.distanceKm === 10,
    );
    if (!imported) throw new Error("Expected the imported run.");
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: imported.id,
      revision: imported.revision,
      data: null,
    });
    const afterRemoval = await importHealth(owner, both, body);
    expect(afterRemoval).toMatchObject({
      added: { weights: 0, runs: 0 },
      runs: [
        { status: "kept" },
        {
          status: "kept",
          reason: "Removed in Fitness after an earlier sync.",
        },
      ],
    });
    expect((await loadRecords(owner)).some((r) => r.id === imported.id)).toBe(
      false,
    );
  },
);

test.skipIf(!configured)(
  "replies to write-only keys with the counts they sent",
  async () => {
    const result = await importHealth(
      owner,
      { read: false, write: true },
      exportOf(
        [
          { date: at(day(-8), "06:00:00"), qty: 80 },
          { date: at(day(-5), "06:00:00"), qty: 80 },
        ],
        [running(day(-8), 4)],
      ),
    );
    expect(result).toEqual({
      received: { weights: 2, runs: 1 },
      skipped: [],
    });
    const records = await loadRecords(owner);
    expect(
      records.some((r) => r.data.kind === "weight" && r.data.date === day(-8)),
    ).toBe(true);
    expect(
      records.find((r) => r.data.kind === "weight" && r.data.date === day(-5))
        ?.data,
    ).toEqual({ kind: "weight", date: day(-5), kg: 79 });
  },
);

test.skipIf(!configured)(
  "saves nothing from a payload it cannot read",
  async () => {
    const before = await loadRecords(owner);
    await expect(
      importHealth(owner, both, {
        data: {
          metrics: [
            {
              name: "weight_body_mass",
              units: "kg",
              data: [
                { date: at(day(-12), "06:00:00"), qty: 80 },
                { date: at(day(-11), "06:00:00") },
              ],
            },
          ],
        },
      }),
    ).rejects.toThrow("data.metrics.0.data.1.qty");
    expect(await loadRecords(owner)).toHaveLength(before.length);
  },
);

test.skipIf(!configured)(
  "matches each run entered in Fitness with one Health run",
  async () => {
    await save({
      kind: "run",
      date: day(-15),
      minutes: 30,
      distanceKm: 5,
      notes: "",
    });
    const body = exportOf(
      [],
      [
        running(day(-15), 5, "06:00:00"),
        running(day(-15), 5.05, "17:00:00"),
        running(day(-16), 5, "06:00:00"),
        running(day(-16), 5, "17:00:00"),
      ],
    );
    const expected = {
      added: { weights: 0, runs: 3 },
      runs: [
        { date: day(-16), status: "added" },
        { date: day(-16), status: "added" },
        {
          date: day(-15),
          status: "kept",
          reason:
            "A run with about the same distance is already recorded for this date.",
        },
        { date: day(-15), status: "added" },
      ],
    };
    expect(await importHealth(owner, both, body)).toMatchObject(expected);
    const again = await importHealth(owner, both, body);
    expect(again).toMatchObject({
      added: { weights: 0, runs: 0 },
      runs: [
        { status: "kept", reason: "Imported in an earlier sync." },
        { status: "kept", reason: "Imported in an earlier sync." },
        {
          status: "kept",
          reason:
            "A run with about the same distance is already recorded for this date.",
        },
        { status: "kept", reason: "Imported in an earlier sync." },
      ],
    });
  },
);
