import { useEffect, useState } from "react";
import { Button } from "@bent/ui/button";
import {
  displayLoad,
  lastExercise,
  progression,
  toKg,
  workoutSchema,
} from "../domain";
import type { RecordEntry, Settings, Workout } from "../domain";
import type { Sync } from "../sync";
import { ExerciseGuide } from "./guide";
export function WorkoutEditor({
  entry,
  settings,
  sync,
}: {
  entry: RecordEntry & { data: Workout };
  settings: Settings;
  sync: Sync;
}) {
  const workout = entry.data;
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const rest = Math.max(0, Math.ceil(((workout.restUntil ?? 0) - now) / 1000));
  function update(data: Workout) {
    const result = workoutSchema.safeParse(data);
    if (result.success) {
      sync.put(result.data, entry.id);
      setMessage("");
    } else setMessage(result.error.issues[0]?.message ?? "Check your results.");
  }
  const done = workout.exercises.reduce(
    (n, e) => n + e.sets.filter((s) => s.done).length,
    0,
  );
  const count = workout.exercises.reduce((n, e) => n + e.sets.length, 0);
  return (
    <section data-feedback-redact data-feedback-private>
      <div className="section-heading">
        <div>
          <p className="eyebrow">In progress · {workout.date}</p>
          <h2>{workout.name}</h2>
        </div>
        <strong>
          {done}/{count} sets
        </strong>
      </div>
      <p>
        Warm up for 5 minutes, then do light practice sets. Keep 2–3 reps in
        reserve. Weights are for one dumbbell; each side has its own reps.
      </p>
      <div className="rest-timer" role="timer" aria-label="Rest timer">
        <span>Rest</span>
        <strong>
          {Math.floor(rest / 60)}:{String(rest % 60).padStart(2, "0")}
        </strong>
        <Button
          appearance="ghost"
          onClick={() => update({ ...workout, restUntil: null })}
        >
          Skip
        </Button>
      </div>
      {workout.exercises.map((e, ei) => {
        const p = e.prescription,
          previous = lastExercise(
            sync.records.filter((r) => r.id !== entry.id),
            p.id,
          );
        const advice = progression(p, previous, settings.dumbbellsKg);
        function change(
          si: number,
          patch: Partial<Workout["exercises"][number]["sets"][number]>,
        ) {
          update({
            ...workout,
            restUntil: patch.done
              ? Date.now() + p.rest * 1000
              : workout.restUntil,
            exercises: workout.exercises.map((item, i) =>
              i !== ei
                ? item
                : {
                    ...item,
                    sets: item.sets.map((set, j) =>
                      j === si ? { ...set, ...patch } : set,
                    ),
                  },
            ),
          });
        }
        return (
          <article className="exercise" key={ei}>
            <div className="exercise-title">
              <span className="number">{String(ei + 1).padStart(2, "0")}</span>
              <div>
                <h3>{p.name}</h3>
                <p>
                  {p.sets} × {p.min}–{p.max}{" "}
                  {p.mode === "seconds"
                    ? "seconds"
                    : `reps${p.side ? " / side" : ""}`}{" "}
                  · {p.rest}s rest
                </p>
              </div>
            </div>
            <ExerciseGuide id={p.id} />
            <p className="previous">
              Last time:{" "}
              {previous
                ? previous.sets
                    .map(
                      (s) =>
                        `${displayLoad(s.loadKg, settings.units)} ${settings.units} × ${s.value}${p.side ? ` / ${s.right}` : ""}${p.mode === "seconds" ? "s" : ""}`,
                    )
                    .join(" · ")
                : "Your first recorded session"}
            </p>
            <p className="suggestion">{advice.text}</p>
            <div className="sets">
              {e.sets.map((set, si) => (
                <div className={`set ${set.done ? "is-done" : ""}`} key={si}>
                  <span className="set-index">{si + 1}</span>
                  {p.mode === "reps" && (
                    <label>
                      <span>{settings.units} / dumbbell</span>
                      <input
                        aria-label={`${p.name} set ${si + 1} weight`}
                        type="number"
                        inputMode="decimal"
                        min="0"
                        max="1000"
                        step="0.25"
                        value={displayLoad(set.loadKg, settings.units)}
                        onChange={(ev) =>
                          change(si, {
                            loadKg: toKg(
                              Number(ev.target.value),
                              settings.units,
                            ),
                          })
                        }
                      />
                    </label>
                  )}
                  <label>
                    <span>
                      {p.mode === "seconds"
                        ? "Seconds"
                        : p.side
                          ? "Left reps"
                          : "Reps"}
                    </span>
                    <input
                      aria-label={`${p.name} set ${si + 1} ${p.mode === "seconds" ? "seconds" : "reps"}`}
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="600"
                      value={set.value}
                      onChange={(ev) =>
                        change(si, { value: Number(ev.target.value) })
                      }
                    />
                  </label>
                  {p.side && (
                    <label>
                      <span>Right reps</span>
                      <input
                        aria-label={`${p.name} set ${si + 1} right reps`}
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max="600"
                        value={set.right ?? 0}
                        onChange={(ev) =>
                          change(si, { right: Number(ev.target.value) })
                        }
                      />
                    </label>
                  )}
                  {p.mode === "reps" && (
                    <label className="reserve">
                      <span>Reps left</span>
                      <input
                        aria-label={`${p.name} set ${si + 1} reps in reserve`}
                        type="number"
                        min="0"
                        max="10"
                        value={set.rir}
                        onChange={(ev) =>
                          change(si, { rir: Number(ev.target.value) })
                        }
                      />
                    </label>
                  )}
                  <label className="check-form">
                    <input
                      type="checkbox"
                      checked={set.controlled}
                      onChange={(ev) =>
                        change(si, { controlled: ev.target.checked })
                      }
                    />
                    Controlled
                  </label>
                  <Button
                    appearance={set.done ? "primary" : "outline"}
                    aria-label={`${p.name} set ${si + 1} ${set.done ? "completed" : "complete"}`}
                    aria-pressed={set.done}
                    onClick={() => change(si, { done: !set.done })}
                  >
                    {set.done ? "✓" : "Done"}
                  </Button>
                </div>
              ))}
            </div>
          </article>
        );
      })}
      <label className="bent-field">
        Session notes
        <textarea
          value={workout.notes}
          maxLength={2000}
          onChange={(e) => update({ ...workout, notes: e.target.value })}
        />
      </label>
      {message && <p role="alert">{message}</p>}
      <Button
        appearance="primary"
        disabled={done !== count}
        onClick={() =>
          update({
            ...workout,
            finishedAt: new Date().toISOString(),
            restUntil: null,
          })
        }
      >
        Finish workout
      </Button>
      <p className="muted">
        Finish after completing every set. Results sync when the save status
        says Saved.
      </p>
      <details>
        <summary>Discard this workout</summary>
        <p>This removes the draft. Completed history stays available.</p>
        <Button appearance="outline" onClick={() => sync.put(null, entry.id)}>
          Discard draft
        </Button>
      </details>
    </section>
  );
}
