import { getDesign } from "@/client/design-api";

let pending: { id: string; read: ReturnType<typeof getDesign>; timeout: number } | undefined;

export function preloadCreatedDraft(id: string) {
  if (pending) window.clearTimeout(pending.timeout);
  const read = getDesign(id);
  const entry = { id, read, timeout: window.setTimeout(() => {
    if (pending === entry) pending = undefined;
  }, 15_000) };
  pending = entry;
  // The editor handles failures. A navigation cancelled before consumption must
  // not leave an unhandled rejection.
  void read.catch(() => undefined);
}

export function getDraftForEditor(id: string) {
  if (pending?.id !== id) return getDesign(id);
  const entry = pending;
  pending = undefined;
  window.clearTimeout(entry.timeout);
  return entry.read;
}
