import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@bent/ui/button";
import { z } from "zod";
import {
  dateSearch,
  displayLoad,
  effectivePrescription,
  formatDate,
  lastExercise,
  progression,
  runSchema,
  scheduled,
  sessionMinutes,
  setResult,
  trainingRecords,
} from "@bent/fitness-contracts/domain";
import { useAccount } from "./account-context";
import { ExerciseHelp, ExerciseThumb, prescriptionText } from "./exercises";
import { Icon } from "./icons";
import { useStartWorkout } from "./start-workout";
import { TextField } from "./fields";
import {
  legacyWorkoutInputKey,
  WorkoutEditor,
  workoutInputKey,
} from "./workout";
import type { Entity } from "@bent/fitness-contracts/domain";
import { EditConflict, editStatus } from "./record-edit";
import type { Opened } from "./record-edit";

export function PlanScreen({
  date: suppliedDate,
  routineId,
}: {
  date: string;
  routineId: string;
}) {
  const { sync, settings, date: selectedDate, today } = useAccount();
  const date = suppliedDate || selectedDate;
  const { start, starting, active } = useStartWorkout();
  const valid = z.iso.date().safeParse(date).success;
  const planned = valid ? scheduled(settings, date) : undefined;
  const routine = routineId
    ? planned?.type === "strength" && planned.routine?.id === routineId
      ? planned.routine
      : settings.routines.find((item) => item.id === routineId)
    : planned?.type === "strength"
      ? planned.routine
      : undefined;
  if (!valid || !routine) return <Unavailable title="Plan unavailable" />;
  const intro = planned?.intro ?? false;
  // A future plan is done today, so it uses today's introduction setting.
  const workoutDate = date > today ? today : date;
  const workoutIntro = scheduled(settings, workoutDate).intro;
  const recorded = trainingRecords(sync.records).find(
    (record) =>
      record.data.kind === "workout" &&
      Boolean(record.data.finishedAt) &&
      record.data.date === date &&
      record.data.routineId === routine.id,
  );
  const label =
    date > today
      ? "Do this workout today"
      : date < today
        ? `Log workout for ${formatDate(date)}`
        : "Start workout";
  return (
    <section
      className="plan-preview"
      data-feedback-private
      data-feedback-redact
    >
      <Link className="back-link" to="/" search={dateSearch(date, today)}>
        <Icon name="back" size={16} /> Back to week
      </Link>
      <header className="page-head">
        <p className="eyebrow">
          Workout plan · {formatDate(date)}
          {date === today ? " · Today" : date > today ? " · Planned" : ""}
        </p>
        <h1>{routine.name}</h1>
        <p className="subtitle">
          About {sessionMinutes(routine, intro)} min ·{" "}
          {routine.exercises.length} exercises ·{" "}
          {intro ? "Introduction · up to 2 sets each" : "Full session"}
        </p>
      </header>
      <div className="plan-summary input-notice">
        <p>
          Warm up for 5 minutes, then do light practice sets. Keep 2–3 reps in
          reserve. Weights mean one dumbbell.
        </p>
        {recorded && (
          <p>
            You recorded {routine.name} for {formatDate(date)}.{" "}
            <Link to="/history" search={dateSearch(date, today)}>
              View results
            </Link>
          </p>
        )}
      </div>
      <div className="plan-list">
        {routine.exercises.map((prescription, index) => {
          const exercise = effectivePrescription(prescription, intro);
          const previous = lastExercise(sync.records, exercise.id);
          const advice = progression(exercise, previous, settings);
          return (
            <article className="plan-exercise" key={`${exercise.id}:${index}`}>
              <ExerciseThumb id={exercise.id} />
              <div>
                <h2>
                  <span className="number">
                    {String(index + 1).padStart(2, "0")}
                  </span>{" "}
                  {exercise.name}
                </h2>
                <p className="prescription">{prescriptionText(exercise)}</p>
                <ExerciseHelp id={exercise.id} />
              </div>
              <div>
                <p className="previous">
                  Last time:{" "}
                  {previous
                    ? previous.sets
                        .map((set) =>
                          setResult(set, previous.prescription, settings.units),
                        )
                        .join(" · ")
                    : "Your first recorded session"}
                </p>
                <p className="suggestion">
                  {advice.text}
                  {exercise.mode === "reps" && advice.loadKg !== null
                    ? ` Suggested load: ${displayLoad(advice.loadKg, settings.units)} ${settings.units} per dumbbell.`
                    : ""}
                </p>
              </div>
            </article>
          );
        })}
      </div>
      <div className="action-bar">
        {active ? (
          <>
            <p className="action-note">
              You have a workout in progress. Resume it when you are ready to
              train.
            </p>
            <Link
              className="bent-button bent-button--primary"
              to="/workout"
              search={{ workoutId: active.id }}
            >
              Resume workout
            </Link>
          </>
        ) : (
          <>
            <Button
              appearance="primary"
              disabled={starting}
              onClick={() => start(routine, workoutDate)}
            >
              {starting ? "Opening workout…" : label}
            </Button>
            {date < today && (
              <Button
                appearance="outline"
                disabled={starting}
                onClick={() => start(routine, today)}
              >
                Do this workout today
              </Button>
            )}
            <p className="action-note">
              {date > today
                ? `This starts ${routine.name} now and records it for today, ${formatDate(today)}.${workoutIntro === intro ? "" : workoutIntro ? " Today is in your introduction weeks, so each exercise has up to 2 sets." : " Today uses full sets."}`
                : date < today
                  ? `Log workout opens a workout dated ${formatDate(date)} for results you have already done. Do this workout today records it for ${formatDate(today)}.`
                  : "Start when you are ready to train. This begins your session and elapsed timer."}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export function WorkoutScreen({ workoutId }: { workoutId: string }) {
  const { sync, settings, today, owner } = useAccount();
  const navigate = useNavigate();
  const entry = sync.records.find((record) => record.id === workoutId);
  const finished = entry?.data.kind === "workout" && entry.data.finishedAt;
  useEffect(() => {
    // Values typed on this device are no longer needed once a workout is finished.
    if (!finished) return;
    localStorage.removeItem(workoutInputKey(owner, workoutId));
    localStorage.removeItem(legacyWorkoutInputKey(owner, workoutId));
  }, [finished, owner, workoutId]);
  if (!entry || entry.data.kind !== "workout")
    return <Unavailable title="Workout unavailable" />;
  const workoutDate = entry.data.date;
  if (entry.data.finishedAt)
    return (
      <section className="page-head">
        <h1>Workout completed</h1>
        <p>
          View your results in History. Check the save status before closing the
          app.
        </p>
        <Link to="/history" search={dateSearch(workoutDate, today)}>
          Open history
        </Link>
      </section>
    );
  return (
    <>
      <Link
        className="back-link"
        to="/"
        search={dateSearch(workoutDate, today)}
      >
        <Icon name="back" size={16} /> Back to week
      </Link>
      <WorkoutEditor
        entry={{ ...entry, data: entry.data }}
        settings={settings}
        sync={sync}
        onFinish={() =>
          void navigate({
            to: "/history",
            search: dateSearch(workoutDate, today),
            replace: true,
          })
        }
        onDiscard={() => void navigate({ to: "/", search: {}, replace: true })}
      />
    </>
  );
}

type Run = Extract<Entity, { kind: "run" }>;
export function RunScreen({ date, runId }: { date: string; runId?: string }) {
  const { sync, date: selectedDate, today } = useAccount();
  const live = sync.records.find((record) => record.id === runId);
  // The run version the form opened with. Saving checks it is still current.
  const [editing, setEditing] = useState<Opened<Run> | undefined>(() =>
    live?.data.kind === "run"
      ? { id: live.id, revision: live.revision, data: live.data }
      : undefined,
  );
  const [formVersion, setFormVersion] = useState(0);
  const [checked, setChecked] = useState<"changed" | "removed">();
  const form = useRef<HTMLFormElement>(null);
  const run = editing?.data;
  const saved = live?.data.kind === "run" ? live.data : undefined;
  const derived = editStatus(editing, live);
  const status = derived === "current" ? checked : derived;
  const day = run?.date || date || selectedDate;
  const navigate = useNavigate();
  const [error, setError] = useState("");
  if (!z.iso.date().safeParse(day).success || (runId && !editing))
    return <Unavailable title="Run unavailable" />;
  function savedVersion() {
    const current = editing ? sync.latest(editing.id) : undefined;
    return editing && current?.data?.kind === "run"
      ? { id: editing.id, revision: current.revision, data: current.data }
      : undefined;
  }
  function save(element: HTMLFormElement, target: Opened<Run> | undefined) {
    const values = new FormData(element);
    const result = runSchema.safeParse({
      kind: "run",
      date: values.get("date"),
      minutes: Number(values.get("minutes")),
      distanceKm: Number(values.get("distance")),
      notes: values.get("notes"),
    });
    if (!result.success) {
      setError("Enter a valid date, duration and distance.");
      return;
    }
    if (result.data.date > today) {
      setError(`Record a run on ${formatDate(today)} or an earlier date.`);
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
    if (sync.put(result.data, target?.id, target?.revision ?? 0))
      void navigate({
        to: "/history",
        search: dateSearch(result.data.date, today),
        replace: true,
      });
  }
  return (
    <section data-feedback-private data-feedback-redact>
      <Link className="back-link" to="/" search={dateSearch(day, today)}>
        <Icon name="back" size={16} /> Back to week
      </Link>
      <header className="page-head">
        <p className="eyebrow">
          {run ? "Recorded run" : "Run plan"} · {formatDate(day)}
        </p>
        <h1>Easy run</h1>
        <p className="subtitle">
          Keep a conversational pace. You should be able to talk in sentences.
        </p>
      </header>
      <form
        ref={form}
        key={formVersion}
        className="card form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          save(event.currentTarget, editing);
        }}
      >
        <h2>{run ? "Edit your run" : "Record your completed run"}</h2>
        <TextField
          label="Date"
          id="run-date"
          name="date"
          type="date"
          defaultValue={day > today ? today : day}
          max={today}
          required
        />
        <TextField
          label="Duration · minutes"
          id="run-minutes"
          defaultValue={run?.minutes}
          name="minutes"
          type="number"
          min="1"
          max="1440"
          step="any"
          required
        />
        <TextField
          label="Distance · km"
          id="run-distance"
          defaultValue={run?.distanceKm}
          name="distance"
          type="number"
          min="0"
          max="500"
          step="0.01"
          required
        />
        <TextField
          label="Notes"
          id="run-notes"
          defaultValue={run?.notes}
          name="notes"
          maxLength={2000}
        />
        {status && (
          <EditConflict
            status={status}
            noun="run"
            current={
              saved
                ? `${formatDate(saved.date)} · ${saved.minutes} min · ${saved.distanceKm} km`
                : undefined
            }
            onKeepMine={() => {
              const next = savedVersion();
              if (!next) return;
              setEditing(next);
              setChecked(undefined);
              if (form.current) save(form.current, next);
            }}
            onUseCurrent={() => {
              setEditing(savedVersion());
              setChecked(undefined);
              setFormVersion((value) => value + 1);
            }}
            onSaveAsNew={() => {
              if (form.current) save(form.current, undefined);
            }}
          />
        )}
        <Button type="submit" appearance="primary" disabled={Boolean(status)}>
          {run ? "Save run changes" : "Save run"}
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
function Unavailable({ title }: { title: string }) {
  const { date, today } = useAccount();
  return (
    <section>
      <h1>{title}</h1>
      <p>Open your current plan from your week.</p>
      <Link to="/" search={dateSearch(date, today)}>
        Back to week
      </Link>
    </section>
  );
}
