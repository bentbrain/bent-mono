import { useEffect, useRef, useState } from "react";
import { Button } from "@bent/ui/sdk/button";
import {
  displayLoad,
  formatDate,
  lastExercise,
  loadNote,
  loadWording,
  progression,
  setResult,
} from "@bent/fitness-contracts/domain";
import type {
  RecordEntry,
  Settings,
  Workout,
} from "@bent/fitness-contracts/domain";
import { useAccount } from "./account-context";
import type { Sync } from "../sync";
import { ExerciseHelp, prescriptionText } from "./exercises";
import {
  elapsedSeconds,
  formatDuration,
  remainingRest,
} from "@bent/fitness-contracts/timing";
import { fieldKey, setKeys, useWorkoutInputs } from "./workout-inputs";
import type { NumberField, WorkoutInputs } from "./workout-inputs";

type SetEntry = Workout["exercises"][number]["sets"][number];
const restNoticeSeconds = 10 * 60;

export function WorkoutEditor({
  entry,
  settings,
  sync,
  onFinish,
  onDiscard,
}: {
  entry: RecordEntry & { data: Workout };
  settings: Settings;
  sync: Sync;
  onFinish: () => void;
  onDiscard: () => void;
}) {
  const workout = entry.data;
  const { owner, setInputPending } = useAccount();
  const inputs = useWorkoutInputs({
    workout,
    units: settings.units,
    storageKey: workoutInputKey(owner, entry.id),
    legacyStorageKey: legacyWorkoutInputKey(owner, entry.id),
    save: (next) => sync.put(next, entry.id),
  });
  useEffect(() => {
    setInputPending(inputs.pending);
  }, [inputs.pending, setInputPending]);
  useEffect(() => () => setInputPending(false), [setInputPending]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const rest = remainingRest(workout.restUntil, now);
  const elapsed = elapsedSeconds(workout.startedAt, now);
  const runningDeadline = useRef<number | null>(null);
  const [endedDeadline, setEndedDeadline] = useState<number | null>(null);
  useEffect(() => {
    if (rest > 0) runningDeadline.current = workout.restUntil;
    else if (
      workout.restUntil !== null &&
      runningDeadline.current === workout.restUntil
    ) {
      runningDeadline.current = null;
      setEndedDeadline(workout.restUntil);
      navigator.vibrate?.([200, 100, 200]);
    }
  }, [rest, workout.restUntil]);
  const restDone =
    endedDeadline !== null &&
    endedDeadline === workout.restUntil &&
    now - endedDeadline < restNoticeSeconds * 1000;
  const sets = workout.exercises.flatMap((exercise) =>
    exercise.sets.map((set, index) => ({
      set,
      index,
      name: exercise.prescription.name,
    })),
  );
  const nextSet = sets.find((item) => !item.set.done && !item.set.skipped);
  const completed = sets.filter((item) => item.set.done).length;
  const skipped = sets.filter((item) => item.set.skipped).length;
  const suggestedRest =
    workout.exercises.find((exercise) =>
      exercise.sets.some((set) => !set.done && !set.skipped),
    )?.prescription.rest ??
    workout.exercises.at(-1)?.prescription.rest ??
    120;
  const [restDuration, setRestDuration] = useState(suggestedRest);
  const restChoices = [
    ...new Set([
      30,
      60,
      90,
      120,
      180,
      ...workout.exercises.map((exercise) => exercise.prescription.rest),
    ]),
  ].sort((a, b) => a - b);
  function setRest(restUntil: number | null) {
    setNow(Date.now());
    inputs.commit({
      keys: [],
      change: (current) => ({ ...current, restUntil }),
      place: "timer",
    });
  }
  const history = sync.records.filter((record) => record.id !== entry.id);
  return (
    <section data-feedback-redact data-feedback-private>
      <div className="session-head">
        <div>
          <p className="eyebrow">In progress · {formatDate(workout.date)}</p>
          <h1>{workout.name}</h1>
        </div>
        <strong className="set-count">
          {completed}/{sets.length} sets done
          {skipped > 0 && <small> · {skipped} skipped</small>}
        </strong>
      </div>
      <div className={`workout-timing ${restDone ? "rest-finished" : ""}`}>
        <div className="timing-row">
          <div role="timer" aria-label="Workout elapsed time">
            <span>Elapsed</span> <strong>{formatDuration(elapsed)}</strong>
          </div>
          <div role="timer" aria-label="Rest timer">
            <span>Rest</span>{" "}
            <strong>
              {rest > 0
                ? formatDuration(rest)
                : restDone
                  ? "Rest done"
                  : "Not running"}
            </strong>
          </div>
          {rest > 0 && (
            <Button appearance="ghost" onClick={() => setRest(null)}>
              Skip rest
            </Button>
          )}
        </div>
        <div className="session-progress" aria-hidden="true">
          <span
            style={{
              width: `${((completed + skipped) / sets.length) * 100}%`,
            }}
          />
        </div>
        <p className="rest-announcement" role="status">
          {restDone
            ? `Rest done.${nextSet ? ` Next: ${nextSet.name}, set ${nextSet.index + 1}.` : " Every set is handled."}`
            : ""}
        </p>
        {inputs.message?.place === "timer" && (
          <p className="timer-error" role="alert">
            {inputs.message.text}
          </p>
        )}
      </div>
      <details className="rest-controls">
        <summary>Rest controls</summary>
        <div className="timer-actions">
          <label>
            New rest length
            <select
              aria-label="New rest length"
              value={restDuration}
              onChange={(event) => setRestDuration(Number(event.target.value))}
            >
              {restChoices.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {formatDuration(seconds)}
                </option>
              ))}
            </select>
          </label>
          <Button
            appearance="ghost"
            onClick={() => setRest(Date.now() + restDuration * 1000)}
          >
            Start new {formatDuration(restDuration)} rest
          </Button>
        </div>
        <p>
          Rest starts when you mark a set Done. Your elapsed timer runs from the
          session start.
        </p>
      </details>
      <p className="session-guidance">
        Warm up for 5 minutes, then do light practice sets. Keep 2–3 reps in
        reserve.{" "}
        {loadNote(
          workout.exercises.map((exercise) => exercise.prescription),
          settings.units,
        )}{" "}
        Each side has its own reps.
      </p>
      <InputNotices inputs={inputs} />
      <ExerciseList
        workout={workout}
        settings={settings}
        inputs={inputs}
        history={history}
        startRest
      />
      <NotesField inputs={inputs} />
      <div className="finish-bar">
        {inputs.message?.place === "finish" && (
          <p role="alert">{inputs.message.text}</p>
        )}
        <Button
          appearance="primary"
          disabled={nextSet !== undefined}
          onClick={() => {
            if (
              inputs.commit({
                change: (current) => ({
                  ...current,
                  finishedAt: new Date().toISOString(),
                  restUntil: null,
                }),
              })
            )
              onFinish();
          }}
        >
          Finish workout
        </Button>
        <p className="muted">
          Mark each set Done or Skipped to finish. Skipped sets do not count
          towards a weight increase. Results sync when the save status says
          Saved.
        </p>
      </div>
      <details>
        <summary>Discard this workout</summary>
        <p>This removes the draft. Completed history stays available.</p>
        <Button
          appearance="outline"
          onClick={() => {
            if (
              window.confirm(
                "Discard this unfinished workout and the values typed on this device?",
              ) &&
              sync.put(null, entry.id)
            ) {
              inputs.clear();
              onDiscard();
            }
          }}
        >
          Discard draft
        </Button>
      </details>
    </section>
  );
}

