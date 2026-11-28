import { useTabNavigation } from "../../navigation/hooks";
import { Pressable, View } from "react-native";
import { loadWording } from "@bent/fitness-contracts/domain";
import type { Settings, Workout } from "@bent/fitness-contracts/domain";
import { Button, IconButton } from "../../ui/Button";
import { Card } from "../../ui/Layout";
import { Symbol } from "../../ui/Symbol";
import { AppText, AppTextInput } from "../../ui/Text";
import { haptic } from "../../ui/haptics";
import { cn, shape } from "../../ui/typography";
import { prescriptionText } from "../shared/exercise";
import { fieldKey, setKeys } from "./correction-inputs";
import type { InputField } from "./correction-inputs";

type SetEntry = Workout["exercises"][number]["sets"][number];

/** The typed values of a correction and how to change them. */
export type CorrectionInputs = {
  units: Settings["units"];
  errors: Record<string, string>;
  message: { place: string; text: string } | undefined;
  text: (key: string) => string;
  setText: (key: string, text: string) => void;
  /** Saves the set's typed values, as when leaving a set on the web. */
  leaveSet: (exercise: number, set: number) => void;
  /** Marks a set Done, Skipped or Controlled, saving its typed values first. */
  act: (exercise: number, set: number, change: Partial<SetEntry>) => void;
};

function SetInput({
  inputs,
  label,
  caption,
  exercise,
  set,
  field,
  integer,
}: {
  inputs: CorrectionInputs;
  label: string;
  caption: string;
  exercise: number;
  set: number;
  field: InputField;
  integer: boolean;
}) {
  const key = fieldKey(exercise, set, field);
  return (
    <View className="min-w-[72px] flex-1 gap-1">
      <AppText textRole="caption" tone="muted" numberOfLines={1}>
        {caption}
      </AppText>
      <AppTextInput
        accessibilityLabel={label}
        accessibilityHint={inputs.errors[key]}
        value={inputs.text(key)}
        onChangeText={(text) => inputs.setText(key, text)}
        onEndEditing={() => inputs.leaveSet(exercise, set)}
        keyboardType={integer ? "number-pad" : "decimal-pad"}
        inputMode={integer ? "numeric" : "decimal"}
        selectTextOnFocus
        className={cn("min-h-11 px-3 py-2.5", inputs.errors[key] && "border-danger-foreground")}
        style={{ fontVariant: ["tabular-nums"] }}
        testID={`correction-${key.replaceAll(":", "-")}`}
      />
    </View>
  );
}

/** The exercises of a workout being corrected, with every set's results. */
export function CorrectionSets({ workout, inputs }: { workout: Workout; inputs: CorrectionInputs }) {
  const navigation = useTabNavigation<"ProgressTab">();
  const units = inputs.units;
  return workout.exercises.map((exercise, ei) => {
    const p = exercise.prescription;
    const unit = p.mode === "seconds" ? "seconds" : "reps";
    return (
      <Card key={ei} testID={`correction-exercise-${ei}`}>
        <View className="flex-row items-start gap-3">
          <AppText textRole="footnote" weight="bold" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {String(ei + 1).padStart(2, "0")}
          </AppText>
          <View className="flex-1 gap-0.5">
            <AppText textRole="headline" weight="semibold" accessibilityRole="header">
              {p.name}
            </AppText>
            <AppText textRole="footnote" tone="muted">
              {prescriptionText(p)}
            </AppText>
          </View>
          <IconButton
            icon="info.circle"
            tone="plain"
            size={32}
            label={`How to do ${p.name}`}
            onPress={() => navigation.navigate("ExerciseGuide", { id: p.id, prescription: p })}
          />
        </View>
        {exercise.sets.map((set, si) => {
          const name = `${p.name} set ${si + 1}`;
          const problems = setKeys(ei, si).flatMap((key) => (inputs.errors[key] ? [{ key, text: inputs.errors[key] }] : []));
          return (
            <View
              key={si}
              className={cn("gap-3 p-3", set.done ? "bg-done-soft" : "bg-card-alt", set.skipped && "opacity-60")}
              style={{ borderRadius: shape.control, borderCurve: "continuous" }}
              testID={`correction-set-${ei}-${si}`}
            >
              <View className="flex-row items-end gap-2">
                <View className="size-8 items-center justify-center rounded-full bg-card" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <AppText textRole="footnote" weight="bold">
                    {si + 1}
                  </AppText>
                </View>
                {loadWording(p, units).weighed ? (
                  <SetInput
                    inputs={inputs}
                    label={`${name} weight, ${loadWording(p, units).unit}`}
                    caption={loadWording(p, units).heading}
                    exercise={ei}
                    set={si}
                    field="loadKg"
                    integer={false}
                  />
                ) : null}
                <SetInput
                  inputs={inputs}
                  label={`${name} ${p.side ? "left " : ""}${unit}`}
                  caption={p.mode === "seconds" ? (p.side ? "Left seconds" : "Seconds") : p.side ? "Left reps" : "Reps"}
                  exercise={ei}
                  set={si}
                  field="value"
                  integer={p.mode === "reps"}
                />
                {p.side ? (
                  <SetInput
                    inputs={inputs}
                    label={`${name} right ${unit}`}
                    caption={p.mode === "seconds" ? "Right seconds" : "Right reps"}
                    exercise={ei}
                    set={si}
                    field="right"
                    integer={p.mode === "reps"}
                  />
                ) : null}
                {p.mode === "reps" ? (
                  <SetInput
                    inputs={inputs}
                    label={`${name} reps in reserve`}
                    caption="Reps left"
                    exercise={ei}
                    set={si}
                    field="rir"
                    integer
                  />
                ) : null}
              </View>
              <View className="flex-row flex-wrap items-center gap-2">
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${name} controlled`}
                  accessibilityState={{ checked: set.controlled }}
                  onPress={() => {
                    haptic("selection");
                    inputs.act(ei, si, { controlled: !set.controlled });
                  }}
                  className="min-h-9 flex-row items-center gap-1.5 pr-2 active:opacity-70"
                >
                  <Symbol
                    name={set.controlled ? "checkmark.square.fill" : "square"}
                    size={20}
                    tintColorClassName={set.controlled ? "accent-primary" : "accent-icon"}
                  />
                  <AppText textRole="footnote">Controlled</AppText>
                </Pressable>
                <View className="flex-1" />
                <Button
                  label="Done"
                  icon={set.done ? "checkmark" : undefined}
                  tone={set.done ? "primary" : "secondary"}
                  size="compact"
                  accessibilityLabel={`${name} ${set.done ? "completed" : "complete"}`}
                  testID={`correction-done-${ei}-${si}`}
                  onPress={() => inputs.act(ei, si, { done: !set.done, skipped: false })}
                />
                <Button
                  label={set.skipped ? "Skipped" : "Skip"}
                  tone={set.skipped ? "tinted" : "plain"}
                  size="compact"
                  accessibilityLabel={`${name} ${set.skipped ? "skipped" : "skip"}`}
                  testID={`correction-skip-${ei}-${si}`}
                  onPress={() => inputs.act(ei, si, { skipped: !set.skipped, done: false })}
                />
              </View>
              {problems.map((problem) => (
                <AppText key={problem.key} textRole="footnote" tone="danger" accessibilityRole="alert">
                  {problem.text}
                </AppText>
              ))}
              {inputs.message?.place === `${ei}:${si}` ? (
                <AppText textRole="footnote" tone="danger" accessibilityRole="alert">
                  {inputs.message.text}
                </AppText>
              ) : null}
            </View>
          );
        })}
      </Card>
    );
  });
}
