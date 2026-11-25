import { requireNativeModule } from "expo";
import type { EventSubscription } from "expo";

type KeyState = "signedOut" | "consentPending" | "active" | "invalid" | "locked";

/** What the native sync service reports. Dates are milliseconds since 1970. */
export type SyncStatus = {
  state: KeyState;
  healthAvailable: boolean;
  origin: string;
  pendingRevocations: number;
  retryPending: boolean;
  email?: string;
  accountTimezone?: string;
  cutoff?: number;
  earliestCutoff?: number;
  lastSyncAt?: number | null;
  lastError?: string | null;
  /** Totals over recent runs, keyed `weight.new`, `run.matched_existing` and so on. */
  counts?: Record<string, number>;
  runsWithoutDistance?: number;
  deferred?: number;
  unreadableRetired?: number;
  paused?: Partial<Record<"weight" | "run", string>>;
  backfilling?: boolean;
  /** Whether the first sync has recorded its starting point. */
  backfillStarted?: boolean;
  backfillThrough?: string | null;
  /** The pending enrollment the consent screen shows; consent and decline name it. */
  enrollmentId?: string;
  /** Consent is confirmed and the Health step has not started the first sync. */
  awaitingHealthStep?: boolean;
  /** Runs waiting because the app cannot tell whether it may read distance. */
  runsAwaitingDistanceAccess?: number;
  /** Keys Fitness would not revoke from the iPhone; revoke them in Fitness. */
  manualRevocations?: number;
};

export type EnrollOutcome =
  | { kind: "consentPending"; email: string; accountTimezone: string }
  | { kind: "pendingRevocations"; count: number }
  | { kind: "superseded" }
  | { kind: "failed"; action: "retrySameToken"; code: string; retryAfter: number | null }
  | { kind: "failed"; action: "reauthorize"; code: string }
  | { kind: "failed"; action: "bug" | "deviceLimit"; message: string }
  | { kind: "failed"; action: "refused"; code: string; message: string };

export type ReadableHistory = {
  cutoff?: number;
  weight?: number | null;
  run?: number | null;
  /** The earliest date Health lets the app read, where the user shared limited history. */
  weightAllowedFrom?: number;
  runAllowedFrom?: number;
  error?: string;
};

type FitnessHealthNative = {
  healthDataAvailable(): boolean;
  getStatus(): Promise<SyncStatus>;
  /** Starts a sign-in's enrollment attempt; each of its requests passes it to `enroll`. */
  beginEnrollment(): Promise<number>;
  enroll(token: string, revokeLater: boolean, attempt: number): Promise<EnrollOutcome>;
  confirmConsent(cutoffMs: number, enrollmentId: string): Promise<void>;
  declineConsent(enrollmentId: string): Promise<number>;
  startFirstSync(): Promise<SyncStatus>;
  sendRunsWithoutDistance(): Promise<SyncStatus>;
  requestHealthAccess(): Promise<void>;
  readableHistory(): Promise<ReadableHistory>;
  syncNow(): Promise<SyncStatus>;
  disconnect(): Promise<number>;
  retryRevocations(): Promise<number>;
  setCutoff(cutoffMs: number): Promise<void>;
  resyncFromEarliest(): Promise<void>;
  addListener(event: "onStatus", listener: (status: SyncStatus) => void): EventSubscription;
};

export const FitnessHealth = requireNativeModule<FitnessHealthNative>("FitnessHealth");
