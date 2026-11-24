import { afterAll, beforeAll, expect, test } from "bun:test";
import { database } from "../src/server/db";
import { importHealth, readImportBody } from "../src/server/health";
import { healthChange, loadRecords, saveRecord } from "../src/server/store";
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
  await sql`DELETE FROM fitness_health_samples WHERE owner_id=${owner}`;
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
    // Record IDs are random; the sample links live in their own table.
    expect(weigh?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    const [link] =
      await database()`SELECT record_id, matched FROM fitness_health_samples WHERE owner_id=${owner} AND sample=${"weight:" + new Date(`${day(-2)}T06:00:00+10:00`).toISOString()}`;
    expect(link).toEqual({ record_id: weigh?.id, matched: false });
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
    expect(result).toEqual({ received: { weights: 2, runs: 1 } });
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
          reason: `Matched to the run on ${day(-15)} in an earlier sync.`,
        },
        { status: "kept", reason: "Imported in an earlier sync." },
      ],
    });
  },
);

test.skipIf(!configured)(
  "keeps a run match across separate uploads and after removal",
  async () => {
    const manual = await save({
      kind: "run",
      date: day(-20),
      minutes: 30,
      distanceKm: 5,
      notes: "",
    });
    const morning = exportOf([], [running(day(-20), 5, "06:00:00")]);
    const evening = exportOf([], [running(day(-20), 5.05, "17:00:00")]);
    const matched =
      "A run with about the same distance is already recorded for this date.";
    expect(await importHealth(owner, both, morning)).toMatchObject({
      runs: [{ status: "kept", reason: matched }],
    });
    expect(await importHealth(owner, both, evening)).toMatchObject({
      runs: [{ status: "added" }],
    });
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: manual.id,
      revision: manual.revision,
      data: null,
    });
    expect(await importHealth(owner, both, morning)).toMatchObject({
      added: { runs: 0 },
      runs: [
        { status: "kept", reason: "Removed in Fitness after an earlier sync." },
      ],
    });
    const runs = (await loadRecords(owner)).filter(
      (r) => r.data.kind === "run" && r.data.date === day(-20),
    );
    expect(runs).toHaveLength(1);
  },
);

test.skipIf(!configured)(
  "keeps a weigh-in's link when the account timezone changes",
  async () => {
    // 23:30 UTC falls on the next day in Brisbane.
    const sample = `${day(-25)}T23:30:00Z`;
    const body = exportOf([{ date: sample, qty: 82 }]);
    expect(await importHealth(owner, both, body)).toMatchObject({
      weights: [{ date: day(-24), status: "added" }],
    });
    const records = await loadRecords(owner);
    const settings = records.find((r) => r.id === settingsId);
    if (settings?.data.kind !== "settings") throw new Error("No settings.");
    const utc = await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: settings.revision,
      data: { ...settings.data, timezone: "UTC" },
    });
    expect(await importHealth(owner, both, body)).toMatchObject({
      added: { weights: 0 },
      weights: [
        {
          date: day(-25),
          status: "kept",
          reason: "Imported in an earlier sync.",
        },
      ],
    });
    expect(
      (await loadRecords(owner)).filter(
        (r) =>
          r.data.kind === "weight" &&
          (r.data.date === day(-25) || r.data.date === day(-24)),
      ),
    ).toHaveLength(1);
    if (utc.status !== "saved" || !utc.record) throw new Error("Not saved.");
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: utc.record.revision,
      data: settings.data,
    });
  },
);

