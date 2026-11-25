import type { SyncStatus } from "../../modules/fitness-health";

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
