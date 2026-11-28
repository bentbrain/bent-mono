import { useEffect, useId, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@bent/ui/sdk/button";
import {
  exercises,
  lastExercise,
  loadTag,
  loadWording,
  setResult,
} from "@bent/fitness-contracts/domain";
import type { Exercise } from "@bent/fitness-contracts/domain";
import { guides } from "@bent/fitness-contracts/guides";
import { formatDuration } from "@bent/fitness-contracts/timing";
import { useAccount } from "./account-context";
import { Icon } from "./icons";

const guideFor = (id: string) => guides.find((guide) => guide.id === id);
const nameFor = (id: string) =>
  exercises.find((exercise) => exercise.id === id)?.name ?? "Exercise";

/** "3 × 8–12 reps each side · 2:00 rest" */
export function prescriptionText(exercise: Exercise) {
  const unit =
    exercise.mode === "seconds"
      ? exercise.side
        ? "seconds each side"
        : "seconds"
      : exercise.side
        ? "reps each side"
        : "reps";
  const tag = loadTag(exercise);
  return `${exercise.sets} × ${exercise.min}–${exercise.max} ${unit}${tag ? ` · ${tag}` : ""} · ${formatDuration(exercise.rest)} rest`;
}

/** How to record the exercise, in plain words. */
function recordingNotes(exercise: Exercise) {
  if (exercise.mode === "seconds")
    return exercise.side
      ? "Hold each side for time. Log the seconds for left and right."
      : "Hold for time. Log the seconds you held with good form.";
  // The note names no unit, so either unit reads the same.
  const { note } = loadWording(exercise, "kg");
  return exercise.side
    ? `${note} Log the reps for your left and right side separately.`
    : `${note} Log the reps you completed with control.`;
}

/** The middle frames of an exercise illustration, as a small picture. */
export function ExerciseThumb({ id }: { id: string }) {
  return guideFor(id) ? (
    <span className="exercise-thumb">
      <img
        src={`/exercise-guides/thumbs/${id}.jpg`}
        alt=""
        width={512}
        height={206}
        loading="lazy"
        decoding="async"
      />
    </span>
  ) : (
    <span className="exercise-thumb is-empty" aria-hidden="true">
      <Icon name="exercises" size={28} />
    </span>
  );
}

/** Setup, steps, picture, video and plan details for one exercise. */
function ExerciseDetail({
  id,
  prescription,
  headingLevel = 2,
}: {
  id: string;
  /** The prescription being planned or logged, for exercises without a guide. */
  prescription?: Exercise;
  headingLevel?: 2 | 3;
}) {
  const { settings, sync } = useAccount();
  const guide = guideFor(id);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const fallback = exercises.find((exercise) => exercise.id === id);
  const inPlan = settings.routines.flatMap((routine) =>
    routine.exercises
      .filter((exercise) => exercise.id === id)
      .map((exercise) => ({ routine: routine.name, exercise })),
  );
  const measured = inPlan[0]?.exercise ?? fallback;
  const previous = lastExercise(sync.records, id);
  if (!guide)
    return (
      <>
        {prescription && (
          <>
            <p className="prescription">{prescriptionText(prescription)}</p>
            <p>{recordingNotes(prescription)}</p>
          </>
        )}
        <p>
          Use a familiar movement and a light practice set. Ask a qualified
          trainer for setup and form guidance.
        </p>
      </>
    );
  return (
    <div
      className="exercise-detail"
      data-feedback-id={`guide-${id}`}
      data-feedback-private
      data-feedback-redact
    >
      <figure className="exercise-illustration">
        <Button
          render={
            <a
              href={`/exercise-guides/${guide.id}.png`}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          <img
            src={`/exercise-guides/${guide.id}.png`}
            alt={guide.illustrationAlt}
            width={1024}
            height={1536}
            loading="lazy"
            decoding="async"
          />
          <span>Open illustration at full size ↗</span>
        </Button>
        <figcaption>
          AI-generated reference. Compare both views with the written cues and
          video demonstration.
        </figcaption>
      </figure>
      <div className="exercise-copy">
        <Button
          className="video-link"
          render={
            <a
              href={`https://www.youtube.com/watch?v=${guide.video}`}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          <Icon name="play" size={16} />
          <span className="video-link-label">
            <span className="video-link-title">
              Watch tutorial<span className="visually-hidden"> · </span>
              <span aria-hidden>{"\u00a0↗"}</span>
            </span>
            <span className="video-link-credit">{guide.credit}</span>
          </span>
        </Button>
        <p className="muted">
          Tutorial opens on YouTube. Start light and stop if a movement hurts.
        </p>
        {measured && (
          <div className="fact-list">
            <Heading>How to record it</Heading>
            <p>{recordingNotes(measured)}</p>
            {inPlan.length ? (
              <ul>
                {inPlan.map(({ routine, exercise }) => (
                  <li key={routine}>
                    <strong>{routine}</strong> · {prescriptionText(exercise)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                Not in your routines. Add it to a routine from Repeating week.
              </p>
            )}
            <p className="previous">
              Last time:{" "}
              {previous
                ? previous.sets
                    .map((set) =>
                      setResult(set, previous.prescription, settings.units),
                    )
                    .join(" · ")
                : "Not recorded yet"}
            </p>
          </div>
        )}
        <Heading>Set up</Heading>
        <p>{guide.setup}</p>
        <Heading>Move</Heading>
        <ol className="steps">
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <Heading>Watch for</Heading>
        <p>{guide.avoid}</p>
      </div>
    </div>
  );
}

/**
 * A "How to" button that opens the exercise guide over the current screen.
 * Closing it returns focus to the button and leaves the page state unchanged.
 */
export function ExerciseHelp({
  id,
  prescription,
}: {
  id: string;
  /** The prescription being planned or logged, for exercises without a guide. */
  prescription?: Exercise;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const name = guideFor(id) ? nameFor(id) : (prescription?.name ?? nameFor(id));
  useEffect(() => {
    const element = dialog.current;
    return () => element?.close();
  }, []);
  return (
    <>
      <Button
        className="help-button"
        aria-label={`How to do ${name}`}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        <Icon name="info" size={16} />
        How to
      </Button>
      <dialog
        ref={dialog}
        className="sheet"
        aria-labelledby={title}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="sheet-body">
          <div className="sheet-head">
            <h2 id={title}>{name}</h2>
            <Button
              className="icon-button"
              aria-label="Close guide"
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </Button>
          </div>
          <ExerciseDetail
            id={id}
            prescription={prescription}
            headingLevel={3}
          />
          {/* Only catalogue exercises have a page in Exercises. */}
          {guideFor(id) && (
            <Button
              className="text-link"
              render={
                <Link
                  to="/guides"
                  search={{ exercise: id }}
                  onClick={() => dialog.current?.close()}
                />
              }
            >
              Open in Exercises
            </Button>
          )}
        </div>
      </dialog>
    </>
  );
}

/** The exercise library, or one exercise when `exercise` is set. */
export function ExercisesScreen({ exercise }: { exercise?: string }) {
  const { settings } = useAccount();
  const selected = exercise ? guideFor(exercise) : undefined;
  if (selected)
    return (
      <section className="exercise-page">
        <Button
          className="back-link"
          render={<Link to="/guides" search={{}} />}
        >
          <Icon name="back" size={16} /> All exercises
        </Button>
        <p className="eyebrow">Exercise guide</p>
        <h1>{nameFor(selected.id)}</h1>
        <ExerciseDetail id={selected.id} />
      </section>
    );
  const order = [
    ...new Set([
      ...settings.routines.flatMap((routine) =>
        routine.exercises.map((item) => item.id),
      ),
      ...exercises.map((item) => item.id),
    ]),
  ];
  return (
    <section data-feedback-private data-feedback-redact>
      <header className="page-head">
        <p className="eyebrow">Learn the movements</p>
        <h1>Exercises</h1>
        <p className="lede">
          Read the setup, practise with a light weight, then watch the tutorial.
          Each guide shows the movement from two angles.
        </p>
      </header>
      <ul className="exercise-grid">
        {order.map((id) => {
          const base = exercises.find((item) => item.id === id);
          if (!base) return null;
          const routines = settings.routines
            .filter((routine) => routine.exercises.some((e) => e.id === id))
            .map((routine) => routine.name);
          return (
            <li key={id}>
              <Button
                className="exercise-tile"
                render={<Link to="/guides" search={{ exercise: id }} />}
              >
                <ExerciseThumb id={id} />
                <span className="tile-text">
                  <strong>{base.name}</strong>
                  <span className="chips">
                    <span className="chip">
                      {base.mode === "seconds" ? "Timed hold" : "Reps"}
                    </span>
                    {base.side && <span className="chip">Each side</span>}
                    {base.mode === "reps" && (
                      <span className="chip">
                        {loadWording(base, "kg").tag}
                      </span>
                    )}
                  </span>
                  <small>
                    {routines.length
                      ? `In ${routines.join(", ")}`
                      : "Not in your routines"}
                  </small>
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
