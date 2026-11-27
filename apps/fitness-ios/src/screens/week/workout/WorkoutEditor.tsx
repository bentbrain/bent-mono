import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useRef } from "react";
import { Alert, View } from "react-native";
import { formatDate } from "@bent/fitness-contracts/domain";
import type { RecordEntry, Settings, Workout } from "@bent/fitness-contracts/domain";
import { useAccount } from "../../../account/AccountProvider";
import type { Sync } from "../../../account/AccountProvider";
import { Button } from "../../../ui/Button";
import { Notice, SectionTitle } from "../../../ui/Layout";
import { AppText } from "../../../ui/Text";
import { haptic } from "../../../ui/haptics";
import { shape } from "../../../ui/typography";
import { ExerciseList } from "./ExerciseList";
import { InputNotices, NotesField } from "./InputNotices";
import { SessionTimer } from "./SessionTimer";
import { finishChange, sessionProgress } from "./session";
import { useWorkoutInputs } from "./useWorkoutInputs";

/**
 * The logger for a workout in progress: timers, every exercise and set,
 * notes, finishing and discarding. The screen stays awake while it is open.
 */
export function WorkoutEditor({
  entry,
  settings,
  sync,
  owner,
  onFinish,
  onDiscard,
}: {
  entry: RecordEntry & { data: Workout };
  settings: Settings;
  sync: Sync;
  owner: string;
  onFinish: () => void;
  onDiscard: () => void;
}) {
  useKeepAwake("bent-fitness-workout");
  const workout = entry.data;
  // Saves name the revision this editor last showed, plus its own saves
  // since. If another device changed or finished the workout first, the save
  // is refused on this iPhone and the typed values stay for review, rather
  // than queueing an edit Fitness refuses.
  const expected = useRef(entry.revision);
  useEffect(() => {
    expected.current = entry.revision;
  }, [entry.revision]);
  const inputs = useWorkoutInputs({
    workout,
    units: settings.units,
    owner,
    workoutId: entry.id,
    save: (next) => {
      if (!sync.put(next, entry.id, expected.current)) return false;
      expected.current += 1;
      return true;
    },
  });
  // The header's sync status says when typed values wait on this iPhone.
  const { setInputPending } = useAccount();
  useEffect(() => {
    setInputPending(inputs.pending);
    return () => setInputPending(false);
  }, [inputs.pending, setInputPending]);
  const progress = sessionProgress(workout);
  const history = sync.records.filter((record) => record.id !== entry.id);

  function setRest(restUntil: number | null) {
    inputs.commit({ keys: [], change: (current) => ({ ...current, restUntil }), place: "timer" });
  }

  function finish() {
    if (inputs.commit({ change: finishChange(new Date()) })) {
      haptic("success");
      onFinish();
    } else haptic("error");
  }

  function discard() {
    Alert.alert("Discard this workout?", "Discard this unfinished workout and the values typed on this device?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Discard draft",
        style: "destructive",
        onPress: () => {
          if (sync.put(null, entry.id)) {
            inputs.clear();
            onDiscard();
          }
        },
      },
    ]);
  }

  return (
    <View className="gap-6">
      <View className="gap-1.5">
        <AppText textRole="footnote" weight="semibold" tone="muted" className="uppercase">
          In progress · {formatDate(workout.date)}
        </AppText>
        <AppText textRole="largeTitle" weight="bold" accessibilityRole="header">
          {workout.name}
        </AppText>
      </View>


      <SessionTimer workout={workout} error={inputs.message?.place === "timer" ? inputs.message.text : undefined} onRest={setRest} />

      <Notice tone="info">
        Warm up for 5 minutes, then do light practice sets. Keep 2–3 reps in reserve. Weights are for one dumbbell; each side has its own
        reps.
      </Notice>

      <InputNotices inputs={inputs} />

      <ExerciseList workout={workout} settings={settings} inputs={inputs} history={history} startRest />

      <NotesField inputs={inputs} />

      <View className="gap-3">
        {inputs.message?.place === "finish" ? <Notice tone="danger">{inputs.message.text}</Notice> : null}
        <Button
          label="Finish workout"
          icon="flag.checkered"
          fullWidth
          testID="finish-workout"
          disabled={progress.next !== undefined}
          accessibilityHint={progress.next ? "Mark each set Done or Skipped to finish." : undefined}
          onPress={finish}
        />
        <AppText textRole="footnote" tone="muted" className="px-1">
          Mark each set Done or Skipped to finish. Skipped sets do not count towards a weight increase. Results sync when the save status
          says Saved.
        </AppText>
      </View>

      <View className="gap-3 bg-card p-4" style={{ borderRadius: shape.card, borderCurve: "continuous" }}>
        <SectionTitle>Discard this workout</SectionTitle>
        <AppText textRole="footnote" tone="muted">
          This removes the draft. Completed history stays available.
        </AppText>
        <Button label="Discard draft" tone="danger" icon="trash" fullWidth testID="discard-workout" onPress={discard} />
      </View>
    </View>
  );
}
