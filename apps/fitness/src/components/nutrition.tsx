import { useState } from "react";
import { Button } from "@bent/ui/button";
import { mealSchema, regularSchema, totals } from "../domain";
import type { Settings } from "../domain";
import type { Sync } from "../sync";
import { TextField } from "./fields";
export function Nutrition({
  sync,
  date,
  settings,
}: {
  sync: Sync;
  date: string;
  settings: Settings;
}) {
  const [error, setError] = useState("");
  const total = totals(sync.records, date);
  return (
    <section data-feedback-redact data-feedback-private>
      <p className="eyebrow">Fuel your day</p>
      <h1>Food</h1>
      <div className="metrics">
        <div>
          <strong>{Math.round(total.calories)}</strong>
          <span> / {settings.calories} kcal</span>
          <progress value={total.calories} max={settings.calories} />
        </div>
        <div>
          <strong>{Math.round(total.protein)}g</strong>
          <span> / {settings.protein}g protein</span>
          <progress value={total.protein} max={settings.protein} />
        </div>
      </div>
      <h2>Quick entry</h2>
      <form
        className="card form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          const result = mealSchema.safeParse({
            kind: "meal",
            date,
            name: data.get("name"),
            calories: Number(data.get("calories")),
            protein: Number(data.get("protein")),
          });
          if (!result.success) {
            setError("Enter a meal name, calories and protein.");
            return;
          }
          if (sync.put(result.data)) {
            if (data.get("regular"))
              sync.put(
                regularSchema.parse({
                  kind: "regular",
                  name: result.data.name,
                  calories: result.data.calories,
                  protein: result.data.protein,
                }),
              );
            form.reset();
            setError("");
          }
        }}
      >
        <TextField
          label="Meal or snack"
          id="meal-name"
          name="name"
          required
          maxLength={160}
          placeholder="e.g. Yoghurt and berries"
        />
        <TextField
          label="Calories · kcal"
          id="meal-calories"
          name="calories"
          type="number"
          inputMode="decimal"
          min="0"
          max="10000"
          step="any"
          required
        />
        <TextField
          label="Protein · g"
          id="meal-protein"
          name="protein"
          type="number"
          inputMode="decimal"
          min="0"
          max="500"
          step="any"
          required
        />
        <label>
          <input type="checkbox" name="regular" /> Save as a regular meal
        </label>
        <Button appearance="primary" type="submit">
          Add food
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
      <h2>Regular meals</h2>
      <div className="stack">
        {sync.records
          .filter((r) => r.data.kind === "regular")
          .map(
            (r) =>
              r.data.kind === "regular" && (
                <div className="card row" key={r.id}>
                  <div>
                    <strong>{r.data.name}</strong>
                    <p>
                      {r.data.calories} kcal · {r.data.protein}g protein
                    </p>
                  </div>
                  <Button
                    appearance="outline"
                    onClick={() => {
                      if (r.data.kind === "regular")
                        sync.put({ ...r.data, kind: "meal", date });
                    }}
                  >
                    Add
                  </Button>
                  <Button
                    appearance="ghost"
                    aria-label={`Remove regular ${r.data.name}`}
                    onClick={() => sync.put(null, r.id)}
                  >
                    ×
                  </Button>
                </div>
              ),
          )}
      </div>
      <h2>On the plate today</h2>
      {sync.records
        .filter((r) => r.data.kind === "meal" && r.data.date === date)
        .map(
          (r) =>
            r.data.kind === "meal" && (
              <div className="list-row" key={r.id}>
                <div>
                  <strong>{r.data.name}</strong>
                  <p>
                    {r.data.calories} kcal · {r.data.protein}g protein
                  </p>
                </div>
                <Button appearance="ghost" onClick={() => sync.put(null, r.id)}>
                  Remove
                </Button>
              </div>
            ),
        )}
      <p className="muted">
        Targets are editable in Settings. Calorie and protein values come from
        your entries.
      </p>
    </section>
  );
}
