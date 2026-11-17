import { useEffect, useState } from "react";
import { UserButton, SignInButton, useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@bent/ui/button";
import {
  addDays,
  createWorkout,
  displayLoad,
  exercises,
  localDate,
  runSchema,
  scheduled,
  totals,
} from "../domain";
import type { RecordEntry, Settings } from "../domain";
import { load, save } from "../server/functions";
import { useSync } from "../sync";
import { download, TextField } from "./fields";
import { WorkoutEditor } from "./workout";
import { Nutrition } from "./nutrition";
import { Bodyweight } from "./bodyweight";
import { Onboarding, SettingsEditor } from "./settings";
import { ExerciseGuide } from "./guide";
const transport = {
  load: () => load(),
  save: (request: Parameters<typeof save>[0]["data"]) =>
    save({ data: request }),
};
type Tab = "today" | "food" | "body" | "history" | "settings" | "guides";
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
  const [tab, setTab] = useState<Tab>("today");
  const settings =
    sync.settings?.kind === "settings" ? sync.settings : undefined;
  const [selectedDate, setSelectedDate] = useState("");
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
        <div className="account-tools">
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
        {[
          { id: "today", name: "Today", icon: "◷" },
          { id: "food", name: "Food", icon: "+" },
          { id: "body", name: "Body", icon: "↗" },
          { id: "history", name: "History", icon: "≡" },
          { id: "settings", name: "Settings", icon: "⚙" },
        ].map((item) => (
          <button
            key={item.id}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => {
              if (
                item.id === "today" ||
                item.id === "food" ||
                item.id === "body" ||
                item.id === "history" ||
                item.id === "settings"
              )
                setTab(item.id);
              window.scrollTo(0, 0);
            }}
          >
            <span aria-hidden>{item.icon}</span>
            {item.name}
          </button>
        ))}
      </nav>
      <main className="content">
        <div className="date-control">
          <label htmlFor="view-date">Your day</label>
          <input
            id="view-date"
            type="date"
            value={date}
            onChange={(e) => setSelectedDate(e.target.value)}
          />
          {selectedDate && (
            <button onClick={() => setSelectedDate("")}>Today</button>
          )}
        </div>
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
          <>
            {tab === "today" && (
              <Today
                sync={sync}
                date={date}
                settings={settings}
                guides={() => setTab("guides")}
              />
            )}
            {tab === "food" && (
              <Nutrition sync={sync} date={date} settings={settings} />
            )}
            {tab === "body" && (
              <Bodyweight sync={sync} date={date} settings={settings} />
            )}
            {tab === "settings" && (
              <SettingsEditor
                key={settings.startDate + settings.units}
                settings={settings}
                sync={sync}
              />
            )}
            {tab === "history" && (
              <History records={sync.records} settings={settings} />
            )}
            {tab === "guides" && (
              <section>
                <p className="eyebrow">Learn the movements</p>
                <h1>Exercise guides</h1>
                <p>
                  Read the setup, practise with a light weight, then open the
                  tutorial for a demonstration.
                </p>
                <a
                  href="/exercise-guide-v2.png"
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    className="guide-sheet"
                    src="/exercise-guide-v2.png"
                    alt="Ten exercise illustrations, including dumbbell movements and a forearm plank"
                  />
                </a>
                <p className="muted">
                  AI-generated reference illustration. Use the written steps and
                  video demonstrations for technique.
                </p>
                {exercises.map((e) => (
                  <article className="card" key={e.id}>
                    <h2>{e.name}</h2>
                    <ExerciseGuide id={e.id} />
                  </article>
                ))}
              </section>
            )}
          </>
        )}
      </main>
      <footer className="app-footer">
        bent.build · One session at a time.
      </footer>
    </div>
  );
}
function Today({
  sync,
  date,
  settings,
  guides,
}: {
  sync: ReturnType<typeof useSync>;
  date: string;
  settings: Settings;
  guides: () => void;
}) {
  const active = sync.records.find(
    (r) => r.data.kind === "workout" && !r.data.finishedAt,
  );
  const today = scheduled(settings, date);
  let nextDate = date;
  for (let i = 0; i < 14; i++) {
    const plan = scheduled(settings, nextDate);
    const already = sync.records.some(
      (r) =>
        (r.data.kind === "workout" &&
          r.data.finishedAt &&
          plan.type === "strength" &&
          r.data.date === nextDate) ||
        (r.data.kind === "run" &&
          plan.type === "run" &&
          r.data.date === nextDate),
    );
    if (plan.type !== "rest" && !already) break;
    nextDate = addDays(nextDate, 1);
  }
  const next = scheduled(settings, nextDate),
    food = totals(sync.records, date);
  const [runOpen, setRunOpen] = useState(false),
    [runError, setRunError] = useState("");
  if (active?.data.kind === "workout")
    return (
      <WorkoutEditor
        entry={{ ...active, data: active.data }}
        settings={settings}
        sync={sync}
      />
    );
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
      <p className="subtitle">{settings.goal}</p>
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
              ? `${next.routine?.exercises.length ?? 0} exercises · ${next.intro ? "Introduction · 2 sets each" : "Full session"}`
              : "Keep it comfortable enough to talk in sentences."}
        </p>
        <Button
          appearance="primary"
          onClick={() => {
            if (next.type === "strength" && next.routine)
              sync.put(
                createWorkout(
                  settings,
                  next.routine,
                  nextDate,
                  next.intro,
                  sync.records,
                ),
              );
            else setRunOpen(true);
          }}
        >
          {next.type === "strength" ? "Start workout" : "Log run"}{" "}
          <span aria-hidden>↗</span>
        </Button>
      </div>
      {runOpen && (
        <form
          className="card form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const result = runSchema.safeParse({
              kind: "run",
              date: f.get("date"),
              minutes: Number(f.get("minutes")),
              distanceKm: Number(f.get("distance")),
              notes: f.get("notes"),
            });
            if (!result.success) {
              setRunError("Enter a valid date, duration and distance.");
              return;
            }
            if (sync.put(result.data)) {
              setRunOpen(false);
              setRunError("");
            }
          }}
        >
          <h2>Record your run</h2>
          <TextField
            label="Date"
            id="run-date"
            name="date"
            type="date"
            defaultValue={nextDate}
            required
          />
          <TextField
            label="Duration · minutes"
            id="run-minutes"
            name="minutes"
            type="number"
            min="1"
            max="1440"
            required
          />
          <TextField
            label="Distance · km"
            id="run-distance"
            name="distance"
            type="number"
            min="0"
            max="500"
            step="0.01"
            required
          />
          <TextField
            label="Notes"
            id="run-notes"
            name="notes"
            maxLength={2000}
          />
          <Button type="submit" appearance="primary">
            Save run
          </Button>
          {runError && <p role="alert">{runError}</p>}
        </form>
      )}
      <div className="section-heading">
        <h2>Next seven days</h2>
        <span className="muted">{settings.timezone}</span>
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
        <Button appearance="outline" onClick={guides}>
          Open exercise guides ↗
        </Button>
      </div>
    </section>
  );
}
function History({
  records,
  settings,
}: {
  records: RecordEntry[];
  settings: Settings;
}) {
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
