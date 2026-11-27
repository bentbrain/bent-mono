import { useSyncExternalStore } from "react";

/**
 * The Food screen's latest status message. The meal sheet sets it when it
 * saves, so the message shows on the Food screen after the sheet closes.
 */
let current = "";
const listeners = new Set<() => void>();

export function setFoodNotice(message: string) {
  current = message;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFoodNotice() {
  return useSyncExternalStore(subscribe, () => current);
}
