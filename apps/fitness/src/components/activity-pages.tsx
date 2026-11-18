import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@bent/ui/button";
import { z } from "zod";
import {
  createWorkout,
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
} from "../domain";
import { useAccount } from "./account-context";
import { ExerciseGuide } from "./guide";
import { TextField } from "./fields";
import { WorkoutEditor, workoutInputKey } from "./workout";
import { formatDuration } from "../timing";

export function PlanScreen({
  date: suppliedDate,
  routineId,
}: {
  date: string;
  routineId: string;
}) {
  const { sync, settings, date: selectedDate, today } = useAccount();
  const date = suppliedDate || selectedDate;
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const valid = z.iso.date().safeParse(date).success;
  const planned = valid ? scheduled(settings, date) : undefined;
  const routine = routineId
    ? settings.routines.find((item) => item.id === routineId)
    : planned?.type === "strength"
      ? planned.routine
      : undefined;
  if (!valid || !routine) return <Unavailable title="Plan unavailable" />;
  const intro = planned?.intro ?? false;
  // A future plan is done today, so it uses today's introduction setting.
  const workoutDate = date > today ? today : date;
  const workoutIntro = scheduled(settings, workoutDate).intro;
  const active = sync.records.find(
    (record) => record.data.kind === "workout" && !record.data.finishedAt,
  );
  const recorded = trainingRecords(sync.records).find(
    (record) =>
      record.data.kind === "workout" &&
      Boolean(record.data.finishedAt) &&
      record.data.date === date &&
      record.data.routineId === routine.id,
  );
  function start(day: string) {
    if (starting || active || !routine) return;
    setStarting(true);
    const id = crypto.randomUUID();
    if (
      sync.put(
        createWorkout(
          settings,
          routine,
          day,
          scheduled(settings, day).intro,
          sync.records,
        ),
        id,
      )
    )
      void navigate({ to: "/workout", search: { workoutId: id } });
    else setStarting(false);
  }
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
        <span aria-hidden>←</span> Back to Today
      </Link>
      <p className="eyebrow">Workout plan · {formatDate(date)}</p>
      <h1>{routine.name}</h1>
      <p className="subtitle">
        About {sessionMinutes(routine, intro)} min · {routine.exercises.length}{" "}
        exercises ·{" "}
        {intro ? "Introduction · up to 2 sets each" : "Full session"}
      </p>
      <div className="card plan-summary">
        <p>
          Warm up for 5 minutes, then do light practice sets. Keep 2–3 reps in
          reserve.
        </p>
        <p>
          Weights mean one dumbbell. Rows and split squats count each side;
          planks count seconds.
        </p>
        {recorded && (
          <p>
            You recorded {routine.name} for {formatDate(date)}.{" "}
            <Link to="/history" search={dateSearch(date, today)}>
              View results
            </Link>
          </p>
        )}
        {active ? (
          <>
            <p>
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
              onClick={() => start(workoutDate)}
            >
              {starting ? "Opening workout…" : label}
            </Button>
            {date < today && (
              <Button
                appearance="outline"
                disabled={starting}
                onClick={() => start(today)}
              >
                Do this workout today
              </Button>
            )}
            <p className="muted">
              {date > today
                ? `This starts ${routine.name} now and records it for today, ${formatDate(today)}.${workoutIntro === intro ? "" : workoutIntro ? " Today is in your introduction weeks, so each exercise has up to 2 sets." : " Today uses full sets."}`
                : date < today
                  ? `Log workout opens a workout dated ${formatDate(date)} for results you have already done. Do this workout today records it for ${formatDate(today)}.`
                  : "Start when you are ready to train. This begins your session and elapsed timer."}
            </p>
          </>
        )}
      </div>
      {routine.exercises.map((prescription, index) => {
        const exercise = effectivePrescription(prescription, intro);
        const previous = lastExercise(sync.records, exercise.id);
        const advice = progression(exercise, previous, settings.dumbbellsKg);
        return (
          <article
            className="card plan-exercise"
            key={`${exercise.id}:${index}`}
          >
            <div className="exercise-title">
              <span className="number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h2>{exercise.name}</h2>
                <p>
                  {exercise.sets} × {exercise.min}–{exercise.max}{" "}
                  {exercise.mode === "seconds"
                    ? "seconds"
                    : exercise.side
                      ? "reps / side"
                      : "reps"}{" "}
                  · {formatDuration(exercise.rest)} rest
                </p>
              </div>
            </div>
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
            <ExerciseGuide id={exercise.id} />
          </article>
        );
      })}
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
    if (finished) localStorage.removeItem(workoutInputKey(owner, workoutId));
  }, [finished, owner, workoutId]);
  if (!entry || entry.data.kind !== "workout")
    return <Unavailable title="Workout unavailable" />;
  const workoutDate = entry.data.date;
  if (entry.data.finishedAt)
    return (
      <section>
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
        <span aria-hidden>←</span> Back to Today
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

export function RunScreen({ date, runId }: { date: string; runId?: string }) {
  const { sync, date: selectedDate, today } = useAccount();
  const entry = sync.records.find((record) => record.id === runId);
  const run = entry?.data.kind === "run" ? entry.data : undefined;
  const day = run?.date || date || selectedDate;
  const navigate = useNavigate();
  const [error, setError] = useState("");
  if (!z.iso.date().safeParse(day).success || (runId && !run))
    return <Unavailable title="Run unavailable" />;
  return (
    <section data-feedback-private data-feedback-redact>
      <Link className="back-link" to="/" search={dateSearch(day, today)}>
        <span aria-hidden>←</span> Back to Today
      </Link>
      <p className="eyebrow">
        {run ? "Recorded run" : "Run plan"} · {formatDate(day)}
      </p>
      <h1>Easy run</h1>
      <p className="subtitle">
        Keep a conversational pace. You should be able to talk in sentences.
      </p>
      <form
        className="card form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const result = runSchema.safeParse({
            kind: "run",
            date: form.get("date"),
            minutes: Number(form.get("minutes")),
            distanceKm: Number(form.get("distance")),
            notes: form.get("notes"),
          });
          if (!result.success) {
            setError("Enter a valid date, duration and distance.");
            return;
          }
          if (result.data.date > today) {
            setError(
              `Record a run on ${formatDate(today)} or an earlier date.`,
            );
            return;
          }
          if (sync.put(result.data, entry?.id, entry?.revision ?? 0))
            void navigate({
              to: "/history",
              search: dateSearch(result.data.date, today),
              replace: true,
            });
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
        <Button type="submit" appearance="primary">
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
      <p>Open your current plan from Today.</p>
      <Link to="/" search={dateSearch(date, today)}>
        Back to Today
      </Link>
    </section>
  );
}
