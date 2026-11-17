import { afterAll, beforeAll, expect, test } from "bun:test";
import { database } from "../src/server/db";
import { loadRecords, saveRecord } from "../src/server/store";
import { defaultSettings, settingsId } from "../src/domain";
const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (configured)
  process.env.DATABASE_URL = process.env.FITNESS_TEST_DATABASE_URL;
beforeAll(async () => {
  if (configured) {
    const sql = database();
    await sql.unsafe(
      await Bun.file(new URL("../schema.sql", import.meta.url)).text(),
    );
  }
});
const ownerA = "integration:" + crypto.randomUUID(),
  ownerB = "integration:" + crypto.randomUUID();
afterAll(async () => {
  if (!configured) return;
  const sql = database();
  for (const owner of [ownerA, ownerB]) {
    await sql`DELETE FROM fitness_operations WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_records WHERE owner_id=${owner}`;
    await sql`DELETE FROM fitness_accounts WHERE owner_id=${owner}`;
  }
  await sql.end();
});
test.skipIf(!configured)(
  "real Postgres isolates owners, deduplicates retries, rejects stale writes and preserves deletion revisions",
  async () => {
    const id = crypto.randomUUID();
    const request = {
      id,
      operationId: crypto.randomUUID(),
      revision: 0,
      data: { kind: "weight", date: "2026-01-05", kg: 70 },
    };
    // Validation enters through the same function used by authenticated server actions.
    const first = await saveRecord(ownerA, {
      ...request,
      data: { kind: "weight", date: "2026-01-05", kg: 70 },
    });
    expect(first.status).toBe("saved");
    expect(
      await saveRecord(ownerA, {
        ...request,
        data: { kind: "weight", date: "2026-01-05", kg: 70 },
      }),
    ).toEqual(first);
    expect(await loadRecords(ownerB)).toEqual([]);
    expect(
      (
        await saveRecord(ownerB, {
          operationId: crypto.randomUUID(),
          id,
          revision: 1,
          data: null,
        })
      ).status,
    ).toBe("conflict");
    const results = await Promise.all(
      [71, 72].map((kg) =>
        saveRecord(ownerA, {
          id,
          operationId: crypto.randomUUID(),
          revision: 1,
          data: { kind: "weight", date: "2026-01-05", kg },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "saved")).toHaveLength(1);
    expect(results.filter((r) => r.status === "conflict")).toHaveLength(1);
    expect(
      (
        await saveRecord(ownerA, {
          id,
          operationId: crypto.randomUUID(),
          revision: 2,
          data: null,
        })
      ).status,
    ).toBe("saved");
    expect(
      (
        await saveRecord(ownerA, {
          id,
          operationId: crypto.randomUUID(),
          revision: 0,
          data: { kind: "weight", date: "2026-01-05", kg: 73 },
        })
      ).status,
    ).toBe("conflict");
    expect(await loadRecords(ownerA)).toEqual([]);
    await expect(
      saveRecord(ownerA, {
        id,
        operationId: crypto.randomUUID(),
        revision: 3,
        data: defaultSettings("2026-01-05", "UTC"),
      }),
    ).rejects.toThrow("Invalid settings");
    expect(
      (
        await saveRecord(ownerA, {
          id: settingsId,
          operationId: crypto.randomUUID(),
          revision: 0,
          data: defaultSettings("2026-01-05", "UTC"),
        })
      ).status,
    ).toBe("saved");
  },
);
