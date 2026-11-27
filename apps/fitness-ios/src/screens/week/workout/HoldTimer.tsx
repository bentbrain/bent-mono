import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState, View } from "react-native";
import type { Workout } from "@bent/fitness-contracts/domain";
import { formatDuration } from "@bent/fitness-contracts/timing";
import { Button } from "../../../ui/Button";
import { AppText } from "../../../ui/Text";
import { haptic } from "../../../ui/haptics";
import { cn, shape } from "../../../ui/typography";
import { holdEndsAt, holdPhase, holdResult, phaseAnnouncement, phaseKey, phaseTitle, startHold } from "./hold";
import type { Hold, HoldPhase } from "./hold";
import type { SetEntry } from "./session";

/*
 * Holds in progress, by workout. They live outside the logger, so a hold
 * keeps running when the logger closes, and the logger records it on return
 * if it ended meanwhile. They are kept in memory only.
 */
const holds = new Map<string, Hold>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function storeHold(workoutId: string, hold: Hold | null) {
  if (hold) holds.set(workoutId, hold);
  else holds.delete(workoutId);
  notify();
}

/** Forgets every hold, for example when the account's session ends. */
export function clearHolds() {
  holds.clear();
  notify();
}

/**
 * The workout's hold in progress, if any. `record` saves a set change from
 * the hold and returns whether it was saved; a finished hold starts the
 * exercise's rest from the moment it ended.
 */
export function useHoldTimer({
  workoutId,
  workout,
  record,
  onStart,
}: {
  workoutId: string;
  workout: Workout;
  record: (hold: Hold, change: Partial<SetEntry>, at: number) => boolean;
  /** Called as a hold starts, for example to end a rest that is running. */
  onStart?: () => void;
}) {
  const hold = useSyncExternalStore(subscribe, () => holds.get(workoutId) ?? null);
  const setHold = useCallback((next: Hold | null) => storeHold(workoutId, next), [workoutId]);
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef({ record, onStart });
  useLayoutEffect(() => {
    latest.current = { record, onStart };
  });

  useEffect(() => {
    if (!hold) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [hold]);

  const phase: HoldPhase | null = hold ? holdPhase(hold, now) : null;
  const key = phase ? phaseKey(phase) : null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!hold || !phase || key === announced.current) return;
    const first = announced.current === null;
    announced.current = key;
    if (phase.kind === "done") {
      if (latest.current.record(hold, holdResult(hold, holdEndsAt(hold)) ?? {}, holdEndsAt(hold))) haptic("success");
      else haptic("error");
      AccessibilityInfo.announceForAccessibility(phaseAnnouncement(hold, phase));
      setHold(null);
      return;
    }
    // A hold the logger reopens on shows its phase without a haptic.
    if (!first) haptic(phase.kind === "hold" ? "warning" : "medium");
    AccessibilityInfo.announceForAccessibility(phaseAnnouncement(hold, phase));
  }, [hold, phase, key, setHold]);

  const start = useCallback(
    (exerciseIndex: number, setIndex: number, targets: { seconds: number; right: number | null }) => {
      const started = startHold(workout, exerciseIndex, setIndex, targets, Date.now());
      if (!started) return false;
      announced.current = null;
      setNow(started.startedAt);
      setHold(started);
      latest.current.onStart?.();
      haptic("medium");
      return true;
    },
    [workout, setHold],
  );

  /** Ends the hold now, recording the seconds held so far. */
  const stop = useCallback(() => {
    if (!hold) return;
    const at = Date.now();
    const change = holdResult(hold, at);
    if (change && !latest.current.record(hold, change, at)) {
      haptic("error");
      return;
    }
    haptic("light");
    setHold(null);
  }, [hold, setHold]);

  // A hold whose set was handled elsewhere, for example on another device, ends.
  const set = hold ? workout.exercises[hold.exerciseIndex]?.sets[hold.setIndex] : undefined;
  useEffect(() => {
    if (hold && (!set || set.done || set.skipped)) setHold(null);
  }, [hold, set, setHold]);

  return { hold, phase: phase?.kind === "done" ? null : phase, now, start, stop };
}
export type HoldTimer = ReturnType<typeof useHoldTimer>;

/** The countdown and Stop button shown in a set while its hold runs. */
export function HoldCountdown({ timer, testID }: { timer: HoldTimer; testID: string }) {
  const { hold, phase, now } = timer;
  if (!hold || !phase) return null;
  const remaining = Math.max(0, Math.ceil((phase.endsAt - now) / 1000));
  const holding = phase.kind === "hold";
  const title = phaseTitle(phase);
  return (
    <View
      testID={testID}
      className={cn("gap-3 p-3", holding ? "bg-primary-soft" : "bg-card")}
      style={{ borderRadius: shape.control, borderCurve: "continuous" }}
    >
      <View
        className="flex-row items-end justify-between gap-3"
        accessible
        accessibilityRole="timer"
        accessibilityLabel={`${title}: ${formatDuration(remaining)}`}
      >
        <AppText textRole="footnote" weight="semibold" tone={holding ? "primary" : "secondary"} className="uppercase">
          {title}
        </AppText>
        <AppText
          testID={`${testID}-remaining`}
          weight="heavy"
          tone={holding ? "primary" : "default"}
          style={{ fontSize: 40, lineHeight: 46, fontVariant: ["tabular-nums"] }}
        >
          {formatDuration(remaining)}
        </AppText>
      </View>
      <Button
        label={holding ? "Stop and record" : "Cancel hold"}
        tone="secondary"
        icon="stop.fill"
        fullWidth
        testID={`${testID}-stop`}
        onPress={timer.stop}
      />
    </View>
  );
}
