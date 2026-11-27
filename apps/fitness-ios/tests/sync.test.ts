import { describe, expect, test } from "bun:test";
import { defaultSettings, settingsId } from "@bent/fitness-contracts/domain";
import type { Mutation, RecordEntry, SaveResult } from "@bent/fitness-contracts/domain";
import { OfflineError, RejectedChange, SyncEngine } from "../src/data/sync-engine";
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
    acknowledge: (o, id, records) => {
      pending.set(o, (pending.get(o) ?? []).filter((p) => p.request.operationId !== id));
      snapshots.set(o, records);
    },
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

  test("a load that a save overtook does not roll back the saved revision", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    // Hold the next load while it still reads revision 1.
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = fitness.transport.load;
    let held = true;
    fitness.transport.load = async () => {
      const result = await load();
      if (held) {
        held = false;
        await gate;
      }
      return result;
    };
    const refresh = engine.refresh();
    expect(engine.put({ ...settings, calories: 2600 }, settingsId)).toBe(true);
    const flushing = engine.flush();
    release();
    await refresh;
    await flushing;
    const saved = engine.getState().records.find((r) => r.id === settingsId);
    expect(saved?.revision).toBe(2);
    expect(device.snapshots.get(owner)?.find((r) => r.id === settingsId)?.revision).toBe(2);
  });

  test("a refused change holds the queue until it is discarded", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const save = fitness.transport.save;
    fitness.transport.save = async (request) => {
      if (request.data?.kind === "meal" && request.data.name === "Refused")
        throw new RejectedChange("Completed workouts keep their original results.");
      return save(request);
    };
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    engine.put(meal("Refused"));
    engine.put(meal("Next"));
    await engine.flush();
    expect(engine.getState().rejected?.message).toBe("Completed workouts keep their original results.");
    expect(engine.getState().pending).toBe(2);
    // Sending again is held until the person decides.
    await engine.flush();
    expect(fitness.state.saves.filter((m) => m.data?.kind === "meal")).toHaveLength(0);
    await engine.discardRejected();
    expect(engine.getState()).toMatchObject({ rejected: null, pending: 0, error: "" });
    expect([...fitness.records.values()].filter((r) => r.data.kind === "meal").map((r) => r.data.kind === "meal" && r.data.name)).toEqual(["Next"]);
  });

  test("a stopped engine ignores late replies and refuses changes", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = fitness.transport.save;
    fitness.transport.save = async (request) => {
      await gate;
      return save(request);
    };
    engine.put(meal("Late"));
    const flushing = engine.flush();
    engine.stop();
    device.snapshots.delete(owner);
    release();
    await flushing;
    expect(device.snapshots.has(owner)).toBe(false);
    expect(engine.put(meal("After"))).toBe(false);
  });

  test("the export includes typed values kept on the iPhone", async () => {
    const engine = new SyncEngine({ owner, transport: fakeFitness([settingsRecord]).transport, storage: memoryStorage().storage });
    await engine.start();
    const exported = JSON.parse(engine.draftExport({ "workout:1:0:0:value": "12" }));
    expect(exported).toMatchObject({ format: "fitness-pending-v1", typed: { "workout:1:0:0:value": "12" } });
  });

  test("a late acknowledgement keeps a newer version a load already brought in", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = fitness.transport.save;
    fitness.transport.save = async (request) => {
      const result = await save(request);
      await gate;
      return result;
    };
    engine.put({ ...settings, calories: 2600 }, settingsId);
    const flushing = engine.flush();
    // Another device saves revision 3 and a load brings it in first.
    await new Promise((resolve) => setTimeout(resolve, 1));
    fitness.records.set(settingsId, { ...settingsRecord, revision: 3, data: { ...settings, calories: 2800 } });
    fitness.transport.save = save;
    const refreshing = engine.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await flushing;
    await refreshing;
    const shown = engine.getState().records.find((r) => r.id === settingsId);
    expect(shown?.revision).toBe(3);
    expect(device.snapshots.get(owner)?.find((r) => r.id === settingsId)?.revision).toBe(3);
  });

  test("a load that saves kept overtaking runs again once the queue is sent", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    const load = fitness.transport.load;
    let overtakes = 4;
    fitness.transport.load = async () => {
      const result = await load();
      if (overtakes-- > 0) {
        // A save lands while the load is in flight.
        engine.put(meal(`Meal ${overtakes}`));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return result;
    };
    // Another device adds a record the next load should show.
    fitness.records.set("22222222-2222-4222-8222-222222222222", {
      id: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      data: meal("From another device"),
      updatedAt: new Date(0).toISOString(),
    });
    expect(await engine.refresh()).toBe(true);
    expect(engine.getState().records.some((r) => r.data.kind === "meal" && r.data.name === "From another device")).toBe(true);
  });

  test("a save reply that crossed a load can't bring back a record removed elsewhere", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    const id = "33333333-3333-4333-8333-333333333333";
    engine.put(meal("Oats"), id);
    await engine.flush();
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = fitness.transport.save;
    fitness.transport.save = async (request) => {
      const result = await save(request);
      await gate;
      return result;
    };
    // Edit the meal; its reply is held while another device removes it and
    // the iPhone loads the account.
    engine.put({ ...meal("Oats"), calories: 450 }, id);
    const flushing = engine.flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
    fitness.records.delete(id);
    fitness.transport.save = save;
    const refreshing = engine.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await flushing;
    await refreshing;
    expect(engine.getState().records.some((r) => r.id === id)).toBe(false);
    expect(device.snapshots.get(owner)?.some((r) => r.id === id)).toBe(false);
  });

  test("a replayed save receipt can't bring back a record removed elsewhere", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    const id = "44444444-4444-4444-8444-444444444444";
    // The save reaches Fitness but its reply is lost.
    const save = fitness.transport.save;
    let lose = true;
    const receipts = new Map<string, Awaited<ReturnType<typeof save>>>();
    fitness.transport.save = async (request) => {
      const stored = receipts.get(request.operationId);
      if (stored) return stored;
      const result = await save(request);
      receipts.set(request.operationId, result);
      if (lose) {
        lose = false;
        throw new OfflineError();
      }
      return result;
    };
    engine.put(meal("Oats"), id);
    await engine.flush();
    expect(engine.getState().pending).toBe(1);
    // Another device removes it, then the iPhone reconnects and retries.
    fitness.records.delete(id);
    await engine.refresh();
    expect(engine.getState().pending).toBe(0);
    expect(engine.getState().records.some((r) => r.id === id)).toBe(false);
    expect(device.snapshots.get(owner)?.some((r) => r.id === id)).toBe(false);
  });

  test("a refused change later in the pass still reconciles an acknowledged save", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    const id = "55555555-5555-4555-8555-555555555555";
    const save = fitness.transport.save;
    // The first save lands, then another device removes the record before
    // the reply; the second change is refused.
    fitness.transport.save = async (request) => {
      if (request.data?.kind === "meal" && request.data.name === "Refused") throw new RejectedChange("Refused.");
      const result = await save(request);
      fitness.records.delete(id);
      return result;
    };
    engine.put(meal("Oats"), id);
    engine.put(meal("Refused"));
    await engine.flush();
    expect(engine.getState().rejected?.message).toBe("Refused.");
    expect(engine.getState().records.some((r) => r.id === id)).toBe(false);
    expect(device.snapshots.get(owner)?.some((r) => r.id === id)).toBe(false);
  });

  test("loads run in order, so an older load never replaces a newer one", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const device = memoryStorage();
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: device.storage });
    await engine.start();
    const id = "66666666-6666-4666-8666-666666666666";
    engine.put(meal("Oats"), id);
    await engine.flush();
    // The first load reads the record and is held; the second sees it removed.
    const load = fitness.transport.load;
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    fitness.transport.load = async () => {
      const result = await load();
      if (++calls === 1) await gate;
      return result;
    };
    const slow = engine.refresh();
    await new Promise((resolve) => setTimeout(resolve, 1));
    fitness.records.delete(id);
    // The newer refresh waits for the older load, then applies after it.
    const newer = engine.refresh();
    release();
    await slow;
    await newer;
    expect(engine.getState().records.some((r) => r.id === id)).toBe(false);
    expect(device.snapshots.get(owner)?.some((r) => r.id === id)).toBe(false);
  });

  test("a failed reconcile load keeps a refused change and its message", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: memoryStorage().storage });
    await engine.start();
    const save = fitness.transport.save;
    const load = fitness.transport.load;
    fitness.transport.save = async (request) => {
      if (request.data?.kind === "meal" && request.data.name === "Refused") throw new RejectedChange("Refused.");
      return save(request);
    };
    fitness.transport.load = async () => {
      throw new Error("Fitness had a problem. Try again shortly.");
    };
    engine.put(meal("Oats"));
    engine.put(meal("Refused"));
    await engine.flush();
    expect(engine.getState().rejected?.message).toBe("Refused.");
    expect(engine.getState().error).toContain("Fitness refused a change: Refused.");
    fitness.transport.load = load;
  });

  test("loads run in order, so the newest load's result stands after an older one fails", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: memoryStorage().storage });
    await engine.start();
    const load = fitness.transport.load;
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    fitness.transport.load = async () => {
      if (++calls === 1) {
        await gate;
        throw new OfflineError();
      }
      return load();
    };
    const slow = engine.refresh();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const newer = engine.refresh();
    release();
    expect(await slow).toBe(false);
    expect(await newer).toBe(true);
    // The newer load ran after the failed one, so its result stands.
    expect(engine.getState()).toMatchObject({ online: true, error: "", loaded: true });
  });

  test("a refusal shows at once while the reconcile load is still running", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: memoryStorage().storage });
    await engine.start();
    const save = fitness.transport.save;
    const load = fitness.transport.load;
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fitness.transport.save = async (request) => {
      if (request.data?.kind === "meal" && request.data.name === "Refused") throw new RejectedChange("Refused.");
      return save(request);
    };
    fitness.transport.load = async () => {
      await gate;
      return load();
    };
    engine.put(meal("Oats"));
    engine.put(meal("Refused"));
    const flushing = engine.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(engine.getState()).toMatchObject({ saving: false, rejected: { message: "Refused." } });
    release();
    await flushing;
    expect(engine.getState().rejected?.message).toBe("Refused.");
  });

  test("a save still waiting when the engine stops is never sent", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: memoryStorage().storage });
    await engine.start();
    const load = fitness.transport.load;
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fitness.transport.load = async () => {
      await gate;
      return load();
    };
    const refreshing = engine.refresh();
    engine.put(meal("Queued"));
    engine.stop();
    release();
    await refreshing;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fitness.state.saves).toHaveLength(0);
  });

  test("a reconcile load that succeeds after an offline refresh shows the phone online", async () => {
    const fitness = fakeFitness([settingsRecord]);
    const engine = new SyncEngine({ owner, transport: fitness.transport, storage: memoryStorage().storage });
    await engine.start();
    const save = fitness.transport.save;
    const load = fitness.transport.load;
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    fitness.transport.save = async (request) => {
      await gate;
      return save(request);
    };
    fitness.transport.load = async () => {
      if (++loads === 1) throw new OfflineError();
      return load();
    };
    engine.put(meal("Oats"));
    const flushing = engine.flush();
    // A refresh queued behind the save fails offline; the reconcile load after it succeeds.
    const refreshing = engine.refresh();
    release();
    await flushing;
    await refreshing;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(engine.getState()).toMatchObject({ online: true, error: "", pending: 0 });
  });
});