test("stops reading a body at the size limit", async () => {
  const chunk = new Uint8Array(1_000_000).fill(32);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent++;
      if (sent > 10) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const request = new Request(
    "https://fitness.example.invalid/api/health/import",
    {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit,
  );
  expect(await readImportBody(request)).toBeNull();
  expect(sent).toBeLessThan(10);
  const small = new Request(
    "https://fitness.example.invalid/api/health/import",
    {
      method: "POST",
      body: '{"data":{}}',
    },
  );
  expect(await readImportBody(small)).toBe('{"data":{}}');
});

test.skipIf(!configured)(
  "decides each weigh-in sample on its own after a timezone change",
  async () => {
    // 23:30 UTC on day -30 is day -29 in Brisbane.
    const late = { date: `${day(-30)}T23:30:00Z`, qty: 83 };
    const morning = { date: `${day(-30)}T06:00:00Z`, qty: 82.5 };
    expect(await importHealth(owner, both, exportOf([late]))).toMatchObject({
      weights: [{ date: day(-29), status: "added" }],
    });
    const settings = (await loadRecords(owner)).find(
      (r) => r.id === settingsId,
    );
    if (settings?.data.kind !== "settings") throw new Error("No settings.");
    const utc = await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: settings.revision,
      data: { ...settings.data, timezone: "UTC" },
    });
    expect(
      await importHealth(owner, both, exportOf([late, morning])),
    ).toMatchObject({ weights: [{ date: day(-30), status: "added" }] });
    const weighIns = (await loadRecords(owner)).filter(
      (r) =>
        r.data.kind === "weight" &&
        (r.data.date === day(-30) || r.data.date === day(-29)),
    );
    expect(weighIns.map((r) => r.data)).toEqual(
      expect.arrayContaining([
        { kind: "weight", date: day(-30), kg: 82.5 },
        { kind: "weight", date: day(-29), kg: 83 },
      ]),
    );
    expect(await importHealth(owner, both, exportOf([morning]))).toMatchObject({
      weights: [{ status: "kept", reason: "Imported in an earlier sync." }],
    });
    if (utc.status !== "saved" || !utc.record) throw new Error("Not saved.");
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: utc.record.revision,
      data: settings.data,
    });
  },
);

test.skipIf(!configured)(
  "reports a removed match as removed and keeps it removed",
  async () => {
    const manual = await save({
      kind: "run",
      date: day(-35),
      minutes: 30,
      distanceKm: 8,
      notes: "",
    });
    const body = exportOf([], [running(day(-35), 8)]);
    await importHealth(owner, both, body);
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: manual.id,
      revision: manual.revision,
      data: null,
    });
    expect(await importHealth(owner, both, body)).toMatchObject({
      added: { runs: 0 },
      runs: [
        { status: "kept", reason: "Removed in Fitness after an earlier sync." },
      ],
    });
  },
);

test.skipIf(!configured)(
  "imports a payload once when two uploads run together",
  async () => {
    const body = exportOf(
      [{ date: at(day(-40), "06:00:00"), qty: 81 }],
      [running(day(-40), 6)],
    );
    const results = await Promise.all([
      importHealth(owner, both, body),
      importHealth(owner, both, body),
    ]);
    expect(
      results
        .map((r) => ("added" in r ? r.added : null))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      { weights: 0, runs: 0 },
      { weights: 1, runs: 1 },
    ]);
    const records = (await loadRecords(owner)).filter(
      (r) =>
        (r.data.kind === "weight" || r.data.kind === "run") &&
        r.data.date === day(-40),
    );
    expect(records).toHaveLength(2);
  },
);

test.skipIf(!configured)(
  "keeps a removal on its own date after a timezone change",
  async () => {
    // 23:30 UTC on day -45 is day -44 in Brisbane.
    const late = { date: `${day(-45)}T23:30:00Z`, qty: 83 };
    const morning = { date: `${day(-45)}T06:00:00Z`, qty: 82.5 };
    await importHealth(owner, both, exportOf([late]));
    const imported = (await loadRecords(owner)).find(
      (r) => r.data.kind === "weight" && r.data.date === day(-44),
    );
    if (!imported) throw new Error("Expected the imported weigh-in.");
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: imported.id,
      revision: imported.revision,
      data: null,
    });
    const settings = (await loadRecords(owner)).find(
      (r) => r.id === settingsId,
    );
    if (settings?.data.kind !== "settings") throw new Error("No settings.");
    const utc = await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: settings.revision,
      data: { ...settings.data, timezone: "UTC" },
    });
    expect(
      await importHealth(owner, both, exportOf([late, morning])),
    ).toMatchObject({ weights: [{ date: day(-45), status: "added" }] });
    expect(await importHealth(owner, both, exportOf([late]))).toMatchObject({
      added: { weights: 0 },
      weights: [
        { status: "kept", reason: "Removed in Fitness after an earlier sync." },
      ],
    });
    const weighIns = (await loadRecords(owner)).filter(
      (r) =>
        r.data.kind === "weight" &&
        (r.data.date === day(-45) || r.data.date === day(-44)),
    );
    expect(weighIns.map((r) => r.data)).toEqual([
      { kind: "weight", date: day(-45), kg: 82.5 },
    ]);
    if (utc.status !== "saved" || !utc.record) throw new Error("Not saved.");
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: settingsId,
      revision: utc.record.revision,
      data: settings.data,
    });
  },
);

