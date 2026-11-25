import { requireNativeModule } from "expo";
import type { EventSubscription } from "expo";

type KeyState = "signedOut" | "consentPending" | "active" | "invalid";

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
  backfillThrough?: string | null;
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
  error?: string;
};

type FitnessHealthNative = {
  healthDataAvailable(): boolean;
  getStatus(): Promise<SyncStatus>;
  enroll(token: string, revokeLater: boolean): Promise<EnrollOutcome>;
  confirmConsent(cutoffMs: number): Promise<void>;
  declineConsent(): Promise<number>;
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