export function workoutInputKey(owner: string, workoutId: string) {
  return `bent:fitness:inputs:v2:${owner}:${workoutId}`;
}
/** Typed values kept before units were stored with each value. */
export function legacyWorkoutInputKey(owner: string, workoutId: string) {
  return `bent:fitness:inputs:v1:${owner}:${workoutId}`;
}

export function InputNotices({ inputs }: { inputs: WorkoutInputs }) {
  return (
    <>
      {/* Always shown, so saving a field never moves the controls below. */}
      <p className="input-help">
        Typed values stay on this device until you leave the set, press Done or
        Skip, or leave this page. Then they save to your account.
      </p>
      {inputs.held.some((key) => !inputs.unconfirmed.includes(key)) && (
        <p className="input-notice" role="alert">
          A highlighted value changed on another device. Your typed value is
          still here. Leave the field to save it, or retype the saved value.
        </p>
      )}
      {inputs.unconfirmed.length > 0 && (
        <p className="input-notice" role="alert">
          A weight typed on this device is waiting for you to check it. Confirm
          it is in {inputs.units}, then leave the set to save it.
        </p>
      )}
      <StorageNotice message={inputs.storageError} />
    </>
  );
}

function StorageNotice({ message }: { message: string }) {
  const [previous, setPrevious] = useState(message);
  useEffect(() => {
    if (message) setPrevious(message);
  }, [message]);
  // Keep the warning's space after recovery so a blur-triggered save cannot
  // move a set button between pointer down and click.
  const text = message || previous;
  return text ? (
    <p
      role={message ? "alert" : undefined}
      aria-hidden={!message}
      style={{ visibility: message ? "visible" : "hidden" }}
    >
      {text}
    </p>
  ) : null;
}

