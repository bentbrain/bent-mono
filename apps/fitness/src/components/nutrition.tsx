import { useEffect, useRef, useState } from "react";
import { Button } from "@bent/ui/button";
import { mealSchema, regularSchema, totals, formatDate } from "../domain";
import type { Entity, Settings } from "../domain";
import type { Sync } from "../sync";
import { TextField } from "./fields";
import { EditConflict, editStatus } from "./record-edit";
import type { Opened } from "./record-edit";
type Meal = Extract<Entity, { kind: "meal" }>;
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
  // The meal version the form opened with. Saving checks it is still current.
  const [editing, setEditing] = useState<Opened<Meal>>();
  const opened = useRef<Opened<Meal>>(undefined);
  const [formVersion, setFormVersion] = useState(0);
  const [checked, setChecked] = useState<"changed" | "removed">();
  const live = editing
    ? sync.records.find((record) => record.id === editing.id)
    : undefined;
  const derived = editStatus(editing, live);
  const status = derived === "current" ? checked : derived;
  const form = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing?.id) return;
    nameInput.current?.scrollIntoView({ block: "center" });
    nameInput.current?.focus({ preventScroll: true });
  }, [editing?.id, formVersion]);
  const meals = sync.records.filter(
    (record) => record.data.kind === "meal" && record.data.date === date,
  );
  /** Opens a version in the form. `reload` replaces the typed values. */
  function open(next: Opened<Meal> | undefined, reload = true) {
    opened.current = next;
    setEditing(next);
    setChecked(undefined);
    if (reload) setFormVersion((value) => value + 1);
  }
  function savedVersion() {
    const target = opened.current;
    const current = target ? sync.latest(target.id) : undefined;
    return target && current?.data?.kind === "meal"
      ? { id: target.id, revision: current.revision, data: current.data }
      : undefined;
  }
  function save(element: HTMLFormElement, target: Opened<Meal> | undefined) {
    const data = new FormData(element);
    const result = mealSchema.safeParse({
      kind: "meal",
      date: target?.data.date ?? date,
      name: data.get("name"),
      calories: Number(data.get("calories")),
      protein: Number(data.get("protein")),
    });
    if (!result.success) {
      setError("Enter a meal name, calories and protein.");
      return;
    }
    if (target) {
      const state = editStatus(target, sync.latest(target.id));
      if (state !== "current") {
        setChecked(state);
        setError("");
        return;
      }
    }
    if (!sync.put(result.data, target?.id, target?.revision ?? 0)) return;
    const duplicate = sync.records.some(
      (record) =>
        record.data.kind === "regular" &&
        record.data.name.toLowerCase() === result.data.name.toLowerCase() &&
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
      `${target ? "Updated" : "Added"} ${result.data.name} for ${formatDate(result.data.date)}.${data.get("regular") && duplicate ? " It is already in Regular meals." : ""}`,
    );
    open(undefined);
    element.reset();
    setError("");
  }
  const shown = editing?.data;
  const saved = live?.data.kind === "meal" ? live.data : undefined;
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
        ref={form}
        className="card form-grid"
        key={`${editing?.id ?? "new"}:${formVersion}`}
        onSubmit={(e) => {
          e.preventDefault();
          save(e.currentTarget, opened.current);
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
          defaultValue={shown?.name ?? ""}
        />
        <TextField
          label="Calories · kcal"
          id="meal-calories"
          defaultValue={shown?.calories ?? ""}
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
          defaultValue={shown?.protein ?? ""}
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
        {status && (
          <EditConflict
            status={status}
            noun="food"
            current={
              saved
                ? `${saved.name} · ${Math.round(saved.calories)} kcal · ${Math.round(saved.protein)}g protein`
                : undefined
            }
            onKeepMine={() => {
              const next = savedVersion();
              if (!next) return;
              open(next, false);
              if (form.current) save(form.current, next);
            }}
            onUseCurrent={() => open(savedVersion())}
            onSaveAsNew={() => {
              if (form.current) save(form.current, undefined);
            }}
          />
        )}
        <Button appearance="primary" type="submit" disabled={Boolean(status)}>
          {editing ? "Save food changes" : "Add food"}
        </Button>
        {editing && (
          <Button appearance="ghost" onClick={() => open(undefined)}>
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
                onClick={() =>
                  r.data.kind === "meal" &&
                  open({ id: r.id, revision: r.revision, data: r.data })
                }
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
