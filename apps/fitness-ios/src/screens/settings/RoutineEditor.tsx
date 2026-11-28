import { ActionSheetIOS, Alert, Pressable, Switch, View } from "react-native";
import type { TextInputInstance } from "react-native";
import { useCSSVariable } from "uniwind";
import type { Exercise, Routine } from "@bent/fitness-contracts/domain";
import { Button, IconButton } from "../../ui/Button";
import { Segmented } from "../../ui/Form";
import { haptic } from "../../ui/haptics";
import { Card } from "../../ui/Layout";
import { Symbol } from "../../ui/Symbol";
import { AppText } from "../../ui/Text";
import { shape } from "../../ui/typography";
import { ExerciseThumb, prescriptionText } from "../shared/exercise";
import { InputField, NumberInput } from "./parts";
import { addExercise, exerciseChoices, move } from "./rules";

type Register = (id: string) => (instance: TextInputInstance | null) => void;

/** One routine: its name, exercises and their prescriptions. Collapsed, it shows a summary. */
export function RoutineEditor({
  routine,
  index,
  expanded,
  onToggle,
  onChange,
  onRemove,
  register,
}: {
  routine: Routine;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: Routine) => void;
  onRemove: () => void;
  register: Register;
}) {
  const ri = index;
  const summary = `${routine.name} · ${routine.exercises.length} exercises`;

  function chooseExercise() {
    const choices = exerciseChoices(routine);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Add an exercise",
        options: [...choices.map((choice) => choice.label), "Cancel"],
        cancelButtonIndex: choices.length,
        disabledButtonIndices: choices.flatMap((choice, i) => (choice.included ? [i] : [])),
      },
      (selected) => {
        const choice = choices[selected];
        if (!choice || choice.included) return;
        haptic("light");
        onChange(addExercise(routine, choice.id));
      },
    );
  }

  return (
    <Card className="gap-0 p-0" testID={`routine-${ri}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityHint={expanded ? "Collapses this routine" : "Shows this routine's exercises to edit"}
        accessibilityState={{ expanded }}
        onPress={() => {
          haptic("selection");
          onToggle();
        }}
        className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-card-alt"
        style={{ borderRadius: shape.card, borderCurve: "continuous" }}
        testID={`routine-toggle-${ri}`}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <AppText weight="semibold" numberOfLines={1}>
            {routine.name || `Routine ${ri + 1}`}
          </AppText>
          <AppText textRole="footnote" tone="muted">
            {routine.exercises.length} exercises
          </AppText>
        </View>
        <Symbol
          name={expanded ? "chevron.up" : "chevron.down"}
          size={13}
          weight="semibold"
          tintColorClassName="accent-chevron"
        />
      </Pressable>
      {expanded ? (
        <View className="gap-4 px-4 pb-4">
          <InputField
            label="Routine name"
            value={routine.name}
            onChangeText={(name) => onChange({ ...routine, name })}
            maxLength={160}
            inputRef={register(`routine-${ri}`)}
            testID={`routine-name-${ri}`}
          />
          {routine.exercises.map((exercise, ei) => (
            <ExerciseEditor
              key={`${exercise.id}:${ei}`}
              exercise={exercise}
              position={ei}
              count={routine.exercises.length}
              routineIndex={ri}
              register={register}
              onChange={(patch) =>
                onChange({
                  ...routine,
                  exercises: routine.exercises.map((item, j) => (j === ei ? { ...item, ...patch } : item)),
                })
              }
              onMove={(direction) => onChange({ ...routine, exercises: move(routine.exercises, ei, direction) })}
              onRemove={() =>
                Alert.alert("Remove exercise?", `Remove ${exercise.name} from this routine?`, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => onChange({ ...routine, exercises: routine.exercises.filter((_, i) => i !== ei) }),
                  },
                ])
              }
            />
          ))}
          <Button
            label="Add an exercise"
            icon="plus"
            tone="tinted"
            onPress={chooseExercise}
            testID={`add-exercise-${ri}`}
          />
          <Button
            label="Remove routine"
            icon="trash"
            tone="danger"
            onPress={() =>
              Alert.alert(
                "Remove routine?",
                `Remove ${routine.name}? Recorded workouts keep their original exercises.`,
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Remove", style: "destructive", onPress: onRemove },
                ],
              )
            }
            testID={`remove-routine-${ri}`}
          />
        </View>
      ) : null}
    </Card>
  );
}

function ExerciseEditor({
  exercise,
  position,
  count,
  routineIndex,
  register,
  onChange,
  onMove,
  onRemove,
}: {
  exercise: Exercise;
  position: number;
  count: number;
  routineIndex: number;
  register: Register;
  onChange: (patch: Partial<Exercise>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const track = useCSSVariable("--color-primary");
  const key = `${routineIndex}-${position}`;
  return (
    <View
      className="gap-3 border border-border bg-card-alt p-3"
      style={{ borderRadius: shape.control, borderCurve: "continuous" }}
      testID={`exercise-${key}`}
    >
      <View className="flex-row items-center gap-3">
        <ExerciseThumb id={exercise.id} width={64} />
        <View className="min-w-0 flex-1 gap-0.5">
          <AppText weight="semibold" accessibilityRole="header">
            {position + 1}. {exercise.name}
          </AppText>
          <AppText textRole="caption" tone="muted">
            {Number.isFinite(exercise.sets) &&
            Number.isFinite(exercise.min) &&
            Number.isFinite(exercise.max) &&
            Number.isFinite(exercise.rest)
              ? prescriptionText(exercise)
              : "Enter the sets, range and rest"}
          </AppText>
        </View>
        <IconButton
          icon="chevron.up"
          label={`Move ${exercise.name} up`}
          size={34}
          disabled={position === 0}
          onPress={() => onMove(-1)}
        />
        <IconButton
          icon="chevron.down"
          label={`Move ${exercise.name} down`}
          size={34}
          disabled={position === count - 1}
          onPress={() => onMove(1)}
        />
      </View>
      <View className="flex-row gap-3">
        <NumberInput
          label="Sets"
          value={exercise.sets}
          integer
          onChange={(sets) => onChange({ sets: sets ?? Number.NaN })}
          inputRef={register(`sets-${key}`)}
          className="flex-1"
          testID={`sets-${key}`}
        />
        <NumberInput
          label="Rest · seconds"
          value={exercise.rest}
          integer
          onChange={(rest) => onChange({ rest: rest ?? Number.NaN })}
          inputRef={register(`rest-${key}`)}
          className="flex-1"
          testID={`rest-${key}`}
        />
      </View>
      <View className="flex-row gap-3">
        <NumberInput
          label="Minimum"
          value={exercise.min}
          onChange={(min) => onChange({ min: min ?? Number.NaN })}
          inputRef={register(`min-${key}`)}
          className="flex-1"
          testID={`min-${key}`}
        />
        <NumberInput
          label="Maximum"
          value={exercise.max}
          onChange={(max) => onChange({ max: max ?? Number.NaN })}
          inputRef={register(`max-${key}`)}
          className="flex-1"
          testID={`max-${key}`}
        />
      </View>
      <View className="gap-1.5">
        <AppText textRole="footnote" weight="medium" tone="secondary">
          Measure
        </AppText>
        <Segmented
          label={`Measure ${exercise.name}`}
          value={exercise.mode}
          options={[
            { value: "reps", label: "Reps" },
            { value: "seconds", label: "Seconds" },
          ]}
          onChange={(mode) => onChange({ mode })}
          testID={`mode-${key}`}
        />
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <AppText>Log both sides</AppText>
        <Switch
          accessibilityLabel={`Log both sides for ${exercise.name}`}
          value={exercise.side}
          onValueChange={(side) => {
            haptic("selection");
            onChange({ side });
          }}
          trackColor={{ true: typeof track === "string" ? track : undefined, false: undefined }}
          testID={`side-${key}`}
        />
      </View>
      <Button
        label="Remove exercise"
        tone="plain"
        size="compact"
        icon="minus.circle"
        onPress={onRemove}
        accessibilityLabel={`Remove ${exercise.name}`}
      />
    </View>
  );
}
