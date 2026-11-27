/**
 * The status line History shows after the correction editor closes, such as
 * "Saved corrected results for ...". It lives in memory only.
 */
export function createNotice() {
  let message = "";
  const listeners = new Set<() => void>();
  return {
    get: () => message,
    set(next: string) {
      if (next === message) return;
      message = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const historyNotice = createNotice();