async function withTimezone(zone: string) {
  const settings = (await loadRecords(owner)).find((r) => r.id === settingsId);
  if (settings?.data.kind !== "settings") throw new Error("No settings.");
  await saveRecord(owner, {
    operationId: crypto.randomUUID(),
    id: settingsId,
    revision: settings.revision,
    data: { ...settings.data, timezone: zone },
  });
}

test.skipIf(!configured)(
  "reports a live weigh-in on its date when an old link was removed",
  async () => {
    // 23:30 UTC on day -50 is day -49 in Brisbane.
    const late = { date: `${day(-50)}T23:30:00Z`, qty: 83 };
    const next = { date: at(day(-49), "06:00:00"), qty: 82 };
    await withTimezone("UTC");
    await importHealth(owner, both, exportOf([late]));
    const imported = (await loadRecords(owner)).find(
      (r) => r.data.kind === "weight" && r.data.date === day(-50),
    );
    if (!imported) throw new Error("Expected the imported weigh-in.");
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: imported.id,
      revision: imported.revision,
      data: null,
    });
    await withTimezone(timezone);
    const body = exportOf([late, next]);
    expect(await importHealth(owner, both, body)).toMatchObject({
      weights: [{ date: day(-49), status: "added" }],
    });
    expect(await importHealth(owner, both, body)).toMatchObject({
      weights: [
        {
          date: day(-49),
          status: "kept",
          reason: "Imported in an earlier sync.",
        },
      ],
    });
    expect(await importHealth(owner, both, exportOf([late]))).toMatchObject({
      weights: [
        { status: "kept", reason: "Removed in Fitness after an earlier sync." },
      ],
    });
  },
);

test.skipIf(!configured)(
  "reads link dates as ISO dates under any DateStyle",
  async () => {
    const sample = "weight:datestyle-" + crypto.randomUUID();
    const links = await database().begin(async (sql) => {
      await sql`SET LOCAL DateStyle = 'SQL, MDY'`;
      const change = healthChange(sql, owner);
      await change.link([
        {
          sample,
          recordId: crypto.randomUUID(),
          date: "2026-10-18",
          matched: false,
          revision: null,
          distanceKm: null,
          minutes: null,
        },
      ]);
      return change.links([sample]);
    });
    expect(links.get(sample)?.date).toBe("2026-10-18");
  },
);

test.skipIf(!configured)(
  "matches new samples to a weigh-in entered after removing an import",
  async () => {
    const first = { date: at(day(-55), "06:00:00"), qty: 84 };
    const later = { date: at(day(-55), "19:00:00"), qty: 84.6 };
    await importHealth(owner, both, exportOf([first]));
    const imported = (await loadRecords(owner)).find(
      (r) => r.data.kind === "weight" && r.data.date === day(-55),
    );
    if (!imported) throw new Error("Expected the imported weigh-in.");
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: imported.id,
      revision: imported.revision,
      data: null,
    });
    await save({ kind: "weight", date: day(-55), kg: 83.5 });
    const weighIn = "A weigh-in is already recorded for this date.";
    expect(
      await importHealth(owner, both, exportOf([first, later])),
    ).toMatchObject({ weights: [{ status: "kept", reason: weighIn }] });
    expect(await importHealth(owner, both, exportOf([later]))).toMatchObject({
      weights: [
        {
          status: "kept",
          reason: `Matched to the weigh-in on ${day(-55)} in an earlier sync.`,
        },
      ],
    });
    expect(await importHealth(owner, both, exportOf([first]))).toMatchObject({
      weights: [
        { status: "kept", reason: "Removed in Fitness after an earlier sync." },
      ],
    });
  },
);

test.skipIf(!configured)(
  "matches a Health run exactly 100 m from an entered run",
  async () => {
    await save({
      kind: "run",
      date: day(-60),
      minutes: 6,
      distanceKm: 1,
      notes: "",
    });
    const result = await importHealth(
      owner,
      both,
      exportOf(
        [],
        [{ ...running(day(-60), 1.1), distance: { qty: 1100, units: "m" } }],
      ),
    );
    expect(result).toMatchObject({ added: { runs: 0 } });
  },
);

