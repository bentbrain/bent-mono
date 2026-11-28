import type { StaticScreenProps } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useConfiguredAccount } from "../../../account/AccountProvider";
import { useTabNavigation } from "../../../navigation/hooks";
import { Button } from "../../../ui/Button";
import { EmptyState, Notice, Screen } from "../../../ui/Layout";
import { shareJson } from "../../settings/share";
import { WorkoutInputStore, forgetWorkoutInputs } from "./inputs";
import { draftBackend } from "./useWorkoutInputs";
import { WorkoutEditor } from "./WorkoutEditor";

/** A workout: the logger while it is in progress, a link to History once finished. */
export function WorkoutScreen({ route }: StaticScreenProps<{ workoutId: string }>) {
  const { workoutId } = route.params;
  const { sync, settings, owner, today, setDate } = useConfiguredAccount();
  const navigation = useTabNavigation<"WeekTab">();
  const entry = sync.records.find((record) => record.id === workoutId);
  // Values typed here but not saved, for example when another device
  // finished the workout first. They stay until exported or discarded.
  const finished = entry?.data.kind === "workout" && Boolean(entry.data.finishedAt);
  const [discarded, setDiscarded] = useState(false);
  const leftover = useMemo(() => {
    if (!finished || discarded) return {};
    try {
      return new WorkoutInputStore(draftBackend(owner), workoutId).buffer;
    } catch {
      return {};
    }
  }, [finished, discarded, owner, workoutId]);
  const [exportError, setExportError] = useState("");

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
          action={
            <Button label="Open history" testID="workout-open-history" onPress={() => openHistory(workout.date)} />
          }
        />
        {Object.keys(leftover).length ? (
          <Notice
            tone="warning"
            testID="workout-leftover"
            action={
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label="Export typed values"
                  tone="secondary"
                  size="compact"
                  testID="workout-leftover-export"
                  onPress={() =>
                    void shareJson(
                      "fitness-typed-values.json",
                      JSON.stringify({ format: "fitness-typed-values-v1", workoutId, typed: leftover }, null, 2),
                      "Export typed values",
                    ).catch((e: unknown) =>
                      setExportError(e instanceof Error ? e.message : "The values could not be exported."),
                    )
                  }
                />
                <Button
                  label="Discard them"
                  tone="danger"
                  size="compact"
                  testID="workout-leftover-discard"
                  onPress={() => {
                    try {
                      forgetWorkoutInputs(draftBackend(owner), workoutId);
                      setDiscarded(true);
                    } catch {
                      setExportError("The typed values could not be removed. Try again.");
                    }
                  }}
                />
              </View>
            }
          >
            {exportError ||
              "Values typed on this iPhone were not saved, because this workout was finished first. Export them to keep a copy, or discard them."}
          </Notice>
        ) : null}
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
