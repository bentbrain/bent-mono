import { useState } from "react";
import { Button } from "@bent/ui/button";
import {
  displayLoad,
  formatDate,
  formatShortDate,
  toKg,
  weightSchema,
} from "../domain";
import type { Settings } from "../domain";
import type { Sync } from "../sync";
import { DateBar } from "./date-bar";
import { TextField } from "./fields";
import { ProgressTabs } from "./progress-screen";
export function Bodyweight({
  sync,
  date,
  settings,
}: {
  sync: Sync;
  date: string;
  settings: Settings;
}) {
  const [error, setError] = useState("");
  const weights = sync.records
    .flatMap((r) => (r.data.kind === "weight" ? [{ ...r.data, id: r.id }] : []))
    .sort((a, b) => a.date.localeCompare(b.date));
  const daily = weights.filter(
    (w, i) => weights.findLastIndex((v) => v.date === w.date) === i,
  );
  const points = daily.slice(-60);
  const lowest = Math.min(...points.map((w) => w.kg)),
    highest = Math.max(...points.map((w) => w.kg));
  const min = lowest - 0.5,
    max = highest + 0.5;
  const rounded = (kg: number) =>
    (Math.round(displayLoad(kg, settings.units) * 10) / 10).toFixed(1);
  const shown = (kg: number) => `${rounded(kg)} ${settings.units}`;
  const first = points[0],
    last = points.at(-1);
  const x = (date: string) =>
    first && last && last.date !== first.date
      ? 30 +
        ((Date.parse(date) - Date.parse(first.date)) /
          (Date.parse(last.date) - Date.parse(first.date))) *
          540
      : 300;
  const y = (kg: number) => 175 - ((kg - min) / (max - min)) * 125;
  const trend = points.map((point, index) => {
    const window = points.slice(Math.max(0, index - 6), index + 1);
    return {
      date: point.date,
      kg: window.reduce((sum, item) => sum + item.kg, 0) / window.length,
    };
  });
  const recent = daily.slice(-7);
  const average = recent.length
    ? recent.reduce((n, w) => n + w.kg, 0) / recent.length
    : null;
  return (
    <section data-feedback-redact data-feedback-private>
      <header className="page-head">
        <p className="eyebrow">Progress</p>
        <h1>Bodyweight</h1>
      </header>
      <ProgressTabs />
      <DateBar path="/body" step />
      <div className="card">
        <p className="eyebrow">Latest 7 weigh-ins · average</p>
        <strong className="big-number">
          {average !== null ? rounded(average) : "—"}{" "}
          <small>{settings.units}</small>
        </strong>
        {points.length ? (
          <svg
            className="weight-chart"
            viewBox="0 0 600 250"
            role="img"
            aria-label={`Bodyweight across ${points.length} recorded dates, from ${shown(lowest)} to ${shown(highest)}. All weigh-ins are listed below.`}
          >
            {[
              { kg: highest, name: "High" },
              { kg: lowest, name: "Low" },
            ]
              .slice(0, lowest === highest ? 1 : 2)
              .map((line) => (
                <g key={line.name}>
                  <line
                    x1="30"
                    x2="570"
                    y1={y(line.kg)}
                    y2={y(line.kg)}
                    stroke="currentColor"
                    opacity=".25"
                    strokeDasharray="2 6"
                  />
                  <text
                    x="570"
                    y={line.name === "High" ? y(line.kg) - 10 : y(line.kg) + 28}
                    textAnchor="end"
                  >
                    {line.name} {shown(line.kg)}
                  </text>
                </g>
              ))}
            <polyline
              points={points.map((w) => `${x(w.date)},${y(w.kg)}`).join(" ")}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="3"
            />
            {points.map((w) => (
              <circle
                key={w.id}
                cx={x(w.date)}
                cy={y(w.kg)}
                r="4"
                fill="var(--accent)"
              />
            ))}
            <polyline
              points={trend
                .map((point) => `${x(point.date)},${y(point.kg)}`)
                .join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeDasharray="8 5"
            />
            <text x="30" y="240">
              {first ? formatShortDate(first.date) : ""}
            </text>
            <text x="570" y="240" textAnchor="end">
              {last && last.date !== first?.date
                ? formatShortDate(last.date)
                : ""}
            </text>
          </svg>
        ) : (
          <p>Add your first weigh-in to start the chart.</p>
        )}
      </div>
      {points.length > 0 && (
        <p className="chart-legend">
          Blue line: each weigh-in. Dashed black line: average of up to 7
          weigh-ins ending on that date. Dotted lines mark your highest and
          lowest weigh-ins in this view.
        </p>
      )}
      <form
        className="card form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const f = e.currentTarget;
          const data = new FormData(f);
          const result = weightSchema.safeParse({
            kind: "weight",
            date: data.get("date"),
            kg: toKg(Number(data.get("weight")), settings.units),
          });
          if (!result.success) {
            setError("Enter a valid date and weight.");
            return;
          }
          const existing = sync.records.find(
            (r) => r.data.kind === "weight" && r.data.date === result.data.date,
          );
          if (sync.put(result.data, existing?.id)) {
            f.reset();
            setError("");
          }
        }}
      >
        <TextField
          label="Date"
          id="weight-date"
          name="date"
          type="date"
          defaultValue={date}
          required
        />
        <TextField
          label={`Weight · ${settings.units}`}
          id="bodyweight"
          name="weight"
          type="number"
          inputMode="decimal"
          min={Math.ceil(displayLoad(20, settings.units) * 10) / 10}
          max={Math.floor(displayLoad(500, settings.units) * 10) / 10}
          step="0.1"
          required
        />
        <Button type="submit" appearance="primary">
          Save weigh-in
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
      <details>
        <summary>All weigh-ins</summary>
        {[...daily].reverse().map((w) => (
          <div className="list-row" key={w.id}>
            <span>{formatDate(w.date)}</span>
            <strong>
              {displayLoad(w.kg, settings.units)} {settings.units}
            </strong>
            <Button
              appearance="ghost"
              aria-label={`Remove weigh-in ${formatDate(w.date)}`}
              onClick={() =>
                window.confirm(`Remove weigh-in for ${formatDate(w.date)}?`) &&
                sync.put(null, w.id)
              }
            >
              Remove
            </Button>
          </div>
        ))}
      </details>
      <p className="muted">
        Compare trends over 2–3 weeks under similar weighing conditions.
        Carbohydrate changes and starting creatine can change water weight. Give
        those changes time to settle before adjusting calories.
      </p>
    </section>
  );
}
