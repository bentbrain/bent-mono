import { Link, useLocation } from "@tanstack/react-router";
import {
  dateSearch,
  displayLoad,
  formatDate,
  formatShortDate,
  mondayOf,
  trainingRecords,
} from "../domain";
import type { Settings } from "../domain";
import {
  dailyWeights,
  strengthSeries,
  weeklySummary,
  weightTrend,
} from "../progress";
import type { StrengthPoint, StrengthSeries } from "../progress";
import { useAccount } from "./account-context";

const sections = [
  { to: "/progress", name: "Overview" },
  { to: "/history", name: "Sessions" },
  { to: "/body", name: "Bodyweight" },
] satisfies { to: "/progress" | "/history" | "/body"; name: string }[];

/** Moves between the Progress overview, session history and bodyweight. */
export function ProgressTabs() {
  const location = useLocation();
  return (
    <nav className="segmented" aria-label="Progress sections">
      {sections.map((section) => (
        <Link
          key={section.to}
          to={section.to}
          search={{}}
          aria-current={location.pathname === section.to ? "page" : undefined}
        >
          {section.name}
        </Link>
      ))}
    </nav>
  );
}

/** A single-series line with first and latest values marked. */
function Sparkline({
  values,
  label,
}: {
  values: { key: string; value: number; title: string }[];
  label: string;
}) {
  const width = 300;
  const height = 72;
  const low = Math.min(...values.map((v) => v.value));
  const high = Math.max(...values.map((v) => v.value));
  const spread = high - low || 1;
  const x = (index: number) =>
    values.length > 1
      ? 8 + (index / (values.length - 1)) * (width - 16)
      : width / 2;
  const y = (value: number) =>
    high === low
      ? height / 2
      : height - 10 - ((value - low) / spread) * (height - 20);
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <line
        className="baseline"
        x1="0"
        x2={width}
        y1={height - 1}
        y2={height - 1}
      />
      <polyline
        points={values.map((v, i) => `${x(i)},${y(v.value)}`).join(" ")}
      />
      {values.map((v, i) => (
        <circle
          key={v.key}
          cx={x(i)}
          cy={y(v.value)}
          r={i === values.length - 1 ? 4 : 2.5}
          className={i === values.length - 1 ? "is-latest" : undefined}
        >
          <title>{v.title}</title>
        </circle>
      ))}
    </svg>
  );
}

function pointText(
  point: StrengthPoint,
  series: StrengthSeries,
  units: Settings["units"],
) {
  const amount =
    series.mode === "seconds"
      ? `${point.value} s`
      : `${displayLoad(point.loadKg, units)} ${units} × ${point.value}`;
  return series.side ? `${amount} each side` : amount;
}

function StrengthCard({
  series,
  units,
}: {
  series: StrengthSeries;
  units: Settings["units"];
}) {
  const first = series.points[0];
  const latest = series.points.at(-1);
  if (!first || !latest) return null;
  const byLoad =
    series.mode === "reps" &&
    series.points.some((point) => point.loadKg !== first.loadKg);
  const measure =
    series.mode === "seconds"
      ? "Longest completed hold"
      : byLoad
        ? `Heaviest completed set, ${units} per dumbbell`
        : `Reps at ${displayLoad(first.loadKg, units)} ${units}`;
  let change = "";
  if (series.points.length > 1) {
    if (byLoad) {
      const delta =
        displayLoad(latest.loadKg, units) - displayLoad(first.loadKg, units);
      change = delta
        ? `${delta > 0 ? "+" : ""}${Math.round(delta * 100) / 100} ${units}`
        : "No change";
    } else {
      const delta = latest.value - first.value;
      change = delta
        ? `${delta > 0 ? "+" : ""}${delta} ${series.mode === "seconds" ? "s" : "reps"}`
        : "No change";
    }
  }
  return (
    <article className="strength-card">
      <header>
        <h3>{series.name}</h3>
        <span className="chip">
          {series.mode === "seconds" ? "Timed" : "Reps"}
          {series.side ? " · each side" : ""}
        </span>
      </header>
      {series.points.length > 1 ? (
        <>
          <p className="strength-change">
            <strong>{change}</strong> since {formatShortDate(first.date)}
          </p>
          <Sparkline
            label={`${series.name}: ${measure}, ${series.points.length} sessions from ${pointText(first, series, units)} to ${pointText(latest, series, units)}.`}
            values={series.points.map((point, index) => ({
              key: `${point.date}:${index}`,
              value: byLoad ? displayLoad(point.loadKg, units) : point.value,
              title: `${formatShortDate(point.date)}: ${pointText(point, series, units)}`,
            }))}
          />
          <dl className="compare">
            <div>
              <dt>First · {formatShortDate(first.date)}</dt>
              <dd>{pointText(first, series, units)}</dd>
            </div>
            <div>
              <dt>Latest · {formatShortDate(latest.date)}</dt>
              <dd>{pointText(latest, series, units)}</dd>
            </div>
          </dl>
          <p className="measure-note">{measure}</p>
        </>
      ) : (
        <p className="muted">
          One session so far: {pointText(latest, series, units)} on{" "}
          {formatShortDate(latest.date)}. The trend starts after your next
          session.
        </p>
      )}
    </article>
  );
}

