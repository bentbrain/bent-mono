import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

/**
 * The hold in progress, if any. `record` saves a set change from the hold
 * and returns whether it was saved; a finished hold starts the exercise's
 * rest from the moment it ended.
 */
export function useHoldTimer({
  workout,
  record,
  onStart,
}: {
  workout: Workout;
  record: (hold: Hold, change: Partial<SetEntry>, at: number) => boolean;
  /** Called as a hold starts, for example to end a rest that is running. */
  onStart?: () => void;
}) {
  const [hold, setHold] = useState<Hold | null>(null);
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
    if (!first) haptic(phase.kind === "hold" ? "warning" : "medium");
    AccessibilityInfo.announceForAccessibility(phaseAnnouncement(hold, phase));
  }, [hold, phase, key]);

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
    [workout],
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
  }, [hold]);

  // A hold whose set was handled elsewhere, for example on another device, ends.
  const set = hold ? workout.exercises[hold.exerciseIndex]?.sets[hold.setIndex] : undefined;
  useEffect(() => {
    if (hold && (!set || set.done || set.skipped)) setHold(null);
  }, [hold, set]);

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
