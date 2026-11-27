import { describe, expect, test } from "bun:test";
import { defaultSettings, settingsId } from "@bent/fitness-contracts/domain";
import type { Mutation, RecordEntry, SaveResult } from "@bent/fitness-contracts/domain";
import { OfflineError, SyncEngine } from "../src/data/sync-engine";
import type { Pending, SyncStorage } from "../src/data/sync-engine";

const owner = "user_synthetic";
const settings = defaultSettings("2026-11-02", "Australia/Brisbane");
const meal = (name: string) => ({ kind: "meal" as const, date: "2026-11-20", name, calories: 400, protein: 20 });

function memoryStorage() {
  const snapshots = new Map<string, RecordEntry[]>();
  const pending = new Map<string, Pending[]>();
  const storage: SyncStorage = {
    readSnapshot: (o) => snapshots.get(o) ?? null,
    writeSnapshot: (o, records) => void snapshots.set(o, records),
    readPending: (o) => [...(pending.get(o) ?? [])],
    addPending: (o, item) => void pending.set(o, [...(pending.get(o) ?? []), item]),
    removePending: (o, id) => void pending.set(o, (pending.get(o) ?? []).filter((p) => p.request.operationId !== id)),
  };
  return { storage, snapshots, pending };
}

/** A synthetic Fitness: records by ID with revisions, and an optional outage. */
function fakeFitness(initial: RecordEntry[] = []) {
  const records = new Map(initial.map((r) => [r.id, r]));
  const saves: Mutation[] = [];
  const state = { offline: false, saves };
  const transport = {
    async load() {
      if (state.offline) throw new OfflineError();
      return { owner, records: [...records.values()] };
    },
    async save(request: Mutation): Promise<SaveResult> {
      if (state.offline) throw new OfflineError();
      state.saves.push(request);
      const current = records.get(request.id) ?? null;
      if ((current?.revision ?? 0) !== request.revision) return { status: "conflict", current };
      if (!request.data) {
        records.delete(request.id);
        return { status: "saved", record: null };
      }
      const record = { id: request.id, revision: request.revision + 1, data: request.data, updatedAt: new Date(0).toISOString() };
      records.set(request.id, record);
      return { status: "saved", record };
    },
  };
  return { transport, records, state };
}

const settingsRecord: RecordEntry = { id: settingsId, revision: 1, data: settings, updatedAt: new Date(0).toISOString() };

describe("sync engine", () => {
  test("loads the account, keeps a snapshot and saves queued changes in order", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    expect(engine.getState()).toMatchObject({ ready: true, loaded: true, pending: 0 });
    expect(engine.getState().settings?.kind).toBe("settings");
    expect(device.snapshots.get(owner)?.map((r) => r.id)).toEqual([settingsId]);

    expect(engine.put(meal("Oats"))).toBe(true);
    expect(engine.put(meal("Eggs"))).toBe(true);
    await engine.flush();
    expect(fitness.state.saves.map((s) => (s.data?.kind === "meal" ? s.data.name : null))).toEqual(["Oats", "Eggs"]);
    expect(engine.getState().pending).toBe(0);
    expect(device.pending.get(owner)).toEqual([]);
  });

  test("opens offline from the snapshot and sends queued changes when Fitness answers", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    await new SyncEngine({ owner, transport: fitness.transport, storage: device.storage }).start();

    fitness.state.offline = true;
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    expect(engine.getState()).toMatchObject({ ready: true, loaded: false, online: false, error: "" });
    expect(engine.put(meal("Toast"))).toBe(true);
    await engine.flush();
    // The change shows at once and waits on the iPhone.
    expect(engine.getState().pending).toBe(1);
    expect(engine.getState().records.some((r) => r.data.kind === "meal")).toBe(true);
    expect(device.pending.get(owner)).toHaveLength(1);

    fitness.state.offline = false;
    await engine.refresh();
    expect(engine.getState()).toMatchObject({ pending: 0, online: true, loaded: true });
    expect([...fitness.records.values()].some((r) => r.data.kind === "meal")).toBe(true);
  });

  test("a conflict stops the queue until the cloud version is chosen", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: memoryStorage().storage });
    await engine.start();
    // Another device saved settings in the meantime.
    fitness.records.set(settingsId, { ...settingsRecord, revision: 2 });
    expect(engine.put({ ...settings, calories: 2500 }, settingsId)).toBe(true);
    expect(engine.put(meal("Later"))).toBe(true);
    await engine.flush();
    const state = engine.getState();
    expect(state.conflict?.current?.revision).toBe(2);
    expect(state.error).toContain("changed on another device");
    expect(state.pending).toBe(2);
    // Editing waits until the conflict is resolved.
    expect(engine.put(meal("Blocked"))).toBe(false);

    await engine.useCloud();
    const after = engine.getState();
    expect(after.conflict).toBeNull();
    expect(after.editorReset).toBe(1);
    expect(after.pending).toBe(0);
    expect(after.settings?.calories).toBe(settings.calories);
    expect([...fitness.records.values()].filter((r) => r.data.kind === "meal")).toHaveLength(1);
  });

  test("refuses a stale editor and an invalid change without queueing", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    expect(engine.put({ ...settings, calories: 2400 }, settingsId, 0)).toBe(false);
    expect(engine.getState().error).toContain("changed since you opened it");
    expect(engine.put({ ...meal("Bad"), calories: -5 })).toBe(false);
    expect(engine.getState().error).toStartWith("This change was not saved.");
    expect(device.pending.get(owner) ?? []).toEqual([]);
  });

  test("an account mismatch stops loading", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const engine = new SyncEngine({
      owner: "user_other",
      transport: fitness.transport,
      storage: memoryStorage().storage,
    });
    await engine.start();
    expect(engine.getState()).toMatchObject({ ready: false, error: "Your account changed. Sign in again to continue." });
  });

  test("latest reflects queued changes and removals", async () => {
    const fitness = fakeFitness([settingsRecord]);
    fitness.state.offline = true;
    const device = memoryStorage();
    device.storage.writeSnapshot(owner, [settingsRecord]);
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage, uuid: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })() });
    await engine.start();
    const id = "11111111-1111-4111-8111-111111111111";
    engine.put(meal("A"), id);
    expect(engine.latest(id).revision).toBe(1);
    engine.put(null, id);
    expect(engine.latest(id)).toEqual({ revision: 2, data: null });
    expect(engine.getState().records.some((r) => r.id === id)).toBe(false);
  });
});
