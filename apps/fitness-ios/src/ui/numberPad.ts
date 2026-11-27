import { useSyncExternalStore } from "react";

/*
 * Number pads have no return key, so a field that opens one asks for the
 * Done bar above the keyboard while it has focus.
 */
let focused = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Called by a number field when it gains and loses focus. */
export const numberPad = {
  focus() {
    focused++;
    emit();
  },
  blur() {
    focused = Math.max(0, focused - 1);
    emit();
  },
};

/** Whether a number field has focus. */
export function useNumberPadFocused() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => focused > 0,
  );
}
