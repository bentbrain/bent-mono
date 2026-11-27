import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect } from "react";
import { useConfiguredAccount } from "../../../account/AccountProvider";
import { useTabNavigation } from "../../../navigation/hooks";
import { Button } from "../../../ui/Button";
import { EmptyState, Screen } from "../../../ui/Layout";
import { forgetWorkoutInputs } from "./inputs";
import { draftBackend } from "./useWorkoutInputs";
import { WorkoutEditor } from "./WorkoutEditor";

/** A workout: the logger while it is in progress, a link to History once finished. */
export function WorkoutScreen({ route }: StaticScreenProps<{ workoutId: string }>) {
  const { workoutId } = route.params;
  const { sync, settings, owner, today, setDate } = useConfiguredAccount();
  const navigation = useTabNavigation<"WeekTab">();
  const entry = sync.records.find((record) => record.id === workoutId);
  const finished = entry?.data.kind === "workout" && Boolean(entry.data.finishedAt);
  useEffect(() => {
    // Values typed on this iPhone are no longer needed once a workout is finished.
    if (!finished) return;
    try {
      forgetWorkoutInputs(draftBackend(owner), workoutId);
    } catch {
      /* The values are removed the next time storage is available. */
    }
  }, [finished, owner, workoutId]);

  function backToWeek() {
    navigation.popToTop();
  }
  function openHistory(date: string) {
    setDate(date);
    navigation.navigate("ProgressTab", { screen: "History" });
  }

  if (!entry || entry.data.kind !== "workout")
    return (
      <Screen testID="screen-workout">
        <EmptyState
          icon="calendar.badge.exclamationmark"
          title="Workout unavailable"
          body="Open your current plan from your week."
          action={<Button label="Back to week" tone="tinted" testID="workout-back-to-week" onPress={backToWeek} />}
        />
      </Screen>
    );
  const workout = entry.data;
  if (workout.finishedAt)
    return (
      <Screen testID="screen-workout">
        <EmptyState
          icon="checkmark.seal"
          title="Workout completed"
          body="View your results in History. Check the save status before closing the app."
          action={<Button label="Open history" testID="workout-open-history" onPress={() => openHistory(workout.date)} />}
        />
      </Screen>
    );
  return (
    <Screen testID="screen-workout">
      <WorkoutEditor
        key={entry.id}
        entry={{ ...entry, data: workout }}
        settings={settings}
        sync={sync}
        owner={owner}
        onFinish={() => {
          openHistory(workout.date);
          backToWeek();
        }}
        onDiscard={() => {
          setDate(today);
          backToWeek();
        }}
      />
    </Screen>
  );
}
