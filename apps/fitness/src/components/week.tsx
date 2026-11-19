import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  addDays,
  completedActivity,
  dateSearch,
  effectivePrescription,
  formatDate,
  formatShortDate,
  mondayOf,
  nextSession,
  scheduled,
  sessionMinutes,
  totals,
} from "../domain";
import type { DayActivity, RecordEntry, Settings } from "../domain";
import { elapsedSeconds, formatDuration } from "../timing";
import { weeklySummary } from "../progress";
import { useAccount } from "./account-context";
import { DateBar } from "./date-bar";
import { ExerciseHelp, ExerciseThumb, prescriptionText } from "./exercises";
import { Icon } from "./icons";
import { useStartWorkout } from "./start-workout";

import { ReorganiseWeek } from "./reorganise-week";

type DayState = "done" | "missed" | "planned" | "rest";

/** What a day holds in the repeating week and what was recorded on it. */
function dayInfo(
  settings: Settings,
  activity: Map<string, DayActivity>,
  day: string,
  today: string,
) {
  const plan = scheduled(settings, day);
  const done = activity.get(day);
  const completed =
    plan.type === "strength"
      ? Boolean(done?.strength)
      : plan.type === "run"
        ? Boolean(done?.run)
        : false;
  const other = !completed && Boolean(done?.strength || done?.run);
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
  const state: DayState =
    completed || other
      ? "done"
      : plan.type === "rest"
        ? "rest"
        : day < today
          ? "missed"
          : "planned";
  return { plan, done, completed, other, name, status, state };
}

/** Splits "Strength A" into "Strength" and "A" for the narrow week board. */
function boardLabel(type: string, name: string) {
  if (type === "rest") return ["Rest", ""];
  if (type === "run") return ["Run", ""];
  const match = /^Strength\s+(.+)$/.exec(name);
  return match ? ["Strength", match[1] ?? ""] : [name, ""];
}

export function WeekScreen() {
  const { sync, date, settings } = useAccount();
  const monday = mondayOf(date);
  return (
    <section className="week-screen" data-feedback-private data-feedback-redact>
      <header className="page-head">
        <h1>Your week</h1>
        <p className="subtitle">{settings.goal}</p>
      </header>
      <DateBar path="/" />
      <div className="week-card">
        <WeekBoard monday={monday} />
        <div className="week-card-foot">
          <p className="board-legend" aria-hidden="true">
            <span>
              <i className="mark state-done" />
              Done
            </span>
            <span>
              <i className="mark state-planned" />
              Planned
            </span>
            <span>
              <i className="mark state-missed" />
              Not recorded
            </span>
            <span>
              <i className="mark state-rest" />
              Rest
            </span>
          </p>
          <ReorganiseWeek monday={monday} />
        </div>
      </div>
      <div className="week-main">
        <DayPanel day={date} />
      </div>
      <WeekTotals monday={monday} records={sync.records} />
    </section>
  );
}

