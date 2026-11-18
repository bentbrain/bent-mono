import { useEffect, useRef, useState } from "react";
import { Button } from "@bent/ui/button";
import { mealSchema, regularSchema, totals, formatDate } from "../domain";
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
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string>();
  const editedRecord = sync.records.find((record) => record.id === editing);
  const edited = editedRecord?.data;
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    nameInput.current?.scrollIntoView({ block: "center" });
    nameInput.current?.focus({ preventScroll: true });
  }, [editing]);
  const meals = sync.records.filter(
    (record) => record.data.kind === "meal" && record.data.date === date,
  );
  return (
    <section data-feedback-redact data-feedback-private>
      <p className="eyebrow">Fuel your day</p>
      <h1>Food</h1>
      <p className="subtitle">{formatDate(date)}</p>
      <p role="status">{notice}</p>
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
      <h2>{editing ? "Edit food" : "Quick entry"}</h2>
      <form
        className="card form-grid"
        key={editing ?? "new"}
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
          if (sync.put(result.data, editing, editedRecord?.revision ?? 0)) {
            const duplicate = sync.records.some(
              (record) =>
                record.data.kind === "regular" &&
                record.data.name.toLowerCase() ===
                  result.data.name.toLowerCase() &&
                record.data.calories === result.data.calories &&
                record.data.protein === result.data.protein,
            );
            if (data.get("regular") && !duplicate)
              sync.put(
                regularSchema.parse({
                  kind: "regular",
                  name: result.data.name,
                  calories: result.data.calories,
                  protein: result.data.protein,
                }),
              );
            setNotice(
              `${editing ? "Updated" : "Added"} ${result.data.name} for ${formatDate(date)}.${data.get("regular") && duplicate ? " It is already in Regular meals." : ""}`,
            );
            setEditing(undefined);
            form.reset();
            setError("");
          }
        }}
      >
        <TextField
          label="Meal or snack"
          id="meal-name"
          ref={nameInput}
          name="name"
          required
          maxLength={160}
          placeholder="e.g. Yoghurt and berries"
          defaultValue={edited?.kind === "meal" ? edited.name : ""}
        />
        <TextField
          label="Calories · kcal"
          id="meal-calories"
          defaultValue={edited?.kind === "meal" ? edited.calories : ""}
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
          defaultValue={edited?.kind === "meal" ? edited.protein : ""}
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
          {editing ? "Save food changes" : "Add food"}
        </Button>
        {editing && (
          <Button appearance="ghost" onClick={() => setEditing(undefined)}>
            Cancel edit
          </Button>
        )}
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
                      {Math.round(r.data.calories)} kcal ·{" "}
                      {Math.round(r.data.protein)}g protein
                    </p>
                  </div>
                  <Button
                    appearance="outline"
                    aria-label={`Add ${r.data.name} to ${formatDate(date)}`}
                    onClick={() => {
                      if (
                        r.data.kind === "regular" &&
                        sync.put({ ...r.data, kind: "meal", date })
                      )
                        setNotice(
                          `Added ${r.data.name} for ${formatDate(date)}.`,
                        );
                    }}
                  >
                    Add
                  </Button>
                  <Button
                    appearance="ghost"
                    aria-label={`Remove regular ${r.data.name}`}
                    onClick={() =>
                      window.confirm(
                        `Remove ${r.data.kind === "regular" || r.data.kind === "meal" ? r.data.name : "this entry"}?`,
                      ) && sync.put(null, r.id, r.revision)
                    }
                  >
                    ×
                  </Button>
                </div>
              ),
          )}
      </div>
      <h2>Food · {formatDate(date)}</h2>
      {!meals.length && (
        <p>
          No food recorded for this date. Add a meal or choose a regular meal.
        </p>
      )}
      {meals.map(
        (r) =>
          r.data.kind === "meal" && (
            <div className="list-row" key={r.id}>
              <div>
                <strong>{r.data.name}</strong>
                <p>
                  {Math.round(r.data.calories)} kcal ·{" "}
                  {Math.round(r.data.protein)}g protein
                </p>
              </div>
              <Button
                appearance="ghost"
                aria-label={`Edit ${r.data.name}`}
                onClick={() => setEditing(r.id)}
              >
                Edit
              </Button>
              <Button
                appearance="ghost"
                aria-label={`Remove ${r.data.name}`}
                onClick={() =>
                  window.confirm(
                    `Remove ${r.data.kind === "regular" || r.data.kind === "meal" ? r.data.name : "this entry"}?`,
                  ) && sync.put(null, r.id, r.revision)
                }
              >
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