export function NotesField({ inputs }: { inputs: WorkoutInputs }) {
  return (
    <label className="bent-field">
      Session notes
      <textarea
        value={inputs.text("notes")}
        maxLength={2000}
        aria-invalid={inputs.held.includes("notes") || undefined}
        onChange={(event) => inputs.setText("notes", event.target.value)}
        onBlur={() => inputs.commit({ keys: ["notes"], place: "notes" })}
      />
      {inputs.message?.place === "notes" && (
        <span role="alert">{inputs.message.text}</span>
      )}
    </label>
  );
}

export function ExerciseList({
  workout,
  settings,
  inputs,
  history,
  startRest,
}: {
  workout: Workout;
  settings: Settings;
  inputs: WorkoutInputs;
  /** Earlier workouts for "Last time" and weight advice. */
  history?: RecordEntry[];
  /** Start the rest timer when a set is marked Done. */
  startRest?: boolean;
}) {
  const current = startRest
    ? workout.exercises.findIndex((exercise) =>
        exercise.sets.some((set) => !set.done && !set.skipped),
      )
    : -1;
  return workout.exercises.map((exercise, ei) => {
    const p = exercise.prescription;
    const previous = history ? lastExercise(history, p.id) : undefined;
    const advice = history ? progression(p, previous, settings) : undefined;
    function act(si: number, set: SetEntry, change: Partial<SetEntry>) {
      inputs.commit({
        keys: setKeys(ei, si),
        dropInvalid: change.skipped === true,
        place: `${ei}:${si}`,
        change: (current) => ({
          ...current,
          restUntil:
            startRest && change.done && !set.done
              ? Date.now() + p.rest * 1000
              : current.restUntil,
          exercises: current.exercises.map((item, i) =>
            i !== ei
              ? item
              : {
                  ...item,
                  sets: item.sets.map((value, j) =>
                    j === si ? { ...value, ...change } : value,
                  ),
                },
          ),
        }),
      });
    }
    function numberInput(
      si: number,
      field: NumberField,
      label: string,
      attributes: {
        inputMode: "decimal" | "numeric";
        max: number;
        step: string;
      },
    ) {
      const key = fieldKey(ei, si, field);
      const invalid =
        Boolean(inputs.errors[key]) ||
        inputs.held.includes(key) ||
        inputs.unconfirmed.includes(key);
      return (
        <input
          aria-label={label}
          type="number"
          inputMode={attributes.inputMode}
          min={0}
          max={attributes.max}
          step={attributes.step}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${key}-error` : undefined}
          value={inputs.text(key)}
          onChange={(event) => inputs.setText(key, event.target.value)}
        />
      );
    }
    return (
      <article
        className={`exercise${ei === current ? " is-current" : ""}`}
        key={ei}
      >
        <div className="exercise-title">
          <span className="number">{String(ei + 1).padStart(2, "0")}</span>
          <div>
            <h3>
              {p.name}
              {ei === current && <span className="current-tag">Current</span>}
            </h3>
            <p>{prescriptionText(p)}</p>
          </div>
          <ExerciseHelp id={p.id} />
        </div>
        {history && (
          <p className="previous">
            Last time:{" "}
            {previous
              ? previous.sets
                  .map((s) =>
                    setResult(s, previous.prescription, settings.units),
                  )
                  .join(" · ")
              : "Your first recorded session"}
          </p>
        )}
        {advice && <p className="suggestion">{advice.text}</p>}
        <div className="sets">
          {exercise.sets.map((set, si) => {
            const name = `${p.name} set ${si + 1}`;
            const problems = setKeys(ei, si).flatMap((key) =>
              inputs.errors[key] ? [{ key, text: inputs.errors[key] }] : [],
            );
            return (
              <div
                className={`set ${set.done ? "is-done" : ""} ${set.skipped ? "is-skipped" : ""}`}
                key={si}
                onBlur={(event) => {
                  const next = event.relatedTarget;
                  if (
                    next instanceof Node &&
                    event.currentTarget.contains(next)
                  )
                    return;
                  inputs.commit({
                    keys: setKeys(ei, si),
                    place: `${ei}:${si}`,
                  });
                }}
              >
                <span className="set-index">{si + 1}</span>
                {loadWording(p, settings.units).weighed && (
                  <label>
                    <span>{loadWording(p, settings.units).heading}</span>
                    {numberInput(
                      si,
                      "loadKg",
                      `${name} weight, ${loadWording(p, settings.units).unit}`,
                      {
                        inputMode: "decimal",
                        max: Math.floor(displayLoad(1000, settings.units)),
                        step: "any",
                      },
                    )}
                  </label>
                )}
                <label>
                  <span>
                    {p.mode === "seconds"
                      ? p.side
                        ? "Left seconds"
                        : "Seconds"
                      : p.side
                        ? "Left reps"
                        : "Reps"}
                  </span>
                  {numberInput(
                    si,
                    "value",
                    `${name} ${p.mode === "seconds" ? "seconds" : "reps"}`,
                    {
                      inputMode: p.mode === "seconds" ? "decimal" : "numeric",
                      max: 600,
                      step: p.mode === "seconds" ? "any" : "1",
                    },
                  )}
                </label>
                {p.side && (
                  <label>
                    <span>
                      {p.mode === "seconds" ? "Right seconds" : "Right reps"}
                    </span>
                    {numberInput(
                      si,
                      "right",
                      `${name} right ${p.mode === "seconds" ? "seconds" : "reps"}`,
                      {
                        inputMode: p.mode === "seconds" ? "decimal" : "numeric",
                        max: 600,
                        step: p.mode === "seconds" ? "any" : "1",
                      },
                    )}
                  </label>
                )}
                {p.mode === "reps" && (
                  <label className="reserve">
                    <span>Reps left</span>
                    {numberInput(si, "rir", `${name} reps in reserve`, {
                      inputMode: "numeric",
                      max: 10,
                      step: "1",
                    })}
                  </label>
                )}
                <div className="set-actions">
                  <label className="check-form">
                    <input
                      type="checkbox"
                      checked={set.controlled}
                      onChange={(event) =>
                        act(si, set, { controlled: event.target.checked })
                      }
                    />
                    Controlled
                  </label>
                  <Button
                    appearance={set.done ? "primary" : "outline"}
                    aria-label={`${name} ${set.done ? "completed" : "complete"}`}
                    aria-pressed={set.done}
                    onClick={() =>
                      act(si, set, { done: !set.done, skipped: false })
                    }
                  >
                    {set.done ? "✓ Done" : "Done"}
                  </Button>
                  <Button
                    appearance="ghost"
                    aria-label={`${name} ${set.skipped ? "skipped" : "skip"}`}
                    aria-pressed={set.skipped}
                    onClick={() =>
                      act(si, set, { skipped: !set.skipped, done: false })
                    }
                  >
                    {set.skipped ? "Skipped" : "Skip"}
                  </Button>
                </div>
                {problems.map((problem) => (
                  <p
                    className="set-error"
                    id={`${problem.key}-error`}
                    key={problem.key}
                    role="alert"
                  >
                    {problem.text}
                  </p>
                ))}
                {setKeys(ei, si).some((key) =>
                  inputs.unconfirmed.includes(key),
                ) ? (
                  <p className="set-error">
                    Check this weight is in {settings.units}, then leave the set
                    to save it.
                  </p>
                ) : (
                  inputs.held.some((key) => setKeys(ei, si).includes(key)) && (
                    <p className="set-error">
                      Saved on another device since you typed here.
                    </p>
                  )
                )}
                {inputs.message?.place === `${ei}:${si}` && (
                  <p className="set-error" role="alert">
                    {inputs.message.text}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </article>
    );
  });
}
