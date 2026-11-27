import { Host, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo, AppState, Pressable, View } from "react-native";
import type { Workout } from "@bent/fitness-contracts/domain";
import { elapsedSeconds, formatDuration, remainingRest } from "@bent/fitness-contracts/timing";
import { Button } from "../../../ui/Button";
import { Notice } from "../../../ui/Layout";
import { Symbol } from "../../../ui/Symbol";
import { AppText } from "../../../ui/Text";
import { haptic } from "../../../ui/haptics";
import { cn, shape } from "../../../ui/typography";
import { progressText, restAnnouncement, restChoices, restDoneShowing, sessionProgress, suggestedRest } from "./session";

/** The current time, updated every second and as soon as the app returns. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return [now, setNow] as const;
}

/**
 * Elapsed session time and the rest timer. Both count from times saved
 * with the workout, so they keep counting across screens, app switches and
 * restarts. When a rest ends while the logger is open, or the app returns
 * after it ended, the iPhone gives a haptic and VoiceOver announces the
 * next set.
 */
export function SessionTimer({
  workout,
  error,
  onRest,
}: {
  workout: Workout;
  /** A message when the last rest change could not be saved. */
  error?: string;
  /** Saves a new rest deadline, or null to stop the rest. */
  onRest: (restUntil: number | null) => void;
}) {
  const [now, setNow] = useNow();
  const rest = remainingRest(workout.restUntil, now);
  const elapsed = elapsedSeconds(workout.startedAt, now);
  const progress = sessionProgress(workout);
  const runningDeadline = useRef<number | null>(null);
  const [endedDeadline, setEndedDeadline] = useState<number | null>(null);
  const next = progress.next;
  const announcement = useRef(restAnnouncement(next));
  useLayoutEffect(() => {
    announcement.current = restAnnouncement(next);
  });
  useEffect(() => {
    if (rest > 0) runningDeadline.current = workout.restUntil;
    else if (workout.restUntil !== null && runningDeadline.current === workout.restUntil) {
      runningDeadline.current = null;
      setEndedDeadline(workout.restUntil);
      haptic("success");
      AccessibilityInfo.announceForAccessibility(announcement.current);
    }
  }, [rest, workout.restUntil]);
  const restDone = restDoneShowing(endedDeadline, workout.restUntil, now);

  const [restDuration, setRestDuration] = useState(() => suggestedRest(workout));
  const choices = restChoices(workout);
  const [controlsOpen, setControlsOpen] = useState(false);

  function setRest(restUntil: number | null) {
    setNow(Date.now());
    onRest(restUntil);
  }

  return (
    <View className="gap-3">
      <View
        testID="workout-timing"
        className={cn("gap-4 p-4", restDone ? "bg-done-soft" : rest > 0 ? "bg-primary-soft" : "bg-card")}
        style={{ borderRadius: shape.card, borderCurve: "continuous" }}
      >
        <View className="flex-row items-end gap-4">
          <View
            className="flex-1 gap-0.5"
            accessible
            accessibilityRole="timer"
            accessibilityLabel={`Rest timer: ${rest > 0 ? formatDuration(rest) : restDone ? "Rest done" : "Not running"}`}
          >
            <AppText textRole="caption" weight="medium" tone="muted" className="uppercase">
              Rest
            </AppText>
            {rest > 0 ? (
              <AppText testID="rest-remaining" weight="heavy" tone="primary" style={{ fontSize: 48, lineHeight: 54, fontVariant: ["tabular-nums"] }}>
                {formatDuration(rest)}
              </AppText>
            ) : (
              <AppText testID="rest-remaining" textRole="largeTitle" weight="bold" tone={restDone ? "done" : "muted"}>
                {restDone ? "Rest done" : "Not running"}
              </AppText>
            )}
          </View>
          <View
            className="items-end gap-0.5"
            accessible
            accessibilityRole="timer"
            accessibilityLabel={`Workout elapsed time: ${formatDuration(elapsed)}`}
          >
            <AppText textRole="caption" weight="medium" tone="muted" className="uppercase">
              Elapsed
            </AppText>
            <AppText testID="workout-elapsed" textRole="title" weight="bold" style={{ fontVariant: ["tabular-nums"] }}>
              {formatDuration(elapsed)}
            </AppText>
          </View>
        </View>
        <View className="gap-1.5">
          <View className="h-2 overflow-hidden rounded-full bg-separator" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <View className="h-2 rounded-full bg-primary" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </View>
          <AppText textRole="footnote" weight="semibold" tone="secondary" testID="workout-set-count">
            {progressText(progress)}
          </AppText>
        </View>
        {restDone ? (
          <AppText textRole="footnote" weight="medium" tone="done" testID="rest-announcement">
            {restAnnouncement(next)}
          </AppText>
        ) : null}
        {rest > 0 ? (
          <Button label="Skip rest" tone="secondary" icon="forward.fill" fullWidth testID="skip-rest" onPress={() => setRest(null)} />
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </View>

      <View className="overflow-hidden bg-grouped-card" style={{ borderRadius: shape.group, borderCurve: "continuous" }}>
        <Pressable
          testID="rest-controls"
          accessibilityRole="button"
          accessibilityLabel="Rest controls"
          accessibilityState={{ expanded: controlsOpen }}
          onPress={() => {
            haptic("selection");
            setControlsOpen((open) => !open);
          }}
          className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:bg-card-alt"
        >
          <Symbol name="timer" size={20} tintColorClassName="accent-icon" />
          <AppText className="flex-1">Rest controls</AppText>
          <Symbol name={controlsOpen ? "chevron.up" : "chevron.down"} size={13} weight="semibold" tintColorClassName="accent-chevron" />
        </Pressable>
        {controlsOpen ? (
          <View className="gap-3 px-4 pb-4">
            <View className="h-px bg-separator" />
            <View className="min-h-11 flex-row items-center justify-between gap-3">
              <AppText>New rest length</AppText>
              <Host matchContents testID="rest-length">
                <Picker
                  label="New rest length"
                  selection={restDuration}
                  onSelectionChange={(seconds: number) => {
                    haptic("selection");
                    setRestDuration(seconds);
                  }}
                  modifiers={[pickerStyle("menu")]}
                >
                  {choices.map((seconds) => (
                    <SwiftText key={seconds} modifiers={[tag(seconds)]}>
                      {formatDuration(seconds)}
                    </SwiftText>
                  ))}
                </Picker>
              </Host>
            </View>
            <Button
              label={`Start new ${formatDuration(restDuration)} rest`}
              tone="tinted"
              icon="play.fill"
              fullWidth
              testID="start-rest"
              onPress={() => setRest(Date.now() + restDuration * 1000)}
            />
            <AppText textRole="footnote" tone="muted">
              Rest starts when you mark a set Done. Your elapsed timer runs from the session start.
            </AppText>
          </View>
        ) : null}
      </View>
    </View>
  );
}
