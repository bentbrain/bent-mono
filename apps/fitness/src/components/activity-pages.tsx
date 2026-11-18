import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@bent/ui/button";
import { z } from "zod";
import {
  createWorkout,
  effectivePrescription,
  runSchema,
  scheduled,
} from "../domain";
import { useAccount } from "./account-context";
import { ExerciseGuide } from "./guide";
import { TextField } from "./fields";
import { WorkoutEditor } from "./workout";
import { formatDuration } from "../timing";

export function PlanScreen({
  date,
  routineId,
}: {
  date: string;
  routineId: string;
}) {
  const { sync, settings } = useAccount();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const routine = settings.routines.find((item) => item.id === routineId);
  if (!z.iso.date().safeParse(date).success || !routine)
    return <Unavailable title="Plan unavailable" />;
  const intro = scheduled(settings, date).intro;
  const active = sync.records.find(
    (record) => record.data.kind === "workout" && !record.data.finishedAt,
  );
  function start() {
    if (starting || active || !routine) return;
    setStarting(true);
    const id = crypto.randomUUID();
    if (
      sync.put(createWorkout(settings, routine, date, intro, sync.records), id)
    ) {
      void navigate({
        to: "/workout",
        search: { date, workoutId: id },
      });
    } else setStarting(false);
  }
  return (
    <section
      className="plan-preview"
      data-feedback-private
      data-feedback-redact
    >
      <Link className="back-link" to="/" search={{ date }}>
        <span aria-hidden>←</span> Back to Today
      </Link>
      <p className="eyebrow">Workout plan · {date}</p>
      <h1>{routine.name}</h1>
      <p className="subtitle">
        {routine.exercises.length} exercises ·{" "}
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
        {active ? (
          <>
            <p>
              You have a workout in progress. Resume it when you are ready to
              train.
            </p>
            <Link
              className="bent-button bent-button--primary"
              to="/workout"
              search={{ date, workoutId: active.id }}
            >
              Resume workout
            </Link>
          </>
        ) : (
          <>
            <Button appearance="primary" disabled={starting} onClick={start}>
              {starting ? "Opening workout…" : "Start workout"}
            </Button>
            <p className="muted">
              Start when you are ready to train. This begins your session and
              elapsed timer.
            </p>
          </>
        )}
      </div>
      {routine.exercises.map((prescription, index) => {
        const exercise = effectivePrescription(prescription, intro);
        return (
          <article className="card plan-exercise" key={exercise.id}>
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
            <ExerciseGuide id={exercise.id} />
          </article>
        );
      })}
    </section>
  );
}

export function WorkoutScreen({ workoutId }: { workoutId: string }) {
  const { sync, settings, date } = useAccount();
  const navigate = useNavigate();
  const entry = sync.records.find((record) => record.id === workoutId);
  if (!entry || entry.data.kind !== "workout")
    return <Unavailable title="Workout unavailable" />;
  if (entry.data.finishedAt)
    return (
      <section>
        <h1>Workout completed</h1>
        <p>
          View your results in History. Check the save status before closing the
          app.
        </p>
        <Link to="/history" search={{ date }}>
          Open history
        </Link>
      </section>
    );
  const workoutDate = entry.data.date;
  return (
    <>
      <Link className="back-link" to="/" search={{ date: workoutDate }}>
        <span aria-hidden>←</span> Back to Today
      </Link>
      <WorkoutEditor
        entry={{ ...entry, data: entry.data }}
        settings={settings}
        sync={sync}
        onFinish={() =>
          void navigate({ to: "/history", search: { date: workoutDate } })
        }
        onDiscard={() =>
          void navigate({ to: "/", search: { date: workoutDate } })
        }
      />
    </>
  );
}

export function RunScreen({ date }: { date: string }) {
  const { sync } = useAccount();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  if (!z.iso.date().safeParse(date).success)
    return <Unavailable title="Run plan unavailable" />;
  return (
    <section data-feedback-private data-feedback-redact>
      <Link className="back-link" to="/" search={{ date }}>
        <span aria-hidden>←</span> Back to Today
      </Link>
      <p className="eyebrow">Run plan · {date}</p>
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
          if (sync.put(result.data))
            void navigate({ to: "/", search: { date: result.data.date } });
        }}
      >
        <h2>Record your completed run</h2>
        <TextField
          label="Date"
          id="run-date"
          name="date"
          type="date"
          defaultValue={date}
          required
        />
        <TextField
          label="Duration · minutes"
          id="run-minutes"
          name="minutes"
          type="number"
          min="1"
          max="1440"
          required
        />
        <TextField
          label="Distance · km"
          id="run-distance"
          name="distance"
          type="number"
          min="0"
          max="500"
          step="0.01"
          required
        />
        <TextField label="Notes" id="run-notes" name="notes" maxLength={2000} />
        <Button type="submit" appearance="primary">
          Save run
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
function Unavailable({ title }: { title: string }) {
  const { date } = useAccount();
  return (
    <section>
      <h1>{title}</h1>
      <p>Open your current plan from Today.</p>
      <Link to="/" search={{ date }}>
        Back to Today
      </Link>
    </section>
  );
}
