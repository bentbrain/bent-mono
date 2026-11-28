import Constants from "expo-constants";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { localDate } from "@bent/fitness-contracts/domain";
import type { Entity, Settings } from "@bent/fitness-contracts/domain";
import { clerkOAuth, keychainStore, oauthSettings } from "../auth";
import { ApiError, createApi } from "../data/api";
import type { Api } from "../data/api";
import { drafts, sqliteStorage } from "../data/storage";
import { RejectedChange, SyncEngine } from "../data/sync-engine";
import { widget } from "../data/widget";
import type { SyncState } from "../data/sync-engine";
import { Session } from "./session";
import type { OAuthClient } from "./session";

const fitnessOrigin = String(Constants.expoConfig?.extra?.fitnessOrigin ?? "https://fitness.bent.build").replace(/\/$/, "");
const settings = oauthSettings();
const unconfigured: OAuthClient = {
  authorize: () => Promise.reject(new Error("Sign-in is not set up in this build.")),
  refresh: () => Promise.reject(new Error("Sign-in is not set up in this build.")),
  revoke: () => Promise.resolve(),
};

/** The one session for this app process. */
export const session = new Session(settings ? clerkOAuth(settings) : unconfigured, keychainStore);
export const api = createApi(fitnessOrigin, session);

// The moment the session closes, by signing out, at launch while signed out
// or because Fitness ended the sign-in, the widget drops the account's
// snapshots still waiting and shows the signed-out snapshot.
session.subscribe(() => {
  const { status } = session.getState();
  if (status === "signingOut" || status === "signedOut") void widget.signOut(session.generation());
});
export const signInConfigured = settings !== null;

export function useSession() {
  return useSyncExternalStore(session.subscribe, session.getState);
}

/** The account's records and how to change them, as the screens use them. */
export type Sync = SyncState & {
  put: (data: Entity | null, id?: string, expectedRevision?: number) => boolean;
  latest: SyncEngine["latest"];
  retry: () => Promise<boolean>;
  refresh: () => Promise<boolean>;
  useCloud: () => Promise<void>;
  /** Removes the change Fitness refused, so the rest of the queue can save. */
  discardRejected: () => Promise<void>;
  /** The queued changes and typed values on this iPhone, as JSON. */
  draftExport: () => string;
  /** Unsaved changes on this iPhone: queued changes plus typed values. */
  unsaved: () => number;
  /** Stops syncing before the account's data on this iPhone is deleted. */
  stop: () => void;
};

type Account = {
  owner: string;
  sync: Sync;
  /** Settings, present once onboarding has saved them. */
  settings: Settings | undefined;
  /** Today in the account's timezone. */
  today: string;
  /** The day the Week, Food and Body screens show. */
  date: string;
  setDate: (date: string) => void;
  /** True while an editor holds typed values that are not saved yet. */
  inputPending: boolean;
  setInputPending: (pending: boolean) => void;
  api: Api;
};

const AccountContext = createContext<Account | null>(null);

/** The signed-in account. Screens inside the signed-in app use this. */
export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error("Open this screen from your signed-in account.");
  return account;
}

/** The account once onboarding has saved settings. */
export function useConfiguredAccount() {
  const account = useAccount();
  if (!account.settings) throw new Error("Finish setting up your plan first.");
  return { ...account, settings: account.settings };
}

function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Loads the account for `owner` and keeps it in sync while the app runs. */
export function AccountProvider({ owner, children }: { owner: string; children: ReactNode }) {
  const engine = useMemo(() => {
    // The engine's requests belong to the sign-in that opened this account;
    // a change still queued after signing out is never sent under another.
    const generation = session.generation();
    return new SyncEngine({
        owner,
        storage: sqliteStorage,
        transport: {
          load: () => api.loadRecords(generation),
          // A change Fitness refuses as invalid would be refused again, so it
          // is held for the person to discard rather than sent forever.
          save: (request) =>
            api.saveRecord(request, generation).catch((error: unknown) => {
              if (error instanceof ApiError && [400, 413, 422].includes(error.status))
                throw new RejectedChange(error.message);
              throw error;
            }),
        },
      });
  }, [owner],
  );
  const state = useSyncExternalStore(engine.subscribe, engine.getState);

  useEffect(() => {
    void engine.start();
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") void engine.refresh();
    });
    // Queued changes are sent again every 30 seconds until Fitness takes them.
    const timer = setInterval(() => {
      const current = engine.getState();
      if (current.pending && !current.saving && !current.conflict && !current.rejected) void engine.flush();
    }, 30_000);
    return () => {
      appState.remove();
      clearInterval(timer);
    };
  }, [engine]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const today = localDate(state.settings?.timezone ?? deviceTimezone(), new Date(now));
  const [selected, setSelected] = useState<string | null>(null);
  const [inputPending, setInputPending] = useState(false);
  const date = selected ?? today;

  const sync: Sync = useMemo(
    () => ({
      ...state,
      put: (data, id, expectedRevision) => engine.put(data, id, expectedRevision),
      latest: (id) => engine.latest(id),
      retry: () => engine.retry(),
      refresh: () => engine.refresh(),
      useCloud: () => engine.useCloud(),
      discardRejected: () => engine.discardRejected(),
      draftExport: () => engine.draftExport(drafts.all(owner)),
      unsaved: () => engine.getState().pending + Object.keys(drafts.all(owner)).length,
      stop: () => engine.stop(),
    }),
    [engine, state, owner],
  );

  const value = useMemo<Account>(
    () => ({
      owner,
      sync,
      settings: state.settings,
      today,
      date,
      setDate: (next) => setSelected(next === today ? null : next),
      inputPending,
      setInputPending,
      api,
    }),
    [owner, sync, state.settings, today, date, inputPending],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
