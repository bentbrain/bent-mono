import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { mutationSchema, recordSchema, settingsId } from "./domain";
import type { Entity, Mutation, RecordEntry, SaveResult } from "./domain";
const pendingSchema = z.object({ request: mutationSchema, at: z.number() });
type Pending = z.infer<typeof pendingSchema>;
export type Transport = {
  load: () => Promise<{ owner: string; records: RecordEntry[] }>;
  save: (request: Mutation) => Promise<SaveResult>;
};
export function useSync(owner: string, transport: Transport) {
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<
    (SaveResult & { status: "conflict" }) | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [online, setOnline] = useState(true);
  const queue = useRef<Pending[]>([]),
    cloud = useRef<RecordEntry[]>([]),
    busy = useRef(false),
    needsRefresh = useRef(false);
  const prefix = `fitness:pending:v1:${owner}:`;
  const readPending = useCallback(() => {
    const items: Pending[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        const raw = localStorage.getItem(key);
        if (raw) items.push(pendingSchema.parse(JSON.parse(raw)));
      }
    }
    return items.sort(
      (a, b) =>
        a.at - b.at ||
        a.request.operationId.localeCompare(b.request.operationId),
    );
  }, [prefix]);
  const reload = useCallback(async () => {
    const result = await transport.load();
    if (result.owner !== owner)
      throw new Error("Your account changed. Reload to continue.");
    cloud.current = z.array(recordSchema).parse(result.records);
    setRecords(cloud.current);
  }, [owner, transport]);
  useEffect(() => {
    let active = true;
    function restore() {
      try {
        queue.current = readPending();
        setPending(queue.current);
      } catch {
        setError(
          "A saved draft could not be read. Export the browser drafts before clearing them.",
        );
      }
    }
    restore();
    void reload()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error
              ? e.message
              : "Could not load cloud data. Retry when connected.",
          );
      });
    const network = () => setOnline(navigator.onLine);
    const storage = (event: StorageEvent) => {
      if (event.key?.startsWith(prefix)) {
        restore();
        needsRefresh.current = true;
      }
    };
    network();
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    window.addEventListener("storage", storage);
    const unload = (e: BeforeUnloadEvent) => {
      if (queue.current.length) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      active = false;
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
      window.removeEventListener("storage", storage);
      window.removeEventListener("beforeunload", unload);
    };
  }, [prefix, readPending, reload]);
  const flush = useCallback(async () => {
    if (busy.current || !ready || !online || conflict) return;
    busy.current = true;
    setSaving(true);
    try {
      while (queue.current[0]) {
        const item = queue.current[0];
        const result = await transport.save(item.request);
        if (result.status === "conflict") {
          setConflict(result);
          setError(
            "This record changed on another device. Review both versions before continuing.",
          );
          break;
        }
        const next = cloud.current.filter((r) => r.id !== item.request.id);
        if (result.record) next.push(result.record);
        cloud.current = next;
        setRecords(next);
        localStorage.removeItem(prefix + item.request.operationId);
        queue.current = readPending();
        setPending(queue.current);
        setError("");
      }
      if (needsRefresh.current) {
        needsRefresh.current = false;
        await reload();
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Save failed. Your pending changes remain on this device.",
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [conflict, online, prefix, readPending, ready, reload, transport]);
  useEffect(() => {
    if (!error) void flush();
  }, [pending, flush, error]);
  const visible = pending.reduce((list, p) => {
    const next = list.filter((r) => r.id !== p.request.id);
    if (p.request.data)
      next.push({
        id: p.request.id,
        revision: p.request.revision + 1,
        data: p.request.data,
        updatedAt: new Date(p.at).toISOString(),
      });
    return next;
  }, records);
  function put(data: Entity | null, id: string = crypto.randomUUID()) {
    if (!ready || conflict) {
      setError(
        "Load your data and resolve conflicting changes before editing.",
      );
      return false;
    }
    const latest = readPending();
    const previous = latest.filter((p) => p.request.id === id).at(-1);
    const revision = previous
      ? previous.request.revision + 1
      : (cloud.current.find((r) => r.id === id)?.revision ?? 0);
    const request = mutationSchema.parse({
      id,
      data,
      revision,
      operationId: crypto.randomUUID(),
    });
    const item = {
      request,
      at: Math.max(Date.now(), (queue.current.at(-1)?.at ?? 0) + 1),
    };
    try {
      localStorage.setItem(prefix + request.operationId, JSON.stringify(item));
      queue.current = readPending();
      setPending(queue.current);
      setError("");
      return true;
    } catch {
      setError(
        "Device storage is full or unavailable. This change was not saved. Free space and retry.",
      );
      return false;
    }
  }
  async function retry() {
    try {
      await reload();
      setReady(true);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your account.");
    }
  }
  async function useCloud() {
    const id = queue.current[0]?.request.id;
    for (const item of queue.current.filter((p) => p.request.id === id))
      localStorage.removeItem(prefix + item.request.operationId);
    queue.current = readPending();
    setPending(queue.current);
    await retry();
    setConflict(null);
  }
  function draftExport() {
    const browserDrafts: { key: string; raw: string | null }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix))
        browserDrafts.push({ key, raw: localStorage.getItem(key) });
    }
    return JSON.stringify(
      { format: "fitness-pending-v1", pending: queue.current, browserDrafts },
      null,
      2,
    );
  }
  return {
    records: visible,
    ready,
    error,
    conflict,
    pending: pending.length,
    saving,
    online,
    put,
    retry,
    useCloud,
    draftExport,
    settings: visible.find((r) => r.id === settingsId)?.data,
  };
}
export type Sync = ReturnType<typeof useSync>;
