import { afterAll, beforeAll, expect, test } from "bun:test";
import { database } from "../src/server/db";
import { loadRecords, saveRecord } from "../src/server/store";
import {
  addDays,
  createWorkout,
  defaultSettings,
  localDate,
  settingsId,
} from "../src/domain";
import type { Mutation, Workout } from "../src/domain";
const configured = Boolean(process.env.FITNESS_TEST_DATABASE_URL);
if (process.env.CI && !configured)
  throw new Error("FITNESS_TEST_DATABASE_URL is required in CI.");
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
  ownerB = "integration:" + crypto.randomUUID(),
  ownerC = "integration:" + crypto.randomUUID(),
  ownerD = "integration:" + crypto.randomUUID();
afterAll(async () => {
  if (!configured) return;
  const sql = database();
  for (const owner of [ownerA, ownerB, ownerC, ownerD]) {
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

test.skipIf(!configured)(
  "completed workouts reject edits, deletion and replacement",
  async () => {
    const settings = defaultSettings("2026-01-05", "UTC");
    const routine = settings.routines[0];
    if (!routine) throw new Error("Missing routine");
    const workout = createWorkout(settings, routine, "2026-01-05", true, []);
    workout.exercises.forEach((exercise) =>
      exercise.sets.forEach((set) => {
        set.done = true;
      }),
    );
    workout.finishedAt = new Date().toISOString();
    const id = crypto.randomUUID();
    expect(
      (
        await saveRecord(ownerA, {
          id,
          operationId: crypto.randomUUID(),
          revision: 0,
          data: workout,
        })
      ).status,
    ).toBe("saved");
    for (const data of [null, { ...workout, notes: "Changed result" }]) {
      await expect(
        saveRecord(ownerA, {
          id,
          operationId: crypto.randomUUID(),
          revision: 1,
          data,
        }),
      ).rejects.toThrow("Completed workouts keep their original results.");
    }
    expect(
      (await loadRecords(ownerA)).find((entry) => entry.id === id)?.data,
    ).toEqual(workout);
  },
);

function finished(date: string) {
  const settings = defaultSettings("2026-01-05", "UTC");
  const routine = settings.routines[0];
  if (!routine) throw new Error("Missing routine");
  const workout = createWorkout(settings, routine, date, false, []);
  for (const exercise of workout.exercises)
    for (const set of exercise.sets) set.done = true;
  workout.finishedAt = `${date}T08:00:00.000Z`;
  return workout;
}
function write(
  owner: string,
  id: string,
  revision: number,
  data: Mutation["data"],
) {
  return saveRecord(owner, {
    id,
    revision,
    data,
    operationId: crypto.randomUUID(),
  });
}
function correction(workoutId: string, replacement: Workout | null) {
  return {
    kind: "workoutCorrection" as const,
    workoutId,
    replacement,
    reason: "Entered the wrong weight",
  };
}

test.skipIf(!configured)(
  "workout corrections keep originals immutable, stay owner-scoped and reject duplicate or stale edits",
  async () => {
    const workoutId = crypto.randomUUID();
    const original = finished("2026-01-05");
    expect((await write(ownerC, workoutId, 0, original)).status).toBe("saved");
    const lighter = structuredClone(original);
    for (const set of lighter.exercises[0]?.sets ?? []) set.loadKg = 4;

    // Another account cannot target this workout, even with its ID.
    await expect(
      write(ownerD, crypto.randomUUID(), 0, correction(workoutId, lighter)),
    ).rejects.toThrow("Choose one of your completed workouts to correct.");
    expect(await loadRecords(ownerD)).toEqual([]);

    // Two devices creating a correction at once: one saves, one conflicts.
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    const concurrent = await Promise.all(
      [first, second].map((id) =>
        write(ownerC, id, 0, correction(workoutId, lighter)),
      ),
    );
    expect(concurrent.map((r) => r.status).sort()).toEqual([
      "conflict",
      "saved",
    ]);
    const savedIndex = concurrent.findIndex((r) => r.status === "saved");
    const active = savedIndex === 0 ? first : second;
    const other = savedIndex === 0 ? second : first;
    const duplicate = concurrent[savedIndex === 0 ? 1 : 0];
    expect(
      duplicate?.status === "conflict" ? duplicate.current?.id : null,
    ).toBe(active);
    expect(
      (await write(ownerC, other, 0, correction(workoutId, lighter))).status,
    ).toBe("conflict");

    // Stale and retargeted edits are rejected.
    expect(
      (await write(ownerC, active, 0, correction(workoutId, original))).status,
    ).toBe("conflict");
    const secondWorkout = crypto.randomUUID();
    expect(
      (await write(ownerC, secondWorkout, 0, finished("2026-01-06"))).status,
    ).toBe("saved");
    await expect(
      write(ownerC, active, 1, correction(secondWorkout, lighter)),
    ).rejects.toThrow("A correction stays linked to its original workout.");
    const renamed = { ...structuredClone(lighter), name: "Other routine" };
    await expect(
      write(ownerC, active, 1, correction(workoutId, renamed)),
    ).rejects.toThrow(
      "A correction can change the workout date, set results and notes only.",
    );

    // Drafts and other record types cannot be corrected.
    const draftId = crypto.randomUUID();
    const draft = { ...finished("2026-01-07"), finishedAt: null };
    for (const exercise of draft.exercises)
      for (const set of exercise.sets) set.done = false;
    expect((await write(ownerC, draftId, 0, draft)).status).toBe("saved");
    await expect(
      write(ownerC, crypto.randomUUID(), 0, correction(draftId, lighter)),
    ).rejects.toThrow("Choose one of your completed workouts to correct.");

    // Removing, then restoring, never changes the original record.
    expect(
      (await write(ownerC, active, 1, correction(workoutId, null))).status,
    ).toBe("saved");
    for (const data of [null, { ...original, notes: "Changed" }])
      await expect(write(ownerC, workoutId, 1, data)).rejects.toThrow(
        "Completed workouts keep their original results.",
      );
    expect((await write(ownerC, active, 2, null)).status).toBe("saved");
    const restored = await loadRecords(ownerC);
    expect(restored.find((r) => r.id === workoutId)?.data).toEqual(original);
    expect(restored.some((r) => r.data.kind === "workoutCorrection")).toBe(
      false,
    );
    // After a restore, a new correction can be made.
    expect(
      (
        await write(
          ownerC,
          crypto.randomUUID(),
          0,
          correction(workoutId, lighter),
        )
      ).status,
    ).toBe("saved");
  },
);

test.skipIf(!configured)(
  "activity dates cannot be after the owner's local day, and existing drafts stay editable",
  async () => {
    const zone = "Pacific/Kiritimati";
    const settings = defaultSettings("2026-01-05", zone);
    expect((await write(ownerD, settingsId, 0, settings)).status).toBe("saved");
    const today = localDate(zone);
    const tomorrow = addDays(today, 1);
    const run = (date: string) => ({
      kind: "run" as const,
      date,
      minutes: 20,
      distanceKm: 3,
      notes: "",
    });
    expect(
      (await write(ownerD, crypto.randomUUID(), 0, run(today))).status,
    ).toBe("saved");
    await expect(
      write(ownerD, crypto.randomUUID(), 0, run(tomorrow)),
    ).rejects.toThrow("Record training on today or an earlier date.");
    // An owner on UTC is a day behind Kiritimati for most of the UTC day.
    if (today > localDate("UTC"))
      await expect(
        write(ownerC, crypto.randomUUID(), 0, run(today)),
      ).rejects.toThrow("Record training on today or an earlier date.");
    const future = { ...finished(tomorrow), finishedAt: null };
    for (const exercise of future.exercises)
      for (const set of exercise.sets) set.done = false;
    await expect(write(ownerD, crypto.randomUUID(), 0, future)).rejects.toThrow(
      "Record training on today or an earlier date.",
    );
    const workoutId = crypto.randomUUID();
    const original = finished(today);
    expect((await write(ownerD, workoutId, 0, original)).status).toBe("saved");
    const moved = { ...structuredClone(original), date: tomorrow };
    await expect(
      write(ownerD, crypto.randomUUID(), 0, correction(workoutId, moved)),
    ).rejects.toThrow("Record training on today or an earlier date.");
    const earlier = { ...structuredClone(original), date: addDays(today, -1) };
    expect(
      (
        await write(
          ownerD,
          crypto.randomUUID(),
          0,
          correction(workoutId, earlier),
        )
      ).status,
    ).toBe("saved");
    // A draft created before this rule keeps its date and can still be saved.
    const legacyId = crypto.randomUUID();
    const sql = database();
    await sql`INSERT INTO fitness_records(owner_id,id,revision,data,deleted) VALUES(${ownerD},${legacyId},1,${sql.json(future)},false)`;
    const updated = { ...future, notes: "Still editable" };
    expect((await write(ownerD, legacyId, 1, updated)).status).toBe("saved");
    await expect(
      write(ownerD, legacyId, 2, { ...updated, date: addDays(tomorrow, 1) }),
    ).rejects.toThrow("Record training on today or an earlier date.");
  },
);
