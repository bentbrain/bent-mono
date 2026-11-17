import { useState } from "react";
import { Button } from "@bent/ui/button";
import { displayLoad, toKg, weightSchema } from "../domain";
import type { Settings } from "../domain";
import type { Sync } from "../sync";
import { TextField } from "./fields";
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
  const min = Math.min(...points.map((w) => w.kg)) - 0.5,
    max = Math.max(...points.map((w) => w.kg)) + 0.5;
  const first = points[0],
    last = points.at(-1);
  const x = (date: string) =>
    first && last && last.date !== first.date
      ? 30 +
        ((Date.parse(date) - Date.parse(first.date)) /
          (Date.parse(last.date) - Date.parse(first.date))) *
          540
      : 300;
  const y = (kg: number) => 180 - ((kg - min) / (max - min)) * 140;
  const recent = daily.slice(-7);
  const average = recent.length
    ? recent.reduce((n, w) => n + w.kg, 0) / recent.length
    : null;
  return (
    <section data-feedback-redact data-feedback-private>
      <p className="eyebrow">The longer view</p>
      <h1>Bodyweight</h1>
      <div className="card">
        <p className="eyebrow">Latest 7 weigh-ins · average</p>
        <strong className="big-number">
          {average ? displayLoad(average, settings.units) : "—"}{" "}
          <small>{settings.units}</small>
        </strong>
        {points.length ? (
          <svg
            className="weight-chart"
            viewBox="0 0 600 225"
            role="img"
            aria-label={`Bodyweight across ${points.length} recorded dates. Full values are listed below.`}
          >
            <line
              x1="30"
              x2="570"
              y1="180"
              y2="180"
              stroke="currentColor"
              opacity=".2"
            />
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
            <text x="30" y="212">
              {first?.date}
            </text>
            <text x="570" y="212" textAnchor="end">
              {last?.date}
            </text>
            <text x="30" y="22">
              {displayLoad(max, settings.units)} {settings.units}
            </text>
          </svg>
        ) : (
          <p>Add your first weigh-in to start the chart.</p>
        )}
      </div>
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
            <span>{w.date}</span>
            <strong>
              {displayLoad(w.kg, settings.units)} {settings.units}
            </strong>
            <Button appearance="ghost" onClick={() => sync.put(null, w.id)}>
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
