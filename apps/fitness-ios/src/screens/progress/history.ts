import { formatDate, sameData, trainingRecords } from "@bent/fitness-contracts/domain";
import type { Entity, RecordEntry, Workout } from "@bent/fitness-contracts/domain";

type Run = Extract<Entity, { kind: "run" }>;
type Correction = Extract<Entity, { kind: "workoutCorrection" }>;
export type WorkoutEntry = RecordEntry & { data: Workout };
export type RunEntry = RecordEntry & { data: Run };
export type CorrectionEntry = RecordEntry & { data: Correction };
export type SessionEntry = WorkoutEntry | RunEntry;

/** The saved correction for each workout, by workout ID. */
export function correctionsByWorkout(records: RecordEntry[]) {
  const corrections = new Map<string, CorrectionEntry>();
  for (const record of records)
    if (record.data.kind === "workoutCorrection") corrections.set(record.data.workoutId, { ...record, data: record.data });
  return corrections;
}

/** The recorded finished workouts, before corrections, by ID. */
export function finishedOriginals(records: RecordEntry[]) {
  const originals = new Map<string, WorkoutEntry>();
  for (const record of records)
    if (record.data.kind === "workout" && record.data.finishedAt) originals.set(record.id, { ...record, data: record.data });
  return originals;
}

/** Completed workouts and runs with corrections applied, newest first. */
export function historySessions(records: RecordEntry[]): SessionEntry[] {
  return trainingRecords(records)
    .flatMap((record): SessionEntry[] => {
      const data = record.data;
      if (data.kind === "workout" && data.finishedAt) return [{ ...record, data }];
      if (data.kind === "run") return [{ ...record, data }];
      return [];
    })
    .sort((a, b) => b.data.date.localeCompare(a.data.date) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Sessions grouped under their date, keeping the newest-first order. */
export function groupByDate(sessions: SessionEntry[]) {
  const groups: { date: string; sessions: SessionEntry[] }[] = [];
  for (const session of sessions) {
    const last = groups.at(-1);
    if (last?.date === session.data.date) last.sessions.push(session);
    else groups.push({ date: session.data.date, sessions: [session] });
  }
  return groups;
}

/** Workouts hidden from History by a correction, with the correction that hides them. */
export function removedWorkouts(records: RecordEntry[]) {
  const originals = finishedOriginals(records);
  return [...correctionsByWorkout(records).values()].flatMap((correction) => {
    const original = originals.get(correction.data.workoutId);
    return correction.data.replacement === null && original ? [{ correction, original }] : [];
  });
}

/** "Easy run on Fri 20 Nov 2026" or "Full body A on Fri 20 Nov 2026". */
export function sessionLabel(session: SessionEntry) {
  return `${session.data.kind === "run" ? "Easy run" : session.data.name} on ${formatDate(session.data.date)}`;
}

/** The change a workout's Remove action saves: a correction with no replacement. */
export function removalFor(workout: WorkoutEntry, correction: CorrectionEntry | undefined) {
  return {
    data: { kind: "workoutCorrection", workoutId: workout.id, replacement: null, reason: "Removed from history" } satisfies Correction,
    id: correction?.id,
    revision: correction?.revision ?? 0,
  };
}

/** The version of a record an editor opened. Saving checks it is still current. */
export type Opened<T extends Entity> = { id: string; revision: number; data: T };

/** Whether the record still matches the version the editor opened. */
export function editStatus(
  opened: Opened<Entity> | undefined,
  current: { revision: number; data: Entity | null } | undefined,
): "current" | "changed" | "removed" {
  if (!opened) return "current";
  if (!current?.data) return "removed";
  return current.revision === opened.revision && sameData(current.data, opened.data) ? "current" : "changed";
}

/** A workout correction an editor opened. A new correction has no data. */
export type OpenedCorrection = { id: string; revision: number; data: Correction | null };

/**
 * Whether a correction still matches the version its editor opened. Another
 * correction for the same workout, or a correction saved under the opened ID,
 * counts as a change.
 */
export function correctionStatus(
  opened: OpenedCorrection,
  current: { revision: number; data: Entity | null },
  other: { id: string } | undefined,
): "current" | "changed" | "removed" {
  if (other && other.id !== opened.id) return "changed";
  if (!opened.data) return current.data || current.revision !== opened.revision ? "changed" : "current";
  return editStatus({ ...opened, data: opened.data }, current);
}

/** The correction values an editor opens with. */
export function openCorrection(
  original: WorkoutEntry,
  correction: { id: string; revision: number; data: Correction } | undefined,
  newId: () => string,
) {
  const workout: Workout = { ...(correction?.data.replacement ?? original.data), finishedAt: null, restUntil: null };
  return {
    version: {
      id: correction?.id ?? newId(),
      revision: correction?.revision ?? 0,
      data: correction?.data ?? null,
    } satisfies OpenedCorrection,
    workout,
    reason: correction?.data.reason ?? "",
  };
}

/** A saved correction for this workout under another ID. */
export function otherCorrection(records: RecordEntry[], workoutId: string, id: string): CorrectionEntry | undefined {
  const other = records.find(
    (record) => record.data.kind === "workoutCorrection" && record.data.workoutId === workoutId && record.id !== id,
  );
  return other?.data.kind === "workoutCorrection" ? { ...other, data: other.data } : undefined;
}

/** A short description of a saved correction, for the conflict message. */
export function correctionText(saved: Correction | undefined) {
  if (!saved) return undefined;
  return saved.replacement ? `${formatDate(saved.replacement.date)} · ${saved.reason}` : "removed from History";
}

/** The group History scrolls to for a chosen day: that day, or the nearest earlier one. */
export function groupFor(groups: { date: string }[], date: string) {
  return groups.find((group) => group.date <= date)?.date;
}
