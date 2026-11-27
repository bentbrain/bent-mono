import { useEffect, useState } from "react";
import { View } from "react-native";
import { formatDate } from "@bent/fitness-contracts/domain";
import type { RecordEntry } from "@bent/fitness-contracts/domain";
import { elapsedSeconds, formatDuration } from "@bent/fitness-contracts/timing";
import { Button } from "../../ui/Button";
import { Badge, Card, EmptyState, Screen } from "../../ui/Layout";
import { AppText } from "../../ui/Text";
import { nameFor } from "../shared/exercise";
import type { DayState } from "./logic";
import { workoutProgress } from "./logic";
import { useWeekNavigation } from "./navigation";

/** The badge tone for a day's state. */
export const stateTone = { done: "done", missed: "missed", planned: "primary", rest: "default" } as const satisfies Record<
  DayState,
  "done" | "missed" | "primary" | "default"
>;

/** A "How to" button that opens the exercise guide sheet. */
export function ExerciseHelp({ id }: { id: string }) {
  const navigation = useWeekNavigation();
  return (
    <Button
      label="How to"
      icon="info.circle"
      tone="tinted"
      size="compact"
      accessibilityLabel={`How to do ${nameFor(id)}`}
      onPress={() => navigation.navigate("ExerciseGuide", { id })}
      testID={`exercise-help-${id}`}
    />
  );
}

/** A thin bar showing a share of the work done. */
function Meter({ fraction }: { fraction: number }) {
  return (
    <View className="h-1.5 overflow-hidden rounded-full bg-card-alt" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View className="h-full rounded-full bg-primary" style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
    </View>
  );
}

/** The unfinished workout, with its elapsed time and a way back into it. */
export function ResumePanel({ record }: { record: RecordEntry }) {
  const navigation = useWeekNavigation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (record.data.kind !== "workout") return null;
  const workout = record.data;
  const { handled, total, fraction } = workoutProgress(workout);
  const elapsed = formatDuration(elapsedSeconds(workout.startedAt, now));
  return (
    <Card testID="resume-panel">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge label="Workout in progress" tone="primary" icon="figure.strengthtraining.traditional" />
        <AppText textRole="footnote" tone="muted">
          {formatDate(workout.date)}
        </AppText>
      </View>
      <AppText textRole="title" weight="bold" accessibilityRole="header">
        {workout.name}
      </AppText>
      <View className="flex-row gap-4">
        <AppText
          textRole="footnote"
          weight="semibold"
          accessibilityRole="timer"
          accessibilityLabel={`Elapsed time ${elapsed}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {elapsed}
        </AppText>
        <AppText textRole="footnote" tone="muted">
          {handled}/{total} sets handled
        </AppText>
      </View>
      <Meter fraction={fraction} />
      <AppText textRole="footnote" tone="secondary">
        Your timers and results are saved. Pick up where you left off.
      </AppText>
      <Button
        label="Resume workout"
        icon="play.fill"
        onPress={() => navigation.navigate("Workout", { workoutId: record.id })}
        testID="resume-workout"
      />
    </Card>
  );
}

/** A plan, workout or run that cannot be opened from its link. */
export function Unavailable({ title }: { title: string }) {
  const navigation = useWeekNavigation();
  return (
    <Screen>
      <EmptyState
        icon="calendar.badge.exclamationmark"
        title={title}
        body="Open your current plan from your week."
        action={<Button label="Back to week" tone="tinted" onPress={() => navigation.popTo("Week")} testID="back-to-week" />}
      />
    </Screen>
  );
}