export function ProgressScreen() {
  const { sync, settings, today } = useAccount();
  const start = mondayOf(settings.startDate);
  const weeks = weeklySummary(settings, sync.records, today, 8).filter(
    (week) =>
      week.monday >= start || week.strength.done > 0 || week.runs.done > 0,
  );
  const series = strengthSeries(sync.records);
  const daily = dailyWeights(sync.records);
  const trend = weightTrend(daily);
  const recent = trainingRecords(sync.records)
    .flatMap((record) =>
      (record.data.kind === "workout" && record.data.finishedAt) ||
      record.data.kind === "run"
        ? [{ id: record.id, data: record.data }]
        : [],
    )
    .sort((a, b) => b.data.date.localeCompare(a.data.date))
    .slice(0, 5);
  const shown = (kg: number) =>
    `${(Math.round(displayLoad(kg, settings.units) * 10) / 10).toFixed(1)} ${settings.units}`;
  const maxPlanned = Math.min(
    7,
    Math.max(
      1,
      ...weeks.map((w) =>
        Math.max(
          w.strength.planned,
          w.strength.done,
          w.runs.planned,
          w.runs.done,
        ),
      ),
    ),
  );
  return (
    <section data-feedback-private data-feedback-redact>
      <header className="page-head">
        <p className="eyebrow">Measured from your records</p>
        <h1>Progress</h1>
      </header>
      <ProgressTabs />
      <section className="panel" aria-labelledby="consistency">
        <h2 id="consistency" className="section-label">
          Sessions by week
        </h2>
        {weeks.length ? (
          <table className="consistency">
            <thead>
              <tr>
                <th scope="col">Week of</th>
                <th scope="col">Strength</th>
                <th scope="col">Runs</th>
              </tr>
            </thead>
            <tbody>
              {[...weeks].reverse().map((week) => (
                <tr key={week.monday}>
                  <th scope="row">
                    {formatShortDate(week.monday).slice(4)}
                    {week.monday === mondayOf(today) ? (
                      <small> · this week</small>
                    ) : null}
                  </th>
                  {[week.strength, week.runs].map((count, index) => (
                    <td key={index}>
                      <span className="pips" aria-hidden="true">
                        {Array.from(
                          {
                            length: Math.min(
                              7,
                              Math.max(count.planned, count.done, 1),
                            ),
                          },
                          (_, i) => (
                            <i
                              key={i}
                              className={
                                i < count.done
                                  ? "is-on"
                                  : i < count.planned
                                    ? ""
                                    : "is-none"
                              }
                            />
                          ),
                        )}
                        {Array.from(
                          {
                            length:
                              maxPlanned -
                              Math.min(
                                7,
                                Math.max(count.planned, count.done, 1),
                              ),
                          },
                          (_, i) => (
                            <i key={`pad-${i}`} className="is-pad" />
                          ),
                        )}
                      </span>
                      <span>
                        {count.planned
                          ? `${count.done}/${count.planned}`
                          : `${count.done} done`}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Weeks appear here from your plan start date.</p>
        )}
        <p className="measure-note">
          Filled squares are completed sessions; open squares are planned
          sessions not recorded. Weeks before your plan start show completed
          sessions only. Removed workouts do not count.
        </p>
      </section>
      <section className="panel" aria-labelledby="bodyweight">
        <h2 id="bodyweight" className="section-label">
          Bodyweight
        </h2>
        {trend.average !== null ? (
          <div className="weight-summary">
            <p className="big-stat">
              <strong>{shown(trend.average)}</strong>
              <span>
                average of the latest {trend.count} weigh-in
                {trend.count === 1 ? "" : "s"}
              </span>
            </p>
            <p>
              {trend.change !== null
                ? `${trend.change > 0 ? "+" : trend.change < 0 ? "−" : "±"}${shown(Math.abs(trend.change))} compared with the ${trend.comparedCount} weigh-in${trend.comparedCount === 1 ? "" : "s"} before.`
                : "Record more than 7 weigh-ins to compare averages."}
            </p>
            {daily.length > 1 && (
              <Sparkline
                label={`Bodyweight across ${Math.min(daily.length, 30)} recorded dates.`}
                values={daily.slice(-30).map((point) => ({
                  key: point.id,
                  value: point.kg,
                  title: `${formatShortDate(point.date)}: ${shown(point.kg)}`,
                }))}
              />
            )}
          </div>
        ) : (
          <p className="empty">
            No weigh-ins yet. Record one to start your trend.
          </p>
        )}
        <Link className="text-link" to="/body" search={{}}>
          Bodyweight details and weigh-ins
        </Link>
      </section>
      <section className="panel" aria-labelledby="strength">
        <h2 id="strength" className="section-label">
          Strength by exercise
        </h2>
        {series.length ? (
          <div className="strength-grid">
            {series.map((item) => (
              <StrengthCard
                key={item.key}
                series={item}
                units={settings.units}
              />
            ))}
          </div>
        ) : (
          <p className="empty">
            Finish a workout to start tracking each exercise. Each card compares
            your first and latest completed sets.
          </p>
        )}
      </section>
      <section className="panel" aria-labelledby="recent">
        <h2 id="recent" className="section-label">
          Recent sessions
        </h2>
        {recent.length ? (
          <ul className="session-list">
            {recent.map((session) => (
              <li key={session.id}>
                <Link
                  to="/history"
                  search={dateSearch(session.data.date, today)}
                >
                  <span className="session-date">
                    {formatShortDate(session.data.date)}
                  </span>
                  <strong>
                    {session.data.kind === "run"
                      ? "Easy run"
                      : session.data.name}
                  </strong>
                  <small>
                    {session.data.kind === "run"
                      ? `${session.data.minutes} min · ${session.data.distanceKm} km`
                      : `${session.data.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0)} sets done`}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">
            Your completed workouts and runs will appear here.
          </p>
        )}
        <Link className="text-link" to="/history" search={{}}>
          All sessions
        </Link>
      </section>
      <p className="muted">
        Weeks run Monday to Sunday. Today is {formatDate(today)}.
      </p>
    </section>
  );
}
