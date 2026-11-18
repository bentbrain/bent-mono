import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { AccountContext, useAccount } from "./account-context";
import { UserButton, SignInButton, useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@bent/ui/button";
import {
  addDays,
  displayLoad,
  exercises,
  localDate,
  nextSession,
  settingsId,
  scheduled,
  totals,
} from "../domain";
import { load, save } from "../server/functions";
import { useSync } from "../sync";
import { download } from "./fields";
import { Nutrition } from "./nutrition";
import { Bodyweight } from "./bodyweight";
import { Onboarding, SettingsEditor } from "./settings";
import { ExerciseGuide } from "./guide";
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
      <p className="eyebrow">A little stronger, every week.</p>
      <h1>
        Your next
        <br />
        good habit.
      </h1>
      <p>
        Plan your training. Log each set. Keep an eye on food and the longer
        trend.
      </p>
      <SignInButton mode="modal">
        <Button appearance="primary">Sign in to your plan ↗</Button>
      </SignInButton>
      <p className="muted">
        Invited accounts only. Your training and nutrition stay private.
      </p>
      <div className="landing-grid">
        <span>01 / Strength</span>
        <span>02 / Food</span>
        <span>03 / Progress</span>
      </div>
      <p className="install-tip">
        Keep it close. Add this website to your home screen from your browser's
        share menu.
      </p>
    </main>
  );
}
function Account({ owner }: { owner: string }) {
  const sync = useSync(owner, transport);
  const location = useLocation();
  const navigate = useNavigate();
  const { date: selectedDate } = useSearch({ from: "/_app" });
  const dateDestinations: (
    "/" | "/food" | "/body" | "/history" | "/settings" | "/guides"
  )[] = ["/", "/food", "/body", "/history", "/settings", "/guides"];
  const dateDestination =
    dateDestinations.find((path) => path === location.pathname) ?? "/";
  const settings =
    sync.settings?.kind === "settings" ? sync.settings : undefined;
  const [today, setToday] = useState(() => localDate("UTC"));
  useEffect(() => {
    if (!settings) return;
    const tick = () => setToday(localDate(settings.timezone));
    tick();
    const timer = setInterval(tick, 30000);
    return () => clearInterval(timer);
  }, [settings]);
  const date = selectedDate || today;
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="wordmark" href="/">
          bent<span>/</span>fitness
        </a>
        <div
          className="account-tools"
          data-feedback-private
          data-feedback-redact
        >
          <span
            className={`sync-state ${sync.error ? "has-error" : ""}`}
            role="status"
          >
            {!sync.online
              ? "Offline · pending on device"
              : sync.saving
                ? "Saving…"
                : sync.error
                  ? "Needs attention"
                  : sync.pending
                    ? `${sync.pending} pending`
                    : sync.ready
                      ? "Saved"
                      : "Loading…"}
          </span>
          <UserButton />
        </div>
      </header>
      <nav className="navigation" aria-label="Main navigation">
        {(
          [
            { to: "/", name: "Today", icon: "◷" },
            { to: "/food", name: "Food", icon: "+" },
            { to: "/body", name: "Body", icon: "↗" },
            { to: "/history", name: "History", icon: "≡" },
            { to: "/settings", name: "Settings", icon: "⚙" },
          ] satisfies {
            to: "/" | "/food" | "/body" | "/history" | "/settings";
            name: string;
            icon: string;
          }[]
        ).map((item) => (
          <Link
            key={item.to}
            to={item.to}
            search={{ date: selectedDate }}
            activeOptions={{ exact: true }}
            aria-current={
              (
                item.to === "/"
                  ? location.pathname === "/" ||
                    ["/plan", "/workout", "/run"].includes(location.pathname)
                  : location.pathname === item.to
              )
                ? "page"
                : undefined
            }
          >
            <span aria-hidden>{item.icon}</span>
            {item.name}
          </Link>
        ))}
      </nav>
      <main className="content">
        {!["/plan", "/workout", "/run"].includes(location.pathname) && (
          <div
            className="date-control"
            data-feedback-private
            data-feedback-redact
          >
            <label htmlFor="view-date">Your day</label>
            <input
              id="view-date"
              type="date"
              value={date}
              onChange={(e) => {
                const value = e.target.value;
                void navigate({
                  to: dateDestination,
                  search: { date: value || undefined },
                  replace: true,
                });
              }}
            />
            {selectedDate && (
              <button
                onClick={() =>
                  void navigate({
                    to: dateDestination,
                    search: {},
                    replace: true,
                  })
                }
              >
                Today
              </button>
            )}
          </div>
        )}
        {sync.error && (
          <div className="error" role="alert">
            <p>{sync.error}</p>
            {!sync.conflict && (
              <Button appearance="outline" onClick={() => void sync.retry()}>
                Retry connection
              </Button>
            )}
            {(sync.pending > 0 || sync.error) && (
              <Button
                appearance="outline"
                onClick={() =>
                  download("fitness-pending.json", sync.draftExport())
                }
              >
                Export pending changes
              </Button>
            )}
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
          <AccountContext.Provider value={{ sync, settings, date }}>
            <Outlet />
          </AccountContext.Provider>
        )}
      </main>
      <footer className="app-footer">
        bent.build · One session at a time.
      </footer>
    </div>
  );
}
export function TodayScreen() {
  const { sync, date, settings } = useAccount();
  const active = sync.records.find(
    (r) => r.data.kind === "workout" && !r.data.finishedAt,
  );
  const today = scheduled(settings, date);
  const upcoming = nextSession(settings, date, sync.records);
  const nextDate = upcoming?.date ?? date;
  const next = upcoming?.plan;
  const food = totals(sync.records, date);
  return (
    <section>
      <p className="eyebrow">
        {new Intl.DateTimeFormat("en", {
          weekday: "long",
          day: "numeric",
          month: "long",
          timeZone: "UTC",
        }).format(new Date(date + "T12:00:00Z"))}
      </p>
      <h1>Keep showing up.</h1>
      <p className="subtitle" data-feedback-redact data-feedback-private>
        {settings.goal}
      </p>
      {active?.data.kind === "workout" && (
        <aside
          className="card active-workout"
          data-feedback-redact
          data-feedback-private
        >
          <span className="tag">Workout in progress · {active.data.date}</span>
          <h2>{active.data.name}</h2>
          <p>Resume when you are ready, or keep looking through your plan.</p>
          <Link
            className="bent-button bent-button--outline"
            to="/workout"
            search={{ date, workoutId: active.id }}
          >
            Resume workout
          </Link>
        </aside>
      )}
      {next ? (
        <div className="hero card" data-feedback-redact data-feedback-private>
          <div className="hero-top">
            <span className="tag">
              {nextDate === date ? "Up next" : "Next session · " + nextDate}
            </span>
            <span>
              {next.type === "strength" ? "~ 60 min" : "Conversational pace"}
            </span>
          </div>
          <h2>{next.type === "strength" ? next.routine?.name : "Easy run"}</h2>
          <p>
            {today.type === "rest"
              ? "Rest today. Let your next session come to you."
              : next.type === "strength"
                ? `${next.routine?.exercises.length ?? 0} exercises · ${next.intro ? "Introduction · up to 2 sets each" : "Full session"}`
                : "Keep it comfortable enough to talk in sentences."}
          </p>
          {next.type === "strength" && next.routine ? (
            <Link
              className="bent-button bent-button--primary"
              to="/plan"
              search={{ date: nextDate, routineId: next.routine.id }}
            >
              View workout plan <span aria-hidden>↗</span>
            </Link>
          ) : (
            <Link
              className="bent-button bent-button--primary"
              to="/run"
              search={{ date: nextDate }}
            >
              View run plan <span aria-hidden>↗</span>
            </Link>
          )}
        </div>
      ) : (
        <div className="hero card" data-feedback-redact data-feedback-private>
          <span className="tag">Your schedule</span>
          <h2>No session scheduled</h2>
          <p>
            Choose training days in Settings, or record an activity for this
            date.
          </p>
          {settings.routines.map((routine) => (
            <Link
              key={routine.id}
              className="bent-button bent-button--outline"
              to="/plan"
              search={{ date, routineId: routine.id }}
            >
              View {routine.name} plan
            </Link>
          ))}
          <Link
            className="bent-button bent-button--outline"
            to="/run"
            search={{ date }}
          >
            Record an unscheduled run
          </Link>
        </div>
      )}
      <div className="section-heading">
        <h2>Next seven days</h2>
        <span className="muted" data-feedback-private data-feedback-redact>
          {settings.timezone}
        </span>
      </div>
      <div className="week" data-feedback-redact data-feedback-private>
        {Array.from({ length: 7 }, (_, i) => {
          const d = addDays(date, i),
            plan = scheduled(settings, d);
          return (
            <div key={d} className={i === 0 ? "current" : ""}>
              <span>
                {new Date(d + "T12:00:00Z").toLocaleDateString("en", {
                  weekday: "short",
                  timeZone: "UTC",
                })}
              </span>
              <strong>
                {plan.type === "strength"
                  ? plan.routine?.name.replace("Strength ", "")
                  : plan.type === "run"
                    ? "Run"
                    : "Rest"}
              </strong>
              <small>{d.slice(8)}</small>
            </div>
          );
        })}
      </div>
      <h2>Today's fuel</h2>
      <div className="metrics card" data-feedback-redact data-feedback-private>
        <div>
          <strong>{Math.round(food.calories)}</strong>
          <span> / {settings.calories} kcal</span>
          <progress value={food.calories} max={settings.calories} />
        </div>
        <div>
          <strong>{Math.round(food.protein)}g</strong>
          <span> / {settings.protein}g protein</span>
          <progress value={food.protein} max={settings.protein} />
        </div>
      </div>
      <div className="tip card">
        <span className="eyebrow">Learn before you lift</span>
        <h2>Start light. Move well.</h2>
        <p>
          Every exercise has setup instructions, form cues and a video
          demonstration.
        </p>
        <Link
          className="bent-button bent-button--outline"
          to="/guides"
          search={{ date }}
        >
          Open exercise guides <span aria-hidden>↗</span>
        </Link>
      </div>
    </section>
  );
}
export function HistoryScreen() {
  const { sync, settings } = useAccount();
  const records = sync.records;
  const sessions = records
    .filter(
      (r) =>
        (r.data.kind === "workout" && r.data.finishedAt) ||
        r.data.kind === "run",
    )
    .sort((a, b) =>
      "date" in a.data && "date" in b.data
        ? b.data.date.localeCompare(a.data.date)
        : 0,
    );
  return (
    <section data-feedback-redact data-feedback-private>
      <p className="eyebrow">Your work, recorded</p>
      <h1>History</h1>
      {sessions.length === 0 && (
        <p>Your completed workouts and runs will appear here.</p>
      )}
      {sessions.map((r) =>
        r.data.kind === "workout" ? (
          <details className="card" key={r.id}>
            <summary>
              {r.data.date} · {r.data.name}
            </summary>
            {r.data.exercises.map((e, i) => (
              <div className="history-exercise" key={i}>
                <strong>{e.prescription.name}</strong>
                <p>
                  {e.sets
                    .map(
                      (s) =>
                        `${displayLoad(s.loadKg, settings.units)} ${settings.units} × ${s.value}${e.prescription.side ? ` / ${s.right}` : ""}${e.prescription.mode === "seconds" ? " seconds" : ""}`,
                    )
                    .join(" · ")}
                </p>
              </div>
            ))}
            <p>{r.data.notes}</p>
          </details>
        ) : r.data.kind === "run" ? (
          <article className="card" key={r.id}>
            <h2>{r.data.date} · Run</h2>
            <p>
              {r.data.minutes} min · {r.data.distanceKm} km
            </p>
            <p>{r.data.notes}</p>
          </article>
        ) : null,
      )}
    </section>
  );
}

export function FoodScreen() {
  const { sync, date, settings } = useAccount();
  return <Nutrition sync={sync} date={date} settings={settings} />;
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
      key={`${revision}:${sync.editorReset}`}
      revision={revision}
      settings={settings}
      sync={sync}
    />
  );
}
export function GuidesScreen() {
  return (
    <section>
      <p className="eyebrow">Learn the movements</p>
      <h1>Exercise guides</h1>
      <p>
        Read the setup, practise with a light weight, then open the tutorial for
        a demonstration.
      </p>
      <p className="muted">
        Each exercise has an illustrated sequence from two angles. Open an
        illustration at full size to inspect the positions.
      </p>
      {exercises.map((exercise) => (
        <article className="card" key={exercise.id}>
          <h2>{exercise.name}</h2>
          <ExerciseGuide id={exercise.id} />
        </article>
      ))}
    </section>
  );
}