test.skipIf(!configured)(
  "compares run distances at full precision",
  async () => {
    await save({
      kind: "run",
      date: day(-65),
      minutes: 6,
      distanceKm: 1,
      notes: "",
    });
    await save({
      kind: "run",
      date: day(-66),
      minutes: 25,
      distanceKm: 4.8,
      notes: "",
    });
    const metres = (date: string, m: number) => ({
      ...running(date, 0),
      distance: { qty: m, units: "m" },
    });
    expect(
      await importHealth(owner, both, exportOf([], [metres(day(-65), 1100.1)])),
    ).toMatchObject({ added: { runs: 1 } });
    expect(
      await importHealth(owner, both, exportOf([], [metres(day(-66), 5052.6)])),
    ).toMatchObject({ added: { runs: 0 } });
    const saved = (await loadRecords(owner)).find(
      (r) =>
        r.data.kind === "run" &&
        r.data.date === day(-65) &&
        r.data.notes === "Apple Health",
    );
    expect(saved?.data).toMatchObject({ distanceKm: 1.1 });
  },
);

test.skipIf(!configured)(
  "names the entry's date when a match was made under another timezone",
  async () => {
    // 23:30 UTC on day -70 is day -69 in Brisbane.
    const weighIn = { date: `${day(-70)}T23:30:00Z`, qty: 80 };
    const run = {
      ...running(day(-69), 7),
      start: `${day(-70)}T23:30:00Z`,
    };
    await save({ kind: "weight", date: day(-69), kg: 79.5 });
    await save({
      kind: "run",
      date: day(-69),
      minutes: 40,
      distanceKm: 7,
      notes: "",
    });
    await importHealth(owner, both, exportOf([weighIn], [run]));
    await withTimezone("UTC");
    expect(
      await importHealth(owner, both, exportOf([weighIn], [run])),
    ).toMatchObject({
      weights: [
        {
          date: day(-70),
          status: "kept",
          reason: `Matched to the weigh-in on ${day(-69)} in an earlier sync.`,
        },
      ],
      runs: [
        {
          date: day(-70),
          status: "kept",
          reason: `Matched to the run on ${day(-69)} in an earlier sync.`,
        },
      ],
    });
    await withTimezone(timezone);
  },
);

test.skipIf(!configured)(
  "describes a replayed match as the earlier decision after an edit",
  async () => {
    const entered = await save({
      kind: "run",
      date: day(-75),
      minutes: 30,
      distanceKm: 5,
      notes: "",
    });
    const body = exportOf([], [running(day(-75), 5)]);
    await importHealth(owner, both, body);
    await saveRecord(owner, {
      operationId: crypto.randomUUID(),
      id: entered.id,
      revision: entered.revision,
      data: {
        kind: "run",
        date: day(-76),
        minutes: 45,
        distanceKm: 8,
        notes: "",
      },
    });
    expect(await importHealth(owner, both, body)).toMatchObject({
      added: { runs: 0 },
      runs: [
        {
          date: day(-75),
          status: "kept",
          reason: `Matched to the run on ${day(-75)} in an earlier sync.`,
        },
      ],
    });
  },
);

test.skipIf(!configured)(
  "pairs a day's runs so a later run keeps its only match",
  async () => {
    await save({
      kind: "run",
      date: day(-80),
      minutes: 28,
      distanceKm: 5,
      notes: "",
    });
    await save({
      kind: "run",
      date: day(-80),
      minutes: 30,
      distanceKm: 5.3,
      notes: "",
    });
    const body = exportOf(
      [],
      [running(day(-80), 5.05, "06:00:00"), running(day(-80), 5.3, "17:00:00")],
    );
    expect(await importHealth(owner, both, body)).toMatchObject({
      added: { runs: 0 },
    });
    expect(await importHealth(owner, both, body)).toMatchObject({
      added: { runs: 0 },
    });
    expect(
      (await loadRecords(owner)).filter(
        (r) => r.data.kind === "run" && r.data.date === day(-80),
      ),
    ).toHaveLength(2);
  },
);