function WeekBoard({ monday }: { monday: string }) {
  const { settings, sync, today, date } = useAccount();
  const activity = completedActivity(sync.records);
  return (
    <nav className="week-board" aria-label="Training week">
      <div className="board-head">
        <Link
          className="icon-button"
          to="/"
          search={dateSearch(addDays(date, -7), today)}
        >
          <Icon name="back" />
          <span className="visually-hidden">Previous week</span>
        </Link>
        <p className="board-range">
          {formatShortDate(monday)} – {formatShortDate(addDays(monday, 6))}
        </p>
        <Link
          className="icon-button"
          to="/"
          search={dateSearch(addDays(date, 7), today)}
        >
          <span className="visually-hidden">Next week</span>
          <Icon name="forward" />
        </Link>
      </div>
      <ol className="board-days">
        {Array.from({ length: 7 }, (_, index) => {
          const day = addDays(monday, index);
          const info = dayInfo(settings, activity, day, today);
          const [kind, detail] = boardLabel(info.plan.type, info.name);
          const weekday = formatShortDate(day).split(" ")[0];
          return (
            <li key={day}>
              <Link
                className={`board-day type-${info.plan.type} state-${info.state}${day === today ? " is-today" : ""}`}
                to="/"
                search={dateSearch(day, today)}
                aria-label={`${formatDate(day)}${day === today ? ", today" : ""}: ${info.name}, ${info.status}`}
              >
                <span className="day-name">{weekday}</span>
                <span className="day-number">{Number(day.slice(8))}</span>
                <span className="day-kind">
                  {kind}
                  {detail && <b>{detail}</b>}
                </span>
                <i className={`mark state-${info.state}`}>
                  {info.state === "done" ? (
                    <Icon name="check" size={12} />
                  ) : info.state === "missed" ? (
                    <Icon name="minus" size={12} />
                  ) : null}
                </i>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ResumePanel({ record }: { record: RecordEntry }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (record.data.kind !== "workout") return null;
  const sets = record.data.exercises.flatMap((exercise) => exercise.sets);
  const handled = sets.filter((set) => set.done || set.skipped).length;
  return (
    <aside className="now-panel is-active active-workout">
      <p className="now-label">
        <span className="status-pill">Workout in progress</span>{" "}
        {formatDate(record.data.date)}
      </p>
      <h2>{record.data.name}</h2>
      <p className="now-meta">
        <span role="timer" aria-label="Elapsed time">
          {formatDuration(elapsedSeconds(record.data.startedAt, now))}
        </span>
        <span>
          {handled}/{sets.length} sets handled
        </span>
      </p>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${(handled / sets.length) * 100}%` }} />
      </div>
      <p className="now-note">
        Your timers and results are saved. Pick up where you left off.
      </p>
      <div className="now-actions">
        <Link
          className="bent-button bent-button--primary"
          to="/workout"
          search={{ workoutId: record.id }}
        >
          Resume workout
        </Link>
      </div>
    </aside>
  );
}

function DayPanel({ day }: { day: string }) {
  const { sync, settings, today } = useAccount();
  const { start, starting, active } = useStartWorkout();
  const activity = completedActivity(sync.records);
  const info = dayInfo(settings, activity, day, today);
  const { plan } = info;
  const label = day === today ? "Today" : formatDate(day);
  const upcoming = nextSession(settings, day, sync.records);
  const following = upcoming && upcoming.date !== day ? upcoming : undefined;
  const routine = plan.type === "strength" ? plan.routine : undefined;
  const recorded = info.completed || info.other;
  const results = (
    <Link
      className="bent-button bent-button--outline"
      to="/history"
      search={dateSearch(day, today)}
    >
      View results
    </Link>
  );
  const next = following && (
    <p className="now-next">
      Next: {formatDate(following.date)} ·{" "}
      {following.plan.type === "strength" && following.plan.routine ? (
        <Link
          to="/plan"
          search={{
            ...dateSearch(following.date, today),
            routineId: following.plan.routine.id,
          }}
        >
          {following.plan.routine.name}
        </Link>
      ) : (
        <Link to="/run" search={dateSearch(following.date, today)}>
          Easy run
        </Link>
      )}
    </p>
  );
  return (
    <>
      {active ? (
        <ResumePanel record={active} />
      ) : (
        <article className={`now-panel state-${info.state}`}>
          <p className="now-label">
            {label} <span className="status-pill">{info.status}</span>
          </p>
          <h2>{info.name}</h2>
          {recorded ? (
            <>
              <p>
                {info.done?.strength && info.done.run
                  ? "Strength and run"
                  : info.done?.strength
                    ? "Strength workout"
                    : "Run"}{" "}
                recorded {day === today ? "today" : `on ${formatDate(day)}`}.
              </p>
              <div className="now-actions">{results}</div>
              {next}
            </>
          ) : routine ? (
            <>
              <p className="now-meta">
                <span>About {sessionMinutes(routine, plan.intro)} min</span>
                <span>{routine.exercises.length} exercises</span>
                <span>
                  {plan.intro ? "Introduction · up to 2 sets" : "Full sets"}
                </span>
              </p>
              <div className="now-actions">
                {day === today && (
                  <button
                    type="button"
                    className="bent-button bent-button--primary"
                    disabled={starting}
                    onClick={() => start(routine, today)}
                  >
                    {starting ? "Opening workout…" : "Start workout"}
                  </button>
                )}
                <Link
                  className={`bent-button ${day === today ? "bent-button--outline" : "bent-button--primary"}`}
                  to="/plan"
                  search={{ ...dateSearch(day, today), routineId: routine.id }}
                >
                  View workout plan
                </Link>
              </div>
              {day > today && (
                <p className="now-note">
                  Planned. The plan shows last time's results and suggested
                  loads.
                </p>
              )}
              {day < today && (
                <p className="now-note">
                  Not recorded. Open the plan to log it for this date or do it
                  today.
                </p>
              )}
            </>
          ) : plan.type === "run" ? (
            <>
              <p>Keep it comfortable enough to talk in sentences.</p>
              <div className="now-actions">
                <Link
                  className="bent-button bent-button--primary"
                  to="/run"
                  search={dateSearch(day, today)}
                >
                  {day > today ? "View run plan" : "Record run"}
                </Link>
              </div>
            </>
          ) : (
            <>
              <p>
                {upcoming
                  ? "A recovery day. Light walking is fine."
                  : "No training days are scheduled. Choose days in Repeating week."}
              </p>
              {next}
              {day <= today && (
                <div className="now-actions">
                  <Link
                    className="bent-button bent-button--outline"
                    to="/run"
                    search={dateSearch(day, today)}
                  >
                    Record an unscheduled run
                  </Link>
                </div>
              )}
            </>
          )}
        </article>
      )}
      {routine && !recorded && (
        <section className="agenda" aria-label={`${routine.name} exercises`}>
          <h2 className="section-label">{routine.name} exercises</h2>
          <ol className="agenda-list">
            {routine.exercises.map((exercise, index) => (
              <li className="agenda-item" key={`${exercise.id}:${index}`}>
                <ExerciseThumb id={exercise.id} />
                <span>
                  <strong>{exercise.name}</strong>
                  <small>
                    {prescriptionText(
                      effectivePrescription(exercise, plan.intro),
                    )}
                  </small>
                </span>
                <ExerciseHelp id={exercise.id} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

function WeekTotals({
  monday,
  records,
}: {
  monday: string;
  records: RecordEntry[];
}) {
  const { settings, today, date } = useAccount();
  const summary = weeklySummary(settings, records, monday, 1)[0];
  const strength = summary?.strength ?? { done: 0, planned: 0 };
  const runs = summary?.runs ?? { done: 0, planned: 0 };
  const food = totals(records, date);
  return (
    <section className="week-totals" aria-label="Week totals">
      <h2 className="section-label">This week</h2>
      <dl className="tally">
        {[
          { name: "Strength", value: strength },
          { name: "Runs", value: runs },
        ].map(({ name, value }) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              <strong>{value.done}</strong> of {value.planned} planned
              <span className="pips" aria-hidden="true">
                {Array.from(
                  { length: Math.min(7, Math.max(value.planned, value.done)) },
                  (_, i) => (
                    <i key={i} className={i < value.done ? "is-on" : ""} />
                  ),
                )}
              </span>
            </dd>
          </div>
        ))}
        <div>
          <dt>Food · {date === today ? "today" : formatShortDate(date)}</dt>
          <dd>
            <Link to="/food" search={dateSearch(date, today)}>
              <strong>{Math.round(food.calories)}</strong> of{" "}
              {settings.calories} kcal · {Math.round(food.protein)} of{" "}
              {settings.protein} g protein
            </Link>
          </dd>
        </div>
      </dl>
      <p className="rotation-note">
        Repeating strength days take turns through{" "}
        {settings.routines.map((routine) => routine.name).join(", ")} in
        calendar order. Reorganised sessions keep their chosen routine.{" "}
        <Link to="/schedule" search={{}}>
          Edit repeating week
        </Link>
      </p>
    </section>
  );
}
