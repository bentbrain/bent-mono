import { View } from "react-native";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  displayLoad,
  effectivePrescription,
  formatDate,
  lastExercise,
  loadNote,
  loadWording,
  progression,
  sessionMinutes,
  setResult,
} from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { Card, Notice, Screen } from "../../ui/Layout";
import { ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { ExerciseThumb, prescriptionText } from "../shared/exercise";
import { planAction, planRoutine, recordedWorkout } from "./logic";
import { useWeekNavigation } from "./navigation";
import { ExerciseHelp, Unavailable } from "./parts";
import { useStartWorkout } from "./useStartWorkout";

/** A routine's plan for a day: each exercise with last time's results and the suggested load. */
export function PlanScreen({ route }: StaticScreenProps<{ date: string; routineId?: string }>) {
  const { sync, settings, date: selectedDate, today, setDate } = useConfiguredAccount();
  const navigation = useWeekNavigation();
  const { start, starting, active } = useStartWorkout();
  const date = route.params.date || selectedDate;
  const plan = planRoutine(settings, date, route.params.routineId);
  if (!plan) return <Unavailable title="Plan unavailable" />;
  const { routine, intro } = plan;
  const { workoutDate, label, note } = planAction(settings, routine, date, today, intro);
  const recorded = recordedWorkout(sync.records, date, routine.id);

  return (
    <Screen testID="screen-plan">
      <View className="gap-1 px-1">
        <AppText textRole="footnote" weight="medium" tone="muted">
          Workout plan · {formatDate(date)}
          {date === today ? " · Today" : date > today ? " · Planned" : ""}
        </AppText>
        <AppText textRole="largeTitle" weight="bold" accessibilityRole="header">
          {routine.name}
        </AppText>
        <AppText textRole="footnote" tone="secondary">
          About {sessionMinutes(routine, intro)} min · {routine.exercises.length} exercises ·{" "}
          {intro ? "Introduction · up to 2 sets each" : "Full session"}
        </AppText>
      </View>

      <Notice>
        Warm up for 5 minutes, then do light practice sets. Keep 2–3 reps in reserve.{" "}
        {loadNote(routine.exercises, settings.units)}
      </Notice>
      {recorded ? (
        <Notice
          tone="success"
          action={
            <Button
              label="View results"
              tone="secondary"
              size="compact"
              onPress={() => {
                setDate(date);
                navigation.navigate("ProgressTab", { screen: "History", initial: false });
              }}
              testID="plan-view-results"
            />
          }
        >
          You recorded {routine.name} for {formatDate(date)}.
        </Notice>
      ) : null}

      <Card testID="plan-actions">
        {active ? (
          <>
            <AppText textRole="footnote" tone="secondary">
              You have a workout in progress. Resume it when you are ready to train.
            </AppText>
            <Button
              label="Resume workout"
              icon="play.fill"
              onPress={() => navigation.navigate("Workout", { workoutId: active.id })}
              testID="plan-resume-workout"
            />
          </>
        ) : (
          <>
            <Button
              label={starting ? "Opening workout…" : label}
              icon="play.fill"
              busy={starting}
              onPress={() => start(routine, workoutDate)}
              testID="plan-start-workout"
            />
            {date < today ? (
              <Button
                label="Do this workout today"
                tone="secondary"
                disabled={starting}
                onPress={() => start(routine, today)}
                testID="plan-start-today"
              />
            ) : null}
            <AppText textRole="footnote" tone="muted">
              {note}
            </AppText>
          </>
        )}
      </Card>

      <ListSection title="Exercises" testID="plan-exercises">
        {routine.exercises.map((prescription, index) => {
          const exercise = effectivePrescription(prescription, intro);
          const previous = lastExercise(sync.records, exercise.id);
          const advice = progression(exercise, previous, settings);
          const last = previous
            ? previous.sets.map((set) => setResult(set, previous.prescription, settings.units)).join(" · ")
            : "Your first recorded session";
          const wording = loadWording(exercise, settings.units);
          const load =
            wording.weighed && advice.loadKg !== null
              ? ` Suggested load: ${displayLoad(advice.loadKg, settings.units)} ${wording.unit}.`
              : "";
          return (
            <View key={`${exercise.id}:${index}`} className="gap-3 px-4 py-3.5" testID={`plan-exercise-${index}`}>
              <View className="flex-row items-start gap-3">
                <ExerciseThumb id={exercise.id} width={88} />
                <View className="min-w-0 flex-1 gap-1">
                  <AppText textRole="body" weight="semibold" accessibilityRole="header">
                    <AppText textRole="body" weight="bold" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
                      {String(index + 1).padStart(2, "0")}
                    </AppText>{" "}
                    {exercise.name}
                  </AppText>
                  <AppText textRole="footnote" tone="secondary">
                    {prescriptionText(exercise)}
                  </AppText>
                </View>
              </View>
              <View className="gap-1">
                <AppText textRole="footnote" tone="muted">
                  Last time: {last}
                </AppText>
                <AppText textRole="footnote" weight="medium">
                  {advice.text}
                  {load}
                </AppText>
              </View>
              <View className="flex-row">
                <ExerciseHelp id={exercise.id} prescription={exercise} />
              </View>
            </View>
          );
        })}
      </ListSection>
    </Screen>
  );
}
