import { useEffect, useRef, useState } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { Button } from "@bent/ui/sdk/button";
import { TextField } from "./fields";
import {
  correctionReplacement,
  formatDate,
  setResult,
  trainingRecords,
} from "@bent/fitness-contracts/domain";
import type { RecordEntry, Workout } from "@bent/fitness-contracts/domain";
import { useAccount } from "./account-context";
import { ExerciseList, InputNotices, NotesField } from "./workout";
import { useWorkoutInputs } from "./workout-inputs";
import { ProgressTabs } from "./progress-screen";
import { correctionStatus, EditConflict } from "./record-edit";
import type { OpenedCorrection } from "./record-edit";

type WorkoutEntry = RecordEntry & { data: Workout };
type CorrectionEntry = RecordEntry & {
  data: Extract<RecordEntry["data"], { kind: "workoutCorrection" }>;
};

function correctionsByWorkout(records: RecordEntry[]) {
  const corrections = new Map<string, CorrectionEntry>();
  for (const record of records)
    if (record.data.kind === "workoutCorrection")
      corrections.set(record.data.workoutId, { ...record, data: record.data });
  return corrections;
}

export function History() {
  const { sync, settings, date } = useAccount();
  const [correcting, setCorrecting] = useState<string>();
  const [notice, setNotice] = useState("");
  const corrections = correctionsByWorkout(sync.records);
  const originals = new Map<string, WorkoutEntry>();
  for (const record of sync.records)
    if (record.data.kind === "workout" && record.data.finishedAt)
      originals.set(record.id, { ...record, data: record.data });
  const sessions = trainingRecords(sync.records)
    .flatMap((record) =>
      (record.data.kind === "workout" && record.data.finishedAt) ||
      record.data.kind === "run"
        ? [{ ...record, data: record.data }]
        : [],
    )
    .sort(
      (a, b) =>
        b.data.date.localeCompare(a.data.date) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const removed = [...corrections.values()].flatMap((correction) => {
    const original = originals.get(correction.data.workoutId);
    return correction.data.replacement === null && original
      ? [{ correction, original }]
      : [];
  });
  const original = correcting ? originals.get(correcting) : undefined;
  if (original)
    return (
      <CorrectionEditor
        original={original}
        correction={corrections.get(original.id)}
        onClose={(message) => {
          setCorrecting(undefined);
          setNotice(message);
        }}
      />
    );
  function remove(workout: WorkoutEntry) {
    const correction = corrections.get(workout.id);
    if (
      !window.confirm(
        `Remove ${workout.data.name} on ${formatDate(workout.data.date)} from History and weight suggestions? You can restore it from Removed workouts.`,
      )
    )
      return;
    if (
      sync.put(
        {
          kind: "workoutCorrection",
          workoutId: workout.id,
          replacement: null,
          reason: "Removed from history",
        },
        correction?.id,
        correction?.revision ?? 0,
      )
    )
      setNotice(
        `Removed ${workout.data.name} on ${formatDate(workout.data.date)}.`,
      );
  }
  function restore(correction: CorrectionEntry, name: string) {
    if (
      window.confirm(
        `Restore the original recorded results for ${name}? Your correction will be removed.`,
      ) &&
      sync.put(null, correction.id, correction.revision)
    )
      setNotice(`Restored the original results for ${name}.`);
  }
  return (
    <section data-feedback-private data-feedback-redact>
      <header className="page-head">
        <p className="eyebrow">Progress</p>
        <h1>History</h1>
      </header>
      <ProgressTabs />
      <p role="status">{notice}</p>
      {!sessions.length && (
        <p className="empty">
          Your completed workouts and runs will appear here.
        </p>
      )}
      {sessions.map((record) => {
        const label = `${record.data.kind === "run" ? "Easy run" : record.data.name} on ${formatDate(record.data.date)}`;
        if (record.data.kind === "run")
          return (
            <article className="card history-entry" key={record.id}>
              <h2>{formatDate(record.data.date)} · Easy run</h2>
              <p>
                {record.data.minutes} min · {record.data.distanceKm} km
              </p>
              {record.data.notes && <p>{record.data.notes}</p>}
              <div className="row history-actions">
                <Button
                  className="bent-button bent-button--outline"
                  render={
                    <Link
                      to="/run"
                      search={{ runId: record.id }}
                      aria-label={`Edit ${label}`}
                    />
                  }
                >
                  Edit run
                </Button>
                <Button
                  appearance="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => {
                    if (
                      window.confirm(`Remove the ${label}?`) &&
                      sync.put(null, record.id, record.revision)
                    )
                      setNotice(`Removed the ${label}.`);
                  }}
                >
                  Remove run
                </Button>
              </div>
            </article>
          );
        const workout = record.data;
        const correction = corrections.get(record.id);
        const originalEntry = originals.get(record.id);
        return (
          <details
            className="card history-entry"
            key={record.id}
            open={workout.date === date}
          >
            <summary>
              {formatDate(workout.date)} · {workout.name}
              {correction && <span className="tag">Corrected</span>}
            </summary>
            {workout.exercises.map((exercise, i) => (
              <div className="history-exercise" key={i}>
                <strong>{exercise.prescription.name}</strong>
                <p>
                  {exercise.sets
                    .map((set) =>
                      setResult(set, exercise.prescription, settings.units),
                    )
                    .join(" · ")}
                </p>
              </div>
            ))}
            {workout.notes && <p>{workout.notes}</p>}
            {correction && (
              <p className="muted">Correction note: {correction.data.reason}</p>
            )}
            {originalEntry && (
              <div className="row history-actions">
                <Button
                  appearance="outline"
                  aria-label={`Correct ${label}`}
                  onClick={() => {
                    setNotice("");
                    setCorrecting(record.id);
                  }}
                >
                  Correct results
                </Button>
                {correction && (
                  <Button
                    appearance="ghost"
                    aria-label={`Restore original results for ${label}`}
                    onClick={() => restore(correction, label)}
                  >
                    Restore original
                  </Button>
                )}
                <Button
                  appearance="ghost"
                  aria-label={`Remove ${label}`}
                  onClick={() => remove(originalEntry)}
                >
                  Remove workout
                </Button>
              </div>
            )}
          </details>
        );
      })}
      {removed.length > 0 && (
        <>
          <h2 className="section-label">Removed workouts</h2>
          <p className="muted">
            These workouts are hidden from History, your schedule and weight
            suggestions. Your account export keeps the original results.
          </p>
          {removed.map(({ correction, original: entry }) => {
            const label = `${entry.data.name} on ${formatDate(entry.data.date)}`;
            return (
              <div className="list-row" key={correction.id}>
                <span>{label}</span>
                <Button
                  appearance="ghost"
                  aria-label={`Restore ${label}`}
                  onClick={() => restore(correction, label)}
                >
                  Restore
                </Button>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

/** The correction values an editor opens with. */
function openCorrection(
  original: WorkoutEntry,
  correction?: { id: string; revision: number; data: CorrectionEntry["data"] },
) {
  const workout: Workout = {
    ...(correction?.data.replacement ?? original.data),
    finishedAt: null,
    restUntil: null,
  };
  return {
    version: {
      id: correction?.id ?? crypto.randomUUID(),
      revision: correction?.revision ?? 0,
      data: correction?.data ?? null,
    } satisfies OpenedCorrection,
    workout,
    reason: correction?.data.reason ?? "",
  };
}

function CorrectionEditor({
  original,
  correction,
  onClose,
}: {
  original: WorkoutEntry;
  correction: CorrectionEntry | undefined;
  onClose: (message: string) => void;
}) {
  const { sync, settings, today } = useAccount();
  // Saving checks the correction still matches the version this editor opened.
  const [opened, setOpened] = useState(() =>
    openCorrection(original, correction),
  );
  const [draft, setDraft] = useState<Workout>(opened.workout);
  const latest = useRef(draft);
  const [reason, setReason] = useState(opened.reason);
  const [date, setDate] = useState(opened.workout.date);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<"changed" | "removed">();
  const [closing, setClosing] = useState(false);
  const inputs = useWorkoutInputs({
    workout: draft,
    units: settings.units,
    storageKey: null,
    save: (next) => {
      latest.current = next;
      setDraft(next);
      return true;
    },
  });
  /** A saved correction for this workout under another ID. */
  function otherCorrection(id: string) {
    const other = sync.records.find(
      (record) =>
        record.data.kind === "workoutCorrection" &&
        record.data.workoutId === original.id &&
        record.id !== id,
    );
    return other?.data.kind === "workoutCorrection"
      ? { ...other, data: other.data }
      : undefined;
  }
  const live = sync.records.find((record) => record.id === opened.version.id);
  const liveOther = otherCorrection(opened.version.id);
  const derived = correctionStatus(
    opened.version,
    { revision: live?.revision ?? 0, data: live?.data ?? null },
    liveOther,
  );
  const status = derived === "current" ? checked : derived;
  const saved =
    liveOther?.data ??
    (live?.data.kind === "workoutCorrection" ? live.data : undefined);
  const dirty =
    !closing &&
    (inputs.pending ||
      reason !== opened.reason ||
      date !== opened.workout.date ||
      JSON.stringify(draft) !== JSON.stringify(opened.workout));
  useBlocker({
    shouldBlockFn: () =>
      dirty && !window.confirm("Leave without saving this correction?"),
    enableBeforeUnload: dirty,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const label = `${original.data.name} on ${formatDate(original.data.date)}`;
  /** The newest saved correction for this workout, including other tabs. */
  function savedVersion(): OpenedCorrection | undefined {
    const other = otherCorrection(opened.version.id);
    if (other)
      return { id: other.id, revision: other.revision, data: other.data };
    const current = sync.latest(opened.version.id);
    return current.data?.kind === "workoutCorrection"
      ? {
          id: opened.version.id,
          revision: current.revision,
          data: current.data,
        }
      : undefined;
  }
  function save(target: OpenedCorrection) {
    if (!reason.trim()) {
      setError("Enter a short reason for the correction.");
      return;
    }
    if (!date || date > today) {
      setError("Choose today or an earlier date.");
      return;
    }
    if (!inputs.commit({ change: (workout) => ({ ...workout, date }) })) return;
    const result = correctionReplacement(original.data, latest.current, date);
    if ("problem" in result) {
      setError(result.problem);
      return;
    }
    const state = correctionStatus(
      target,
      sync.latest(target.id),
      otherCorrection(target.id),
    );
    if (state !== "current") {
      setChecked(state);
      setError("");
      return;
    }
    if (
      sync.put(
        {
          kind: "workoutCorrection",
          workoutId: original.id,
          replacement: result.replacement,
          reason: reason.trim(),
        },
        target.id,
        target.revision,
      )
    ) {
      setClosing(true);
      onClose(`Saved corrected results for ${label}.`);
    } else
      setError(
        "This correction could not be saved. Check the message above, then cancel and reopen the workout.",
      );
  }
  /** Replaces the typed values with the saved correction. */
  function loadSaved() {
    const next = savedVersion();
    if (!next?.data) return;
    if (!next.data.replacement) {
      setClosing(true);
      inputs.clear();
      onClose(
        `${label} was removed from History on another device. Restore it from Removed workouts to correct it.`,
      );
      return;
    }
    const version = openCorrection(original, { ...next, data: next.data });
    setOpened(version);
    inputs.clear();
    latest.current = version.workout;
    setDraft(version.workout);
    setReason(version.reason);
    setDate(version.workout.date);
    setChecked(undefined);
    setError("");
  }
  return (
    <section data-feedback-private data-feedback-redact>
      <p className="eyebrow">
        Correct results · {formatDate(original.data.date)}
      </p>
      <h1 ref={heading} tabIndex={-1}>
        Correct {original.data.name}
      </h1>
      <p className="lede">
        Your corrected results replace the originals in History, your schedule
        and future weight suggestions. Your account export keeps the original
        results, and you can restore them at any time.
      </p>
      <div className="card form-grid">
        <TextField
          label="Workout date"
          type="date"
          value={date}
          max={today}
          required
          onValueChange={setDate}
        />
        <TextField
          label="Reason for correction"
          value={reason}
          maxLength={160}
          required
          placeholder="e.g. Entered the wrong weight"
          onValueChange={setReason}
        />
      </div>
      <InputNotices inputs={inputs} />
      <ExerciseList workout={draft} settings={settings} inputs={inputs} />
      <NotesField inputs={inputs} />
      {inputs.message?.place === "finish" && (
        <p role="alert">{inputs.message.text}</p>
      )}
      {status && (
        <EditConflict
          status={status}
          noun="correction"
          current={
            saved
              ? saved.replacement
                ? `${formatDate(saved.replacement.date)} · ${saved.reason}`
                : "removed from History"
              : undefined
          }
          onKeepMine={() => {
            const next = savedVersion();
            if (!next) return;
            setOpened((value) => ({ ...value, version: next }));
            setChecked(undefined);
            save(next);
          }}
          onUseCurrent={loadSaved}
          onSaveAsNew={() =>
            save({ id: crypto.randomUUID(), revision: 0, data: null })
          }
        />
      )}
      {error && <p role="alert">{error}</p>}
      <div className="row history-actions">
        <Button
          appearance="primary"
          disabled={Boolean(status)}
          onClick={() => save(opened.version)}
        >
          Save correction
        </Button>
        <Button
          appearance="ghost"
          onClick={() => {
            if (
              !dirty ||
              window.confirm("Discard the changes to this correction?")
            ) {
              setClosing(true);
              inputs.clear();
              onClose("");
            }
          }}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
