import { z } from "zod";
import { mutationSchema, recordSchema, settingsId } from "@bent/fitness-contracts/domain";
import type { Entity, Mutation, RecordEntry, SaveResult, Settings } from "@bent/fitness-contracts/domain";

/**
 * The account's records on this iPhone, kept in step with Fitness.
 *
 * This follows the web app's sync: every change is a mutation with the
 * record's expected revision and a new operation ID, queued on the device
 * and sent in order. A queued change shows at once. A save Fitness reports
 * as a conflict stops the queue until the user chooses the cloud version.
 * The iPhone also keeps the last records it loaded, so the app opens with
 * them offline and edits wait in the queue until Fitness answers.
 */
export const pendingSchema = z.object({ request: mutationSchema, at: z.number() });
export type Pending = z.infer<typeof pendingSchema>;

export type Transport = {
  /** `contract` is the newest records contract Fitness stores; Fitness releases that leave it out store 1. */
  load(): Promise<{ owner: string; records: RecordEntry[]; contract?: number }>;
  save(request: Mutation): Promise<SaveResult>;
};

/** Device storage for one account's snapshot and queue. */
export type SyncStorage = {
  readSnapshot(owner: string): RecordEntry[] | null;
  writeSnapshot(owner: string, records: RecordEntry[]): void;
  readPending(owner: string): Pending[];
  addPending(owner: string, item: Pending): void;
  removePending(owner: string, operationId: string): void;
  /** Removes a saved change from the queue and stores the records it produced, together. */
  acknowledge(owner: string, operationId: string, records: RecordEntry[]): void;
};

/** Thrown by a transport when Fitness could not be reached. */
export class OfflineError extends Error {
  constructor() {
    super("Fitness could not be reached. Changes stay on this iPhone until you're online.");
  }
}

/** Thrown for work that was waiting when the engine stopped; it never reached Fitness. */
class StoppedError extends Error {}

/**
 * Thrown by a transport when Fitness refused a change for good, such as an
 * edit to a finished workout. Sending it again would be refused again.
 */
export class RejectedChange extends Error {}

export type SyncState = {
  /** Cloud records with queued changes applied. */
  records: RecordEntry[];
  /** True once records are available, from Fitness or from this iPhone. */
  ready: boolean;
  /** True once Fitness answered a load in this session. */
  loaded: boolean;
  /** The newest records contract Fitness stores, from its last answer in this session; 1 until then. */
  storedContract: number;
  error: string;
  conflict: (SaveResult & { status: "conflict" }) | null;
  pending: number;
  saving: boolean;
  online: boolean;
  /** Changes when editors should drop their local state and reload. */
  editorReset: number;
  settings: Settings | undefined;
  /** The queued change Fitness refused, which holds the queue until it is discarded. */
  rejected: { operationId: string; message: string } | null;
};

type Options = { owner: string; transport: Transport; storage: SyncStorage; now?: () => number; uuid?: () => string };

export class SyncEngine {
  private readonly owner: string;
  private readonly transport: Transport;
  private readonly storage: SyncStorage;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private cloud: RecordEntry[] = [];
  private queue: Pending[] = [];
  private flushing: Promise<void> | null = null;
  /**
   * Loads and saves run one at a time, in the order requested. A load then
   * reflects every save acknowledged before it, and an acknowledgement is
   * newer than every load applied before it.
   */
  private lane: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private conflictId: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SyncState;
  private base: Omit<SyncState, "records" | "pending" | "settings"> = {
    ready: false,
    loaded: false,
    storedContract: 1,
    error: "",
    conflict: null,
    saving: false,
    online: true,
    editorReset: 0,
    rejected: null,
  };