test.skipIf(!configured)(
  "moves an earlier match when a later upload needs it",
  async () => {
    await save({
      kind: "run",
      date: day(-85),
      minutes: 28,
      distanceKm: 5,
      notes: "",
    });
    await save({
      kind: "run",
      date: day(-85),
      minutes: 30,
      distanceKm: 5.3,
      notes: "",
    });
    const early = running(day(-85), 5.21, "06:00:00");
    const late = running(day(-85), 5.48, "17:00:00");
    expect(
      await importHealth(owner, both, exportOf([], [early])),
    ).toMatchObject({ added: { runs: 0 } });
    expect(
      await importHealth(owner, both, exportOf([], [early, late])),
    ).toMatchObject({ added: { runs: 0 } });
    expect(
      await importHealth(owner, both, exportOf([], [early, late])),
    ).toMatchObject({ added: { runs: 0 } });
    expect(
      (await loadRecords(owner)).filter(
        (r) => r.data.kind === "run" && r.data.date === day(-85),
      ),
    ).toHaveLength(2);
  },
);

test.skipIf(!configured)("keeps a match to a run edited since", async () => {
  const edited = await save({
    kind: "run",
    date: day(-90),
    minutes: 30,
    distanceKm: 5.3,
    notes: "",
  });
  await save({
    kind: "run",
    date: day(-90),
    minutes: 28,
    distanceKm: 5,
    notes: "",
  });
  await importHealth(owner, both, exportOf([], [running(day(-90), 5.21)]));
  await saveRecord(owner, {
    operationId: crypto.randomUUID(),
    id: edited.id,
    revision: edited.revision,
    data: {
      kind: "run",
      date: day(-90),
      minutes: 31,
      distanceKm: 5.3,
      notes: "Hills",
    },
  });
  // The 5.48 km run can only match the edited run, whose match stays.
  expect(
    await importHealth(
      owner,
      both,
      exportOf([], [running(day(-90), 5.48, "17:00:00")]),
    ),
  ).toMatchObject({ added: { runs: 1 } });
});

test.skipIf(!configured)(
  "saves a run that only nearly matches when another fits exactly",
  async () => {
    await save({
      kind: "run",
      date: day(-95),
      minutes: 30,
      distanceKm: 5,
      notes: "",
    });
    const body = exportOf(
      [],
      [running(day(-95), 5.2, "06:00:00"), running(day(-95), 5, "17:00:00")],
    );
    expect(await importHealth(owner, both, body)).toMatchObject({
      added: { runs: 1 },
      runs: [{ status: "added" }, { status: "kept" }],
    });
    const runs = (await loadRecords(owner)).filter(
      (r) => r.data.kind === "run" && r.data.date === day(-95),
    );
    expect(
      runs.map((r) => r.data.kind === "run" && r.data.distanceKm).sort(),
    ).toEqual([5, 5.2]);
  },
);

for (const later of ["both runs", "the exact run alone"] as const)
  test.skipIf(!configured)(
    `saves an earlier weaker match when ${later} arrives later`,
    async () => {
      const date = later === "both runs" ? day(-100) : day(-101);
      await save({ kind: "run", date, minutes: 30, distanceKm: 5, notes: "" });
      const morning = running(date, 5.2, "06:00:00");
      const evening = running(date, 5, "17:00:00");
      expect(
        await importHealth(owner, both, exportOf([], [morning])),
      ).toMatchObject({ added: { runs: 0 } });
      const body = exportOf(
        [],
        later === "both runs" ? [morning, evening] : [evening],
      );
      expect(await importHealth(owner, both, body)).toMatchObject({
        added: { runs: 1 },
      });
      expect(
        await importHealth(owner, both, exportOf([], [morning, evening])),
      ).toMatchObject({ added: { runs: 0 } });
      const runs = (await loadRecords(owner)).filter(
        (r) => r.data.kind === "run" && r.data.date === date,
      );
      expect(runs.map((r) => (r.data.kind === "run" ? r.data : null))).toEqual(
        expect.arrayContaining([
          { kind: "run", date, minutes: 30, distanceKm: 5, notes: "" },
          {
            kind: "run",
            date,
            minutes: 30,
            distanceKm: 5.2,
            notes: "Apple Health",
          },
        ]),
      );
      expect(runs).toHaveLength(2);
    },
  );
