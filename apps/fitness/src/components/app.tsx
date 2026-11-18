import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router";
import { AccountContext, useAccount } from "./account-context";
import { UserButton, SignInButton, useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@bent/ui/button";
import {
  addDays,
  completedActivity,
  dateSearch,
  exercises,
  formatDate,
  formatShortDate,
  localDate,
  nextSession,
  scheduled,
  sessionMinutes,
  settingsId,
  totals,
} from "../domain";
import { load, save } from "../server/functions";
import { useSync } from "../sync";
import { download } from "./fields";
import { Nutrition } from "./nutrition";
import { Bodyweight } from "./bodyweight";
import { Onboarding, SettingsEditor } from "./settings";
import { History } from "./history";
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
        <Button appearance="primary">
          Sign in to your plan <span aria-hidden>→</span>
        </Button>
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
const datedPages = ["/", "/food", "/body"] as const;
const navigation = [
  { to: "/", name: "Today", icon: "◷" },
  { to: "/food", name: "Food", icon: "+" },
  { to: "/body", name: "Body", icon: "∿" },
  { to: "/history", name: "History", icon: "≡" },
  { to: "/guides", name: "Guides", icon: "?" },
  { to: "/settings", name: "Settings", icon: "⚙" },
] satisfies {
  to: "/" | "/food" | "/body" | "/history" | "/settings" | "/guides";
  name: string;
  icon: string;
}[];
function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function Account({ owner }: { owner: string }) {
  const sync = useSync(owner, transport);
  const location = useLocation();
  const navigate = useNavigate();
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
  const datedPage = datedPages.find((path) => path === location.pathname);
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
        <Link className="wordmark" to="/" search={{}}>
          bent<span>/</span>fitness
        </Link>
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
                  : inputPending
                    ? "Unsaved input on device"
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
        {navigation.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            search={{}}
            activeOptions={{ exact: true }}
            aria-current={
              (
                item.to === "/"
                  ? ["/", "/plan", "/workout", "/run"].includes(
                      location.pathname,
                    )
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
        {datedPage && settings && (
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
              onChange={(event) =>
                void navigate({
                  to: datedPage,
                  search: dateSearch(event.target.value || today, today),
                })
              }
            />
          </div>
        )}
        {datedPage && settings && date !== today && (
          <p className="date-banner" data-feedback-private data-feedback-redact>
            <span>
              Viewing {formatDate(date)}. New entries here use this date.
            </span>{" "}
            <Link to={datedPage} search={{}}>
              Return to today
            </Link>
          </p>
        )}
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
      <footer className="app-footer">
        bent.build · One session at a time.
      </footer>
    </div>
  );
}
export function TodayScreen() {
  const { sync, date, today, settings } = useAccount();
  const active = sync.records.find(
    (r) => r.data.kind === "workout" && !r.data.finishedAt,
  );
  const plan = scheduled(settings, date);
  const recorded = completedActivity(sync.records).get(date);
  const upcoming = nextSession(settings, date, sync.records);
  const food = totals(sync.records, date);
  const isToday = date === today;
  const onDay = isToday ? "today" : `on ${formatDate(date)}`;
  const next = upcoming?.plan;
  const nextDate = upcoming?.date ?? date;
  const tag =
    nextDate !== date
      ? `Next session · ${formatDate(nextDate)}`
      : isToday
        ? "Up next · Today"
        : date < today
          ? `Not recorded · ${formatDate(date)}`
          : `Planned · ${formatDate(date)}`;
  return (
    <section data-feedback-private data-feedback-redact>
      <p className="eyebrow">
        {isToday ? "Today · " : ""}
        {formatDate(date)}
      </p>
      <h1>Keep showing up.</h1>
      <p className="subtitle">{settings.goal}</p>
      {recorded && (
        <p className="card recorded">
          {recorded.strength && recorded.run
            ? "Strength and run"
            : recorded.strength
              ? "Strength workout"
              : "Run"}{" "}
          recorded {onDay}.{" "}
          <Link to="/history" search={dateSearch(date, today)}>
            View results
          </Link>
        </p>
      )}
      {active?.data.kind === "workout" ? (
        <aside className="card active-workout">
          <span className="tag">
            Workout in progress · {formatDate(active.data.date)}
          </span>
          <h2>{active.data.name}</h2>
          <p>Your timers and results are saved. Pick up where you left off.</p>
          <Link
            className="bent-button bent-button--primary"
            to="/workout"
            search={{ workoutId: active.id }}
          >
            Resume workout
          </Link>
        </aside>
      ) : next ? (
        <div className="hero card">
          <div className="hero-top">
            <span className="tag">{tag}</span>
            <span>
              {next.type === "strength" && next.routine
                ? `About ${sessionMinutes(next.routine, next.intro)} min`
                : "Conversational pace"}
            </span>
          </div>
          <h2>{next.type === "strength" ? next.routine?.name : "Easy run"}</h2>
          <p>
            {nextDate !== date
              ? plan.type === "rest"
                ? `Rest ${onDay}. Your next session is on ${formatDate(nextDate)}.`
                : `Your session ${onDay} is recorded. Next is on ${formatDate(nextDate)}.`
              : next.type === "strength"
                ? `${next.routine?.exercises.length ?? 0} exercises · ${next.intro ? "Introduction · up to 2 sets each" : "Full session"}`
                : "Keep it comfortable enough to talk in sentences."}
          </p>
          {next.type === "strength" && next.routine ? (
            <Link
              className="bent-button bent-button--primary"
              to="/plan"
              search={{
                ...dateSearch(nextDate, today),
                routineId: next.routine.id,
              }}
            >
              View workout plan <span aria-hidden>→</span>
            </Link>
          ) : (
            <Link
              className="bent-button bent-button--primary"
              to="/run"
              search={dateSearch(nextDate, today)}
            >
              View run plan <span aria-hidden>→</span>
            </Link>
          )}
        </div>
      ) : (
        <div className="hero card">
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
              search={{ ...dateSearch(date, today), routineId: routine.id }}
            >
              View {routine.name} plan
            </Link>
          ))}
          <Link
            className="bent-button bent-button--outline"
            to="/run"
            search={dateSearch(date, today)}
          >
            Record an unscheduled run
          </Link>
        </div>
      )}
      <div className="section-heading">
        <h2>Your week</h2>
        <span className="muted">{settings.timezone}</span>
      </div>
      <Schedule date={date} />
      <h2>{isToday ? "Today's fuel" : `Fuel · ${formatDate(date)}`}</h2>
      <div className="metrics card">
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
          search={{}}
        >
          Open exercise guides <span aria-hidden>→</span>
        </Link>
      </div>
    </section>
  );
}
function Schedule({ date }: { date: string }) {
  const { settings, sync, today } = useAccount();
  const activity = completedActivity(sync.records);
  const monday = addDays(
    date,
    -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7),
  );
  return (
    <nav className="schedule-browser" aria-label="Training week">
      <p className="schedule-range">
        Week of {formatShortDate(monday)} to{" "}
        {formatShortDate(addDays(monday, 6))}
      </p>
      <div className="schedule-controls">
        <Link to="/" search={dateSearch(addDays(date, -7), today)}>
          <span aria-hidden>←</span> Previous week
        </Link>
        <Link to="/" search={dateSearch(addDays(date, 7), today)}>
          Next week <span aria-hidden>→</span>
        </Link>
      </div>
      <ol className="schedule-days">
        {Array.from({ length: 7 }, (_, i) => {
          const day = addDays(monday, i);
          const plan = scheduled(settings, day);
          const done = activity.get(day);
          const completed =
            plan.type === "strength"
              ? done?.strength
              : plan.type === "run"
                ? done?.run
                : false;
          const other = !completed && (done?.strength || done?.run);
          const name =
            plan.type === "strength"
              ? (plan.routine?.name ?? "Strength")
              : plan.type === "run"
                ? "Easy run"
                : "Rest";
          const status = completed
            ? "Done"
            : other
              ? "Activity recorded"
              : plan.type === "rest"
                ? "Rest day"
                : day < today
                  ? "Not recorded"
                  : "Planned";
          const state =
            completed || other
              ? "done"
              : day < today && plan.type !== "rest"
                ? "missed"
                : "planned";
          const content = (
            <>
              <span>
                {formatShortDate(day)}
                {day === today ? " · Today" : ""}
              </span>
              <strong>{name}</strong>
              <small className={`status-${state}`}>{status}</small>
              <span aria-hidden>→</span>
            </>
          );
          const props = {
            className: `schedule-day ${day === today ? "current" : ""} ${day === date ? "selected" : ""}`,
            "aria-current": day === date ? ("date" as const) : undefined,
            "aria-label": `${formatDate(day)}${day === today ? ", today" : ""}: ${name}, ${status}`,
          };
          return (
            <li key={day}>
              {completed || other ? (
                <Link {...props} to="/history" search={dateSearch(day, today)}>
                  {content}
                </Link>
              ) : plan.type === "strength" && plan.routine ? (
                <Link
                  {...props}
                  to="/plan"
                  search={{
                    ...dateSearch(day, today),
                    routineId: plan.routine.id,
                  }}
                >
                  {content}
                </Link>
              ) : plan.type === "run" ? (
                <Link {...props} to="/run" search={dateSearch(day, today)}>
                  {content}
                </Link>
              ) : (
                <Link {...props} to="/" search={dateSearch(day, today)}>
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
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