  constructor({ owner, transport, storage, now = Date.now, uuid = () => crypto.randomUUID() }: Options) {
    this.owner = owner;
    this.transport = transport;
    this.storage = storage;
    this.now = now;
    this.uuid = uuid;
    this.snapshot = this.compute();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.snapshot;

  private emit(changes: Partial<typeof this.base> = {}) {
    if (this.stopped) return;
    Object.assign(this.base, changes);
    this.snapshot = this.compute();
    for (const listener of this.listeners) listener();
  }

  private compute(): SyncState {
    const records = this.queue.reduce((list, p) => {
      const next = list.filter((r) => r.id !== p.request.id);
      if (p.request.data)
        next.push({
          id: p.request.id,
          revision: p.request.revision + 1,
          data: p.request.data,
          updatedAt: new Date(p.at).toISOString(),
        });
      return next;
    }, this.cloud);
    const settings = records.find((r) => r.id === settingsId)?.data;
    return {
      ...this.base,
      records,
      pending: this.queue.length,
      settings: settings?.kind === "settings" ? settings : undefined,
    };
  }

  private readQueue() {
    this.queue = this.storage
      .readPending(this.owner)
      .sort((a, b) => a.at - b.at || a.request.operationId.localeCompare(b.request.operationId));
  }

  /**
   * Stops the engine for good, before its account's data is deleted. Replies
   * that arrive afterwards change nothing on this iPhone.
   */
  stop() {
    this.stopped = true;
    this.listeners.clear();
  }

  /** Restores the queue and snapshot, then loads from Fitness and sends the queue. */
  async start() {
    try {
      this.readQueue();
      const cached = this.storage.readSnapshot(this.owner);
      if (cached) {
        this.cloud = z.array(recordSchema).parse(cached);
        this.emit({ ready: true });
      } else this.emit();
    } catch {
      this.emit({ error: "Saved data on this iPhone could not be read. Export the pending changes before signing out." });
    }
    await this.refresh();
  }

  /**
   * Runs a load or a save after every one requested before it. Work still
   * waiting when the engine stops is never sent.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const guarded = () => (this.stopped ? Promise.reject(new StoppedError()) : work());
    const run = this.lane.then(guarded, guarded);
    this.lane = run.catch(() => undefined);
    return run;
  }

  /** Loads the account from Fitness, then sends anything queued. */
  async refresh() {
    if (this.stopped) return false;
    try {
      await this.reload();
      if (this.stopped) return false;
      this.emit({ ready: true, loaded: true, ...this.reached() });
    } catch (error) {
      this.fail(error, "Could not load your account. Pull to retry when connected.");
      return false;
    }
    await this.flush();
    return true;
  }

  /** Loads the account and keeps it as the cloud copy. */
  private reload() {
    return this.serial(async () => {
      const result = await this.transport.load();
      if (this.stopped) return;
      if (result.owner !== this.owner) throw new Error("Your account changed. Sign in again to continue.");
      this.cloud = z.array(recordSchema).parse(result.records);
      this.storage.writeSnapshot(this.owner, this.cloud);
      this.base = { ...this.base, storedContract: result.contract ?? 1 };
    });
  }

  /** Online again, keeping a conflict's or a refusal's message and clearing any other error. */
  private reached() {
    const held = this.base.conflict || this.base.rejected;
    return { online: true, error: held ? this.base.error : "" };
  }

  private fail(error: unknown, fallback: string) {
    if (this.stopped || error instanceof StoppedError) return;
    // Going offline keeps a conflict's or a refusal's message; it still applies.
    if (error instanceof OfflineError)
      this.emit({ online: false, error: this.base.conflict || this.base.rejected ? this.base.error : "" });
    else if (error instanceof RejectedChange && this.queue[0])
      this.emit({
        rejected: { operationId: this.queue[0].request.operationId, message: error.message },
        error: `Fitness refused a change: ${error.message} Export it if you want a copy, then discard it to keep saving.`,
      });
    else this.emit({ error: error instanceof Error ? error.message : fallback });
  }

  /**
   * Sends queued changes in order until one conflicts or fails. While a
   * send is running, this returns it, so callers can wait for the queue.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.stopped || !this.base.ready || this.base.conflict || this.base.rejected) return Promise.resolve();
    this.flushing = this.send().finally(() => {
      this.flushing = null;
      // A change queued while the send finished goes out now, unless the
      // send stopped on an error, a conflict or a refused change.
      const { online, error, conflict, rejected } = this.base;
      if (!this.stopped && this.queue.length && online && !error && !conflict && !rejected) void this.flush();
    });
    return this.flushing;
  }

  private async send() {
    this.emit({ saving: this.queue.length > 0 });
    // A save's reply can be a replayed receipt, older than the account. Once
    // the queue is sent, the account is loaded again, so a record removed on
    // another device doesn't stay on the iPhone.
    let saved = false;
    try {
      while (this.queue[0]) {
        const item = this.queue[0];
        const result = await this.serial(() => this.transport.save(item.request));
        if (this.stopped) return;
        if (result.status === "conflict") {
          this.conflictId = item.request.id;
          this.emit({
            conflict: result,
            error: "This record changed on another device. Review both versions before continuing.",
          });
          break;
        }
        // A replayed receipt can be older than a load applied before it;
        // the newer version stays.
        const held = this.cloud.find((r) => r.id === item.request.id);
        const acknowledgedRevision = item.request.revision + 1;
        const next =
          held && held.revision > acknowledgedRevision
            ? this.cloud
            : [...this.cloud.filter((r) => r.id !== item.request.id), ...(result.record ? [result.record] : [])];
        this.storage.acknowledge(this.owner, item.request.operationId, next);
        this.cloud = next;
        this.readQueue();
        saved = true;
        this.emit({ online: true, error: "" });
      }
    } catch (error) {
      // A refusal or error shows at once, before reconciling.
      this.fail(error, "Save failed. Your pending changes stay on this iPhone.");
      if (error instanceof OfflineError) saved = false;
    } finally {
      this.emit({ saving: false });
    }
    // Reconcile after any acknowledged save, even when a later change was
    // refused. A failed reconcile load never replaces a refusal, a conflict
    // or an error already shown; the next load reconciles instead.
    if (saved && !this.stopped) {
      try {
        await this.reload();
        if (!this.stopped) this.emit(this.reached());
      } catch (error) {
        if (!this.base.error && !this.base.conflict && !this.base.rejected)
          this.fail(error, "Could not load your account. Pull to retry when connected.");
      }
    }
  }

  /** The newest version of a record on this iPhone, queued changes included. */
  latest(id: string): { revision: number; data: Entity | null } {
    const previous = this.queue.filter((p) => p.request.id === id).at(-1);
    if (previous) return { revision: previous.request.revision + 1, data: previous.request.data };
    const record = this.cloud.find((r) => r.id === id);
    return { revision: record?.revision ?? 0, data: record?.data ?? null };
  }

  /**
   * Queues a change: `data` replaces the record, or null removes it. With
   * `expectedRevision`, the change is refused when the record moved on
   * since the editor opened it. Returns whether the change was queued.
   */
  put(data: Entity | null, id: string = this.uuid(), expectedRevision?: number) {
    if (this.stopped) return false;
    if (!this.base.ready || this.base.conflict) {
      this.emit({ error: "Load your data and resolve conflicting changes before editing." });
      return false;
    }
    const { revision } = this.latest(id);
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      this.emit({
        error: "This record changed since you opened it. Open it again to load the current version before saving.",
      });
      return false;
    }
    const parsed = mutationSchema.safeParse({ id, data, revision, operationId: this.uuid() });
    if (!parsed.success) {
      this.emit({
        error: `This change was not saved. ${parsed.error.issues[0]?.message ?? "Check the values and try again."}`,
      });
      return false;
    }
    const item = { request: parsed.data, at: Math.max(this.now(), (this.queue.at(-1)?.at ?? 0) + 1) };
    try {
      this.storage.addPending(this.owner, item);
      this.readQueue();
    } catch {
      this.emit({ error: "This iPhone's storage is full or unavailable. This change was not saved. Free space and retry." });
      return false;
    }
    this.emit({ error: "" });
    void this.flush();
    return true;
  }

