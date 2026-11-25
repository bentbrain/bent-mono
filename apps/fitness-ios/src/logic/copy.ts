import type { EnrollOutcome, SyncStatus } from "../../modules/fitness-health";

export const fitnessHost = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

export const copy = {
  appName: "Fitness Sync",
  signIn: {
    title: "Sync Apple Health to Fitness",
    body: "Fitness Sync sends your weigh-ins and runs from Apple Health to your Fitness account. Sign in with the account you use for Fitness.",
    button: "Sign in to Fitness",
    unconfigured: "Sign-in is not set up in this build.",
  },
  consent: {
    title: "Confirm what syncs",
    types: "Weigh-ins (body mass) and running workouts, including their distance.",
    destination: (host: string) => `They go to ${host}, into the account below.`,
    promise: [
      "The first sync sends your history while the app is open.",
      "New weigh-ins and runs sync in the background whenever iOS wakes the app. iOS decides when that happens.",
      "Each time you open the app, it catches up.",
    ],
    disconnect:
      "Disconnect in Settings stops syncing, revokes this iPhone's key and clears what the app stored about your Health data. Entries already in Fitness stay there.",
    history: "History to send",
    confirm: "Confirm and continue",
    decline: "Cancel and revoke",
  },
  health: {
    title: "Allow Health access",
    body: "iOS asks which data Fitness Sync can read. Turn on Weight, Workouts and Walking + Running Distance.",
    allow: "Choose Health access",
    readable: "Readable history",
    none: "None readable",
    noneHint:
      "Fitness Sync can't read any samples. Check Settings → Health → Data Access & Devices → Fitness Sync.",
    start: "Start the first sync",
    keepOpen: "Keep Fitness Sync open until the first sync finishes.",
  },
  status: {
    title: "Sync",
    lastSync: "Last sync",
    never: "Not yet",
    syncNow: "Sync now",
    backfill: (through: string | null | undefined) =>
      through ? `Sending history: done through ${through}. Keep the app open.` : "Sending history. Keep the app open.",
    withoutDistance: (count: number) =>
      `${count} ${count === 1 ? "run was" : "runs were"} sent without a distance. Add the distance in Fitness if you need it.`,
    waiting: (count: number) => `${count} ${count === 1 ? "sample is" : "samples are"} waiting until they are due.`,
    unreadable: (count: number) => `${count} ${count === 1 ? "item" : "items"} could not be read and stopped waiting.`,
  },
  settings: {
    title: "Settings",
    history: "History",
    resync: "Resync from earliest start",
    resyncHint: "Sends everything from your earliest chosen start again. Fitness skips what it already has.",
    disconnect: "Disconnect",
    version: (version: string, build: string) => `Version ${version} (${build})`,
  },
  reconnect: {
    title: "Connect again",
    body: "Fitness no longer accepts this iPhone's key. It may have been revoked under Manage account → API keys. Sign in again to keep syncing.",
  },
};

const codeGuidance: Record<string, string> = {
  transport: "Fitness could not be reached. The app tries again on the next sync.",
  auth_unavailable: "Account services were unavailable. The app tries again on the next sync.",
  import_conflict: "An entry changed while saving. The app tries again on the next sync.",
  malformed_reply: "Fitness sent a reply the app could not read. The app tries again on the next sync.",
  unauthorized: "Fitness could not check this iPhone's key. The app tries again on the next sync.",
  health_query_failed: "Health could not be read. The app tries again on the next sync.",
  distance_unknown: "A run's distance could not be read yet. The app tries again on the next sync.",
  locked: "Health data is locked until you unlock this iPhone.",
  key_invalid: "Fitness no longer accepts this iPhone's key. Connect again.",
  not_invited: "This Fitness account needs an invitation.",
  reconnect: "This iPhone's key lacks access. Connect again.",
  timezone_changed: "The account timezone changed. The app regroups the history and tries again.",
  needs_correction: "Fitness could not read some samples. Choose Sync now to try again.",
  state_write_failed: "The app could not save its progress. It tries again on the next sync.",
};

/** Guidance for a last-error code. */
export function guidance(code: string | null | undefined): string | null {
  if (!code) return null;
  if (codeGuidance[code]) return codeGuidance[code];
  if (/^http_5\d\d$/.test(code)) return "Fitness had a problem. The app tries again on the next sync.";
  return `The last sync stopped (${code}). The app tries again on the next sync.`;
}

/** What to tell the user after an enrollment attempt that did not succeed. */
export function enrollMessage(outcome: EnrollOutcome): string {
  if (outcome.kind === "pendingRevocations")
    return `${outcome.count} earlier ${outcome.count === 1 ? "key" : "keys"} from this iPhone could not be revoked yet. Try again when online, or continue and revoke later under Manage account → API keys.`;
  if (outcome.kind === "superseded") return "That sign-in was replaced by a newer one. Sign in again.";
  if (outcome.kind !== "failed") return "";
  switch (outcome.action) {
    case "deviceLimit":
      return "Up to 3 iPhones can sync. Revoke one under Manage account → API keys in Fitness, then sign in again.";
    case "bug":
      return `The app sent a request Fitness could not read: ${outcome.message}`;
    case "reauthorize":
      return "The connection did not finish. Sign in again.";
    case "retrySameToken":
      return "Fitness is busy. Try again in a moment.";
    case "refused":
      switch (outcome.code) {
        case "insufficient_scope":
          return "Approve iPhone sync access when you sign in.";
        case "client_not_allowed":
          return "This build of the app is not allowed to connect. Install the current version.";
        case "not_invited":
          return "This account needs an invitation to Fitness. Ask the app owner.";
        case "enrollment_unavailable":
          return "Fitness is not accepting new iPhones right now. Try again later.";
        default:
          return outcome.message;
      }
  }
}

export type CountLine = { label: string; value: number };

const codeLabels: Record<string, string> = {
  new: "added",
  already_imported: "already synced",
  matched_existing: "matched an entry in Fitness",
  removed_in_fitness: "removed in Fitness",
  date_has_weighin: "date already had a weigh-in",
  duplicate_in_request: "duplicate in Health",
  future: "dated after today",
  out_of_range: "outside Fitness's limits",
};

/** Count lines for one type, from the codes in recent runs. */
export function countLines(counts: SyncStatus["counts"], type: "weight" | "run"): CountLine[] {
  return Object.entries(codeLabels)
    .map(([code, label]) => ({ label, value: counts?.[`${type}.${code}`] ?? 0 }))
    .filter((line) => line.value > 0);
}
