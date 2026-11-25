import type { SyncStatus } from "../../modules/fitness-health";

export type Screen = "loading" | "signIn" | "consent" | "health" | "status" | "reconnect";

/**
 * The screen for the native status. An active key whose first sync has not
 * started shows the Health step, which asks for access and starts it.
 */
export function screenFor(status: SyncStatus | null, healthStepDone: boolean): Screen {
  if (!status) return "loading";
  switch (status.state) {
    case "signedOut":
      return "signIn";
    case "consentPending":
      return "consent";
    case "invalid":
      return "reconnect";
    case "active":
      return !healthStepDone && status.backfilling && !status.backfillStarted && !status.lastSyncAt
        ? "health"
        : "status";
  }
}
