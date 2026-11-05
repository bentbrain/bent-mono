// Keep the selected image in memory only until the editor consumes it.
let pending: { id: string; image: File; timeout: number } | undefined;

export function retainImageForDraft(id: string, image: File) {
  if (pending) window.clearTimeout(pending.timeout);
  const entry = { id, image, timeout: window.setTimeout(() => {
    if (pending === entry) pending = undefined;
  }, 60_000) };
  pending = entry;
}

export function takeImageForDraft(id: string) {
  if (pending?.id !== id) return undefined;
  const entry = pending;
  pending = undefined;
  window.clearTimeout(entry.timeout);
  return entry.image;
}
