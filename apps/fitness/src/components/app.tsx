import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { AccountContext, useAccount } from "./account-context";
import { UserButton, SignInButton, useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@bent/ui/button";
import { localDate, settingsId } from "../domain";
import { load, save } from "../server/functions";
import { useSync } from "../sync";
import { download } from "./fields";
import { Nutrition } from "./nutrition";
import { Bodyweight } from "./bodyweight";
import { Onboarding, SettingsEditor } from "./settings";
import { History } from "./history";
import { Icon } from "./icons";
import type { IconName } from "./icons";
const transport = {
  load: () => load(),
  save: (request: Parameters<typeof save>[0]["data"]) =>
    save({ data: request }),
};
export function AuthenticatedApp() {
  const { userId, isLoaded } = useAuth();
  if (!isLoaded) return <p className="loading">Loading account…</p>;
  return userId ? <Account key={userId} owner={userId} /> : <Welcome />;
}
function Welcome() {
  return (
    <main className="landing">
      <div className="wordmark">
        bent<span>/</span>fitness
      </div>
      <h1>Plan the week. Log every set.</h1>
      <p>
        Your strength sessions, runs, food and bodyweight in one private
        account.
      </p>
      <ul className="landing-jobs">
        <li>
          <strong>Week</strong>
          See what is planned each day and start the next session.
        </li>
        <li>
          <strong>Exercises</strong>
          Setup, form cues, pictures and a tutorial for every movement.
        </li>
        <li>
          <strong>Food</strong>
          Daily calories and protein, with saved meals you add in one tap.
        </li>
        <li>
          <strong>Progress</strong>
          Sessions by week, strength by exercise and your bodyweight trend.
        </li>
      </ul>
      <SignInButton mode="modal">
        <Button appearance="primary">
          Sign in to your plan <span aria-hidden>→</span>
        </Button>
      </SignInButton>
      <p className="muted">
        Invited accounts only. Your training and nutrition stay private.
      </p>
      <p className="install-tip">
        Add this website to your home screen from your browser's share menu.
      </p>
    </main>
  );
}
const navigation = [
  {
    to: "/",
    name: "Week",
    icon: "week",
    paths: ["/", "/plan", "/workout", "/run", "/schedule"],
  },
  { to: "/guides", name: "Exercises", icon: "exercises", paths: ["/guides"] },
  { to: "/food", name: "Food", icon: "food", paths: ["/food"] },
  {
    to: "/progress",
    name: "Progress",
    icon: "progress",
    paths: ["/progress", "/history", "/body"],
  },
] satisfies {
  to: "/" | "/guides" | "/food" | "/progress";
  name: string;
  icon: IconName;
  paths: string[];
}[];
function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function Account({ owner }: { owner: string }) {
  const sync = useSync(owner, transport);
  const location = useLocation();
  const { date: selectedDate } = useSearch({ from: "/_app" });
  const settings =
    sync.settings?.kind === "settings" ? sync.settings : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const today = localDate(
    settings?.timezone ?? browserTimezone(),
    new Date(now),
  );
  const date = selectedDate || today;
  const [inputPending, setInputPending] = useState(false);
  const router = useRouter();
  useEffect(
    () =>
      // Move focus to the new page heading after in-app navigation.
      router.subscribe("onRendered", (event) => {
        if (!event.pathChanged || !event.fromLocation) return;
        const heading = document.querySelector(".content h1");
        if (heading instanceof HTMLElement) {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        }
      }),
    [router],
  );
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link
          className="wordmark"
          to="/"
          search={{}}
          activeOptions={{ exact: true, includeSearch: false }}
        >
          bent<span>/</span>fitness
        </Link>
        <div
          className="account-tools"
          data-feedback-private
          data-feedback-redact
        >
          <span
            className="sync-state"
            data-state={
              !sync.online
                ? "offline"
                : sync.saving
                  ? "busy"
                  : sync.error
                    ? "error"
                    : inputPending || sync.pending || !sync.ready
                      ? "busy"
                      : "saved"
            }
            role="status"
          >
            {!sync.online
              ? "Offline · pending on device"
              : sync.saving
                ? "Saving…"
                : sync.error
                  ? "Needs attention"
                  : inputPending
                    ? "Unsaved input on device"
                    : sync.pending
                      ? `${sync.pending} pending`
                      : sync.ready
                        ? "Saved"
                        : "Loading…"}
          </span>
          <Link
            className="icon-button"
            to="/settings"
            search={{}}
            aria-label="Settings"
            aria-current={
              location.pathname === "/settings" ? "page" : undefined
            }
          >
            <Icon name="settings" />
          </Link>
          <UserButton />
        </div>
      </header>
      <nav className="navigation" aria-label="Main navigation">
        {navigation.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            search={{}}
            activeOptions={{ exact: true }}
            aria-current={
              item.paths.includes(location.pathname) ? "page" : undefined
            }
          >
            <Icon name={item.icon} />
            {item.name}
          </Link>
        ))}
      </nav>
      <main className="content">
        {sync.error && (
          <div className="error" role="alert">
            <p>{sync.error}</p>
            {!sync.conflict && (
              <Button appearance="outline" onClick={() => void sync.retry()}>
                Retry connection
              </Button>
            )}
            <Button
              appearance="outline"
              onClick={() =>
                download("fitness-pending.json", sync.draftExport())
              }
            >
              Export pending changes
            </Button>
          </div>
        )}
        {sync.conflict && (
          <div className="card conflict" data-feedback-private>
            <h2>Review the conflict</h2>
            <p>
              Your device draft is kept until you choose. Export it first if you
              want to keep both versions.
            </p>
            <details>
              <summary>Cloud version</summary>
              <pre>
                {JSON.stringify(sync.conflict.current?.data ?? null, null, 2)}
              </pre>
            </details>
            <details>
              <summary>Device changes</summary>
              <pre>{sync.draftExport()}</pre>
            </details>
            <Button appearance="outline" onClick={() => void sync.useCloud()}>
              Use cloud version for this record
            </Button>
            <p>
              To keep parts of your draft, export it, load the cloud version,
              then enter your changes again.
            </p>
          </div>
        )}
        {!sync.ready ? (
          <div className="card">
            <h1>Opening your plan</h1>
            <p>
              Your account data loads from the server. Pending changes on this
              device stay available until they sync.
            </p>
          </div>
        ) : !settings ? (
          <Onboarding sync={sync} />
        ) : (
          <AccountContext.Provider
            value={{ sync, settings, date, today, owner, setInputPending }}
          >
            <Outlet />
          </AccountContext.Provider>
        )}
      </main>
    </div>
  );
}
export function HistoryScreen() {
  return <History />;
}
export function FoodScreen() {
  const { sync, date, settings } = useAccount();
  return <Nutrition key={date} sync={sync} date={date} settings={settings} />;
}
export function BodyScreen() {
  const { sync, date, settings } = useAccount();
  return <Bodyweight key={date} sync={sync} date={date} settings={settings} />;
}
export function SettingsScreen() {
  const { sync, settings } = useAccount();
  const revision =
    sync.records.find((record) => record.id === settingsId)?.revision ?? 0;
  return (
    <SettingsEditor
      key={sync.editorReset}
      section="profile"
      revision={revision}
      settings={settings}
      sync={sync}
    />
  );
}
export function ScheduleScreen() {
  const { sync, settings } = useAccount();
  const revision =
    sync.records.find((record) => record.id === settingsId)?.revision ?? 0;
  return (
    <SettingsEditor
      key={sync.editorReset}
      section="plan"
      revision={revision}
      settings={settings}
      sync={sync}
    />
  );
}
