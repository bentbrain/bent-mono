import type { SyncStatus } from "../../modules/fitness-health";
import { copy } from "./copy";

export type Screen = "loading" | "locked" | "signIn" | "consent" | "health" | "status" | "reconnect";

/**
 * The screen for the native status. An active key whose first sync waits
 * for the Health step shows that step; the wait is stored natively, so a
 * relaunch comes back to it.
 */
export function screenFor(status: SyncStatus | null): Screen {
  if (!status) return "loading";
  switch (status.state) {
    case "locked":
      return "locked";
    case "signedOut":
      return "signIn";
    case "consentPending":
      return "consent";
    case "invalid":
      return "reconnect";
    case "active":
      return status.awaitingHealthStep ? "health" : "status";
  }
}

/**
 * The notice for keys Fitness would not revoke from the iPhone, on the
 * sign-in, reconnect and status screens. A
 * disconnect clears the key but keeps the count, so the notice stays until
 * the user dismisses it.
 */
export function manualRevocationNotice(status: SyncStatus | null): string | null {
  if (!status || status.state === "locked" || !status.manualRevocations) return null;
  return copy.status.manualRevocations(status.manualRevocations);
}
