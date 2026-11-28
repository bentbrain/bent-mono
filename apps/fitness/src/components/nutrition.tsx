import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@bent/ui/button";
import {
  addDays,
  dateSearch,
  foodSummary,
  formatDate,
  formatShortDate,
  mealEntryError,
  mealNutrientValues,
  mealSchema,
  nutrientCoverage,
  nutrientInfo,
  nutrientList,
  nutrientNote,
  nutrientTotals,
  regularSchema,
  sameNutrients,
  totals,
  trackedNutrients,
} from "@bent/fitness-contracts/domain";
import type { Entity, Settings } from "@bent/fitness-contracts/domain";
import type { Sync } from "../sync";
import { useAccount } from "./account-context";
import { foodDayDetail } from "./chart-details";
import {
  ChartCard,
  spokenDetail,
  useDismiss,
} from "./chart-popover";
import { DateBar } from "./date-bar";
import { TextField } from "./fields";
import { Icon } from "./icons";
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
  const { today } = useAccount();
  const [error, setError] = useState("");
  const total = totals(sync.records, date);
  const tracked = trackedNutrients(settings);
  const eaten = nutrientTotals(sync.records, date);
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
  /**
   * Saves the form over `target`, or as new food without one. `source` is
   * the version the form opened, whose values for untracked nutrients stay.
   */
  function save(
    element: HTMLFormElement,
    target: Opened<Meal> | undefined,
    source = target,
  ) {
    const data = new FormData(element);
    // Values for nutrients the account doesn't track stay on the meal.
    const values = mealNutrientValues(source?.data ?? {});
    for (const nutrient of tracked) {
      const text = String(data.get(nutrient) ?? "").trim();
      if (text === "") delete values[nutrient];
      else values[nutrient] = Number(text);
    }
    const result = mealSchema.safeParse({
      kind: "meal",
      date: target?.data.date ?? date,
      name: data.get("name"),
      calories: Number(data.get("calories")),
      protein: Number(data.get("protein")),
      ...values,
    });
    if (!result.success) {
      setError(mealEntryError(tracked));
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
        record.data.protein === result.data.protein &&
        sameNutrients(record.data, result.data),
    );
    if (data.get("regular") && !duplicate)
      sync.put(
        regularSchema.parse({
          kind: "regular",
          name: result.data.name,
          calories: result.data.calories,
          protein: result.data.protein,
          ...mealNutrientValues(result.data),
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
  const regulars = sync.records.flatMap((record) =>
    record.data.kind === "regular" ? [{ ...record, data: record.data }] : [],
  );
  const left = {
    calories: Math.round(settings.calories - total.calories),
    protein: Math.round(settings.protein - total.protein),
  };
  const recentDays = Array.from({ length: 7 }, (_, i) => addDays(date, i - 6));
  const highest = Math.max(
    settings.calories,
    ...recentDays.map((day) => totals(sync.records, day).calories),
  );
  return (
    <section className="food-screen" data-feedback-redact data-feedback-private>
      <header className="page-head">
        <p className="eyebrow">
          {tracked.length
            ? `Calories, protein, ${nutrientList(tracked)}`
            : "Calories and protein"}
        </p>
        <h1>Food</h1>
      </header>
      <DateBar path="/food" step />
      <div
        className="food-totals"
        aria-label={`Totals for ${formatDate(date)}`}
      >
        <div className="food-total">
          <strong>{Math.round(total.calories)}</strong>
          <span>of {settings.calories} kcal</span>
          <progress
            value={Math.min(total.calories, settings.calories)}
            max={settings.calories}
          />
          <small>
            {left.calories >= 0
              ? `${left.calories} kcal left`
              : `${-left.calories} kcal over`}
          </small>
        </div>
        <div className="food-total">
          <strong>{Math.round(total.protein)}g</strong>
          <span>of {settings.protein}g protein</span>
          <progress
            value={Math.min(total.protein, settings.protein)}
            max={settings.protein}
          />
          <small>
            {left.protein > 0
              ? `${left.protein}g to go`
              : "Protein target reached"}
          </small>
        </div>
      </div>
      {tracked.length > 0 && (
        <div
          className="food-totals is-nutrients"
          aria-label={`${nutrientList(tracked)} for ${formatDate(date)}`}
        >
          {tracked.map((nutrient) => {
            const { label } = nutrientInfo[nutrient];
            const target = settings.nutrients?.[nutrient]?.target ?? null;
            const grams = eaten[nutrient].grams;
            const coverage = nutrientCoverage(eaten[nutrient], eaten.meals);
            return (
              <div className="food-total" key={nutrient}>
                <strong>{Math.round(grams)}g</strong>
                <span>
                  {target === null
                    ? label.toLowerCase()
                    : `of ${target}g ${label.toLowerCase()}`}
                </span>
                {target !== null && (
                  <progress
                    aria-label={`${label} toward the daily target`}
                    value={Math.min(grams, target)}
                    max={target}
                  />
                )}
                {target !== null && (
                  <small>{nutrientNote(nutrient, grams, target)}</small>
                )}
                {coverage && <small className="coverage">{coverage}</small>}
              </div>
            );
          })}
        </div>
      )}
      <p role="status" className="food-notice">
        {notice}
      </p>
      <h2 className="section-label">Saved meals</h2>
      {regulars.length ? (
        <ul className="quick-meals">
          {regulars.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="quick-add"
                aria-label={`Add ${r.data.name} to ${formatDate(date)}`}
                onClick={() => {
                  if (sync.put({ ...r.data, kind: "meal", date }))
                    setNotice(`Added ${r.data.name} for ${formatDate(date)}.`);
                }}
              >
                <strong>
                  <Icon name="plus" size={14} />
                  {r.data.name}
                </strong>
                <small>{foodSummary(r.data, tracked)}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          Tick Save as a regular meal when you add food to reuse it here with
          one tap.
        </p>
      )}
      <form
        ref={form}
        className={`food-form${editing ? " is-editing" : ""}`}
        key={`${editing?.id ?? "new"}:${formVersion}`}
        onSubmit={(e) => {
          e.preventDefault();
          save(e.currentTarget, opened.current);
        }}
      >
        <h2 className="section-label">{editing ? "Edit food" : "Add food"}</h2>
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
        {tracked.length > 0 && (
          <div className="food-nutrient-fields">
            {tracked.map((nutrient) => (
              <TextField
                key={nutrient}
                label={`${nutrientInfo[nutrient].label} · g, optional`}
                id={`meal-${nutrient}`}
                defaultValue={shown?.[nutrient] ?? ""}
                name={nutrient}
                type="number"
                inputMode="decimal"
                min="0"
                max={nutrientInfo[nutrient].mealMax}
                step="any"
              />
            ))}
          </div>
        )}
        <label>
          <input type="checkbox" name="regular" /> Save as a regular meal
        </label>
        {status && (
          <EditConflict
            status={status}
            noun="food"
            current={
              saved
                ? `${saved.name} · ${foodSummary(saved, tracked)}`
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
              if (form.current)
                save(form.current, undefined, opened.current);
            }}
          />
        )}
        <div className="form-actions">
          <Button appearance="primary" type="submit" disabled={Boolean(status)}>
            {editing ? "Save food changes" : "Add food"}
          </Button>
          {editing && (
            <Button appearance="outline" onClick={() => open(undefined)}>
              Cancel edit
            </Button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
      <h2 className="section-label">Logged on {formatDate(date)}</h2>
      {meals.length ? (
        <ul className="entries">
          {meals.map(
            (r) =>
              r.data.kind === "meal" && (
                <li className="list-row" key={r.id}>
                  <div>
                    <strong>{r.data.name}</strong>
                    <p>{foodSummary(r.data, tracked)}</p>
                  </div>
                  <Button
                    appearance="outline"
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
                </li>
              ),
          )}
        </ul>
      ) : (
        <p className="empty">
          No food recorded for this date. Add a meal or choose a regular meal.
        </p>
      )}
      <aside className="food-side">
        <h2 className="section-label">Last 7 days</h2>
        <DayStrip
          days={recentDays}
          date={date}
          today={today}
          highest={highest}
          target={settings.calories}
          records={sync.records}
        />
        <p className="measure-note">
          Bars show calories logged each day. The dashed line is your{" "}
          {settings.calories} kcal target. Hover over or focus a day to see its
          calories, protein and what is left.{" "}
          <Link to="/settings" search={{}}>
            Change targets
          </Link>
        </p>
        {regulars.length > 0 && (
          <details className="manage-meals">
            <summary>Manage saved meals</summary>
            <ul className="saved-list">
              {regulars.map((r) => (
                <li className="saved-row" key={r.id}>
                  <div>
                    <strong>{r.data.name}</strong>
                    <p>{foodSummary(r.data, tracked)}</p>
                  </div>
                  <Button
                    appearance="ghost"
                    aria-label={`Remove regular ${r.data.name}`}
                    onClick={() =>
                      window.confirm(`Remove ${r.data.name}?`) &&
                      sync.put(null, r.id, r.revision)
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </aside>
    </section>
  );
}

/**
 * Calories for each of the last seven days against the target. Each day
 * links to its log. Below the days, a space kept for them shows the totals
 * of the day hovered or focused, else of the day this page shows, so the
 * page doesn't move and the totals never cover another day.
 */
function DayStrip({
  days,
  date,
  today,
  highest,
  target,
  records,
}: {
  days: string[];
  date: string;
  today: string;
  highest: number;
  target: number;
  records: Sync["records"];
}) {
  const [active, setActive] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const described = useId();
  const day = active === null ? undefined : days[active];
  const shown = day ?? (days.includes(date) ? date : undefined);
  useDismiss(active !== null, () => setActive(null), frame);
  return (
    <div
      className="chart-frame"
      ref={frame}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setActive(null);
      }}
    >
      <ol className="day-strip" aria-label="Calories for the last 7 days">
        {days.map((day, index) => {
          const eaten = totals(records, day);
          const value = eaten.calories;
          return (
            <li
              key={day}
              onPointerEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            >
              <Link
                to="/food"
                search={dateSearch(day, today)}
                activeOptions={{ exact: true }}
                aria-current={day === date ? "page" : undefined}
                aria-label={`${formatDate(day)}: ${Math.round(value)} kcal`}
                aria-describedby={`${described}-${index}`}
              >
                <span className="bar">
                  <span
                    className="fill"
                    style={{ height: `${(value / highest) * 100}%` }}
                  />
                  <i
                    className="target"
                    style={{
                      bottom: `${(target / highest) * 100}%`,
                    }}
                  />
                </span>
                {formatShortDate(day).split(" ")[0]}
              </Link>
              <span id={`${described}-${index}`} className="visually-hidden">
                {spokenDetail(foodDayDetail(day, eaten, target))}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="chart-detail">
        {shown && (
          <ChartCard
            className="is-flow"
            detail={foodDayDetail(shown, totals(records, shown), target)}
          />
        )}
      </div>
    </div>
  );
}