  /** Loads again after an error, and sends a refused change once more. */
  retry() {
    this.emit({ error: this.base.conflict ? this.base.error : "", rejected: null });
    return this.refresh();
  }

  /** Removes the change Fitness refused from the queue, then sends the rest. */
  async discardRejected() {
    const rejected = this.base.rejected;
    if (!rejected) return;
    this.storage.removePending(this.owner, rejected.operationId);
    this.readQueue();
    this.emit({ rejected: null, error: "", editorReset: this.base.editorReset + 1 });
    await this.flush();
  }

  /** Drops this iPhone's queued changes to the conflicting record and reloads it. */
  async useCloud() {
    const id = this.conflictId;
    if (!id) return;
    for (const item of this.queue.filter((p) => p.request.id === id)) this.storage.removePending(this.owner, item.request.operationId);
    this.readQueue();
    this.conflictId = null;
    this.emit({ conflict: null, error: "" });
    if (await this.refresh()) this.emit({ editorReset: this.base.editorReset + 1 });
  }

  /**
   * The queued changes as JSON, to keep before discarding them, with any
   * values typed on this iPhone that are not saved yet.
   */
  draftExport(typed: Record<string, string> = {}) {
    return JSON.stringify({ format: "fitness-pending-v1", pending: this.queue, typed }, null, 2);
  }
}
