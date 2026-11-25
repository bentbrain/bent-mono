import type { SyncStatus } from "../../modules/fitness-health";

export type Screen = "loading" | "signIn" | "consent" | "health" | "status" | "reconnect";

/**
 * The screen for the native status. An active key without a finished first
 * sync shows the Health step, which asks for access and runs the backfill.
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
      return !healthStepDone && status.backfilling && !status.lastSyncAt ? "health" : "status";
  }
}
