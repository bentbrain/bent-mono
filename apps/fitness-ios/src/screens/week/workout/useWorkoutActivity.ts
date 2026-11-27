import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { RecordEntry, Settings, Workout } from "@bent/fitness-contracts/domain";
import { WorkoutActivity } from "../../../../modules/workout-activity";
import { activityContent, sameActivity } from "./activity";
import type { ActivityContent } from "./activity";
import type { Hold } from "./hold";

const ignore = () => undefined;

/**
 * Keeps the workout's Live Activity and timer alert in step with the logger
 * while it is open. The activity stays after the logger closes, since the
 * workout is still in progress; finishing or discarding ends it.
 */
export function useWorkoutActivity({
  workoutId,
  workout,
  hold,
  units,
}: {
  workoutId: string;
  workout: Workout;
  hold: Hold | null;
  units: Settings["units"];
}) {
  // Content changes at the end of a rest or hold phase, so the clock moves
  // to each of those moments and when the app returns.
  const [now, setNow] = useState(() => Date.now());
  const content = activityContent(workoutId, workout, hold, units, now);
  const boundary = content?.staleAt ?? null;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (boundary === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, boundary - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [boundary]);
  useEffect(() => {
    // A new rest, hold or set changes the content without moving the clock.
    setNow(Date.now());
  }, [workout, hold]);

  const shown = useRef<ActivityContent | null>(null);
  const alert = useRef<string | null>(null);
  useEffect(() => {
    if (!WorkoutActivity || sameActivity(shown.current, content)) return;
    shown.current = content;
    if (content)
      void WorkoutActivity.show({
        workoutId: content.workoutId,
        workoutName: content.workoutName,
        startedAt: content.startedAt,
        state: content.state,
        staleAt: content.staleAt,
      }).catch(ignore);
    else void WorkoutActivity.end(workoutId).catch(ignore);

    const next = content?.alert ?? null;
    const key = next ? JSON.stringify(next) : null;
    if (key === alert.current) return;
    alert.current = key;
    if (next) void WorkoutActivity.scheduleAlert(next.title, next.body, next.at).catch(ignore);
    else WorkoutActivity.cancelAlert();
  });
}

/** Ends the Live Activity and timer alert, for finishing or discarding a workout. */
export function endWorkoutActivity(workoutId: string) {
  if (!WorkoutActivity) return;
  WorkoutActivity.cancelAlert();
  void WorkoutActivity.end(workoutId).catch(ignore);
}

/** Ends every workout Live Activity and the timer alert, for signing out. */
export function endAllWorkoutActivities() {
  if (!WorkoutActivity) return;
  WorkoutActivity.cancelAlert();
  void WorkoutActivity.end(null).catch(ignore);
}

/**
 * Ends Live Activities for workouts that are no longer in progress, for
 * example ones finished or discarded on another device.
 */
export function useEndFinishedActivities(records: RecordEntry[], loaded: boolean) {
  useEffect(() => {
    if (!WorkoutActivity || !loaded) return;
    const open = new Set(
      records.flatMap((record) => (record.data.kind === "workout" && !record.data.finishedAt ? [record.id] : [])),
    );
    let showing: string[];
    try {
      showing = WorkoutActivity.showing();
    } catch {
      return;
    }
    const finished = showing.filter((id) => !open.has(id));
    if (finished.length === showing.length && finished.length) WorkoutActivity.cancelAlert();
    for (const id of finished) void WorkoutActivity.end(id).catch(ignore);
  }, [records, loaded]);
}
