import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import { lastExercise, progression, setResult } from "@bent/fitness-contracts/domain";
import type { RecordEntry, Settings, Workout } from "@bent/fitness-contracts/domain";
import { useTabNavigation } from "../../../navigation/hooks";
import { Button, IconButton } from "../../../ui/Button";
import { Badge } from "../../../ui/Layout";
import { Symbol } from "../../../ui/Symbol";
import { AppText, AppTextInput } from "../../../ui/Text";
import { haptic } from "../../../ui/haptics";
import { cn, shape } from "../../../ui/typography";
import { ExerciseThumb, prescriptionText } from "../../shared/exercise";
import { HoldCountdown } from "./HoldTimer";
import type { HoldTimer } from "./HoldTimer";
import { targetLabel, targetSeconds } from "./hold";
import { fieldKey, setInputs, setKeys } from "./inputs";
import type { SetInput } from "./inputs";
import { applySetChange, currentExercise } from "./session";
import type { SetEntry } from "./session";
import type { WorkoutInputs } from "./useWorkoutInputs";

/**
 * Tracks which set holds the keyboard. A set's typed values save when focus
 * leaves the set: to another set, or when the keyboard closes. Moving between
 * fields of the same set keeps the values typed.
 */
function useSetFocus() {
  const blurred = useRef<{ id: string; leave: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(
    () => () => {
      if (blurred.current) clearTimeout(blurred.current.timer);
    },
    [],
  );
  function settle() {
    const pending = blurred.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    blurred.current = null;
    pending.leave();
  }
  return {
    focus(id: string) {
      const pending = blurred.current;
      if (pending?.id === id) {
        clearTimeout(pending.timer);
        blurred.current = null;
      } else settle();
    },
    blur(id: string, leave: () => void) {
      settle();
      blurred.current = {
        id,
        leave,
        timer: setTimeout(() => {
          blurred.current = null;
          leave();
        }, 150),
      };
    },
  };
}

/**
 * The exercises of a workout: one card per exercise with its sets. With
 * `history`, each card shows the last result and weight advice. With
 * `startRest`, marking a set Done starts the exercise's rest and the first
 * exercise with sets to handle is marked Current. With `hold`, timed sets
 * have a hold timer.
 */
export function ExerciseList({
  workout,
  settings,
  inputs,
  history,
  startRest = false,
  hold,
}: {
  workout: Workout;
  settings: Settings;
  inputs: WorkoutInputs;
  /** Earlier workouts for "Last time" and weight advice. */
  history?: RecordEntry[];
  /** Start the rest timer when a set is marked Done. */
  startRest?: boolean;
  /** The hold timer for timed sets. */
  hold?: HoldTimer;
}) {
  const focus = useSetFocus();
  const current = startRest ? currentExercise(workout) : -1;
  return (
    <View className="gap-4">
      {workout.exercises.map((_, ei) => (
        <ExerciseCard
          key={ei}
          workout={workout}
          exerciseIndex={ei}
          settings={settings}
          inputs={inputs}
          history={history}
          startRest={startRest}
          current={ei === current}
          focus={focus}
          hold={hold}
        />
      ))}
    </View>
  );
}

function ExerciseCard({
  workout,
  exerciseIndex: ei,
  settings,
  inputs,
  history,
  startRest,
  current,
  focus,
  hold,
}: {
  workout: Workout;
  exerciseIndex: number;
  settings: Settings;
  inputs: WorkoutInputs;
  history?: RecordEntry[];
  startRest: boolean;
  current: boolean;
  focus: ReturnType<typeof useSetFocus>;
  hold?: HoldTimer;
}) {
  const navigation = useTabNavigation<"WeekTab">();
  const exercise = workout.exercises[ei];
  if (!exercise) return null;
  const p = exercise.prescription;
  const previous = history ? lastExercise(history, p.id) : undefined;
  const advice = history ? progression(p, previous, settings.dumbbellsKg) : undefined;
  const fields = setInputs(p, settings.units);

  function act(si: number, change: Partial<SetEntry>) {
    return inputs.commit({
      keys: setKeys(ei, si),
      dropInvalid: change.skipped === true,
      place: `${ei}:${si}`,
      change: (value) => applySetChange(value, ei, si, change, { startRest, now: Date.now() }),
    });
  }

  return (
    <View
      testID={`exercise-${ei}`}
      className="overflow-hidden bg-card"
      style={{ borderRadius: shape.card, borderCurve: "continuous" }}
    >
      {current ? <View className="h-1 bg-primary" /> : null}
      <View className="gap-3 p-4">
        <View className="flex-row items-start gap-3">
          <ExerciseThumb id={p.id} width={72} />
          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row flex-wrap items-center gap-2">
              <AppText textRole="headline" weight="bold" accessibilityRole="header" className="shrink">
                <AppText textRole="headline" weight="bold" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
                  {String(ei + 1).padStart(2, "0")}{" "}
                </AppText>
                {p.name}
              </AppText>
              {current ? <Badge label="Current" tone="primary" /> : null}
            </View>
            <AppText textRole="footnote" tone="secondary">
              {prescriptionText(p)}
            </AppText>
          </View>
          <IconButton
            icon="questionmark"
            label={`How to do ${p.name}`}
            size={36}
            testID={`exercise-${ei}-guide`}
            onPress={() => navigation.navigate("ExerciseGuide", { id: p.id })}
          />
        </View>
        {history ? (
          <AppText textRole="footnote" tone="muted">
            Last time:{" "}
            {previous
              ? previous.sets.map((s) => setResult(s, previous.prescription, settings.units)).join(" · ")
              : "Your first recorded session"}
          </AppText>
        ) : null}
        {advice ? (
          <View className="flex-row gap-2 bg-primary-soft px-3 py-2" style={{ borderRadius: shape.control, borderCurve: "continuous" }}>
            <Symbol name="lightbulb" size={15} tintColorClassName="accent-primary" />
            <AppText textRole="footnote" tone="primary" className="flex-1">
              {advice.text}
            </AppText>
          </View>
        ) : null}
        <View className="gap-2.5">
          {exercise.sets.map((set, si) => (
            <SetRow
              key={si}
              name={`${p.name} set ${si + 1}`}
              exerciseIndex={ei}
              setIndex={si}
              set={set}
              fields={fields}
              units={settings.units}
              inputs={inputs}
              focus={focus}
              act={(change) => act(si, change)}
              hold={p.mode === "seconds" ? hold : undefined}
              side={p.side}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function SetRow({
  name,
  exerciseIndex: ei,
  setIndex: si,
  set,
  fields,
  units,
  inputs,
  focus,
  act,
  hold,
  side,
}: {
  name: string;
  exerciseIndex: number;
  setIndex: number;
  set: SetEntry;
  fields: SetInput[];
  units: Settings["units"];
  inputs: WorkoutInputs;
  focus: ReturnType<typeof useSetFocus>;
  act: (change: Partial<SetEntry>) => boolean;
  /** The hold timer, for a timed set. */
  hold?: HoldTimer;
  side: boolean;
}) {
  const id = `${ei}:${si}`;
  const keys = setKeys(ei, si);
  const problems = keys.flatMap((key) => {
    const text = inputs.errors[key];
    return text ? [{ key, text }] : [];
  });
  const unconfirmed = keys.some((key) => inputs.unconfirmed.includes(key));
  const held = inputs.held.some((key) => keys.includes(key));
  const testBase = `set-${ei}-${si}`;
  const holding = hold?.hold?.exerciseIndex === ei && hold.hold.setIndex === si;
  const targets = {
    seconds: targetSeconds(inputs.text(fieldKey(ei, si, "value")), set.value),
    right: side ? targetSeconds(inputs.text(fieldKey(ei, si, "right")), set.right ?? set.value) : null,
  };
  return (
    <View
      testID={testBase}
      className={cn("gap-3 p-3", set.done ? "bg-done-soft" : "bg-card-alt")}
      style={{ borderRadius: shape.control, borderCurve: "continuous" }}
    >
      <View className="flex-row items-center justify-between">
        <AppText textRole="footnote" weight="semibold" tone={set.done ? "done" : set.skipped ? "muted" : "secondary"}>
          Set {si + 1}
        </AppText>
        {set.done ? (
          <Badge label="Done" tone="done" icon="checkmark" />
        ) : set.skipped ? (
          <Badge label="Skipped" icon="forward.end" />
        ) : null}
      </View>
      <View className={cn("flex-row gap-2", set.skipped && "opacity-60")}>
        {fields.map((input) => {
          const key = fieldKey(ei, si, input.field);
          const invalid = Boolean(inputs.errors[key]);
          const flagged = inputs.held.includes(key) || inputs.unconfirmed.includes(key);
          return (
            <View key={input.field} className="min-w-0 flex-1 gap-1">
              <AppText textRole="caption" weight="medium" tone="muted" numberOfLines={1} importantForAccessibility="no">
                {input.heading}
              </AppText>
              <AppTextInput
                testID={`${testBase}-${input.field}`}
                accessibilityLabel={`${name} ${input.spoken}`}
                accessibilityHint={input.field === "loadKg" ? `In ${units} per dumbbell` : undefined}
                value={inputs.text(key)}
                onChangeText={(value) => inputs.setText(key, value)}
                onFocus={() => focus.focus(id)}
                onBlur={() => focus.blur(id, () => inputs.commit({ keys, place: id }))}
                // The running hold owns its seconds until it ends or stops.
                editable={!(holding && (input.field === "value" || input.field === "right"))}
                keyboardType={input.integer ? "number-pad" : "decimal-pad"}
                inputMode={input.integer ? "numeric" : "decimal"}
                selectTextOnFocus
                maxLength={12}
                className={cn(
                  "min-h-12 px-2 text-center text-lg font-semibold",
                  invalid ? "bg-danger-soft" : flagged ? "bg-missed-soft" : undefined,
                )}
                style={{ fontVariant: ["tabular-nums"] }}
              />
            </View>
          );
        })}
      </View>
      {hold && holding ? <HoldCountdown timer={hold} testID={`${testBase}-hold`} /> : null}
      {hold && !holding && !set.done && !set.skipped ? (
        <Button
          label={`Start hold · ${targetLabel(targets.seconds)}${side ? " each side" : ""}`}
          tone="tinted"
          icon="timer"
          fullWidth
          disabled={hold.hold !== null}
          accessibilityHint={hold.hold ? "Another hold is running." : "Counts down 5 seconds to get into position, then the hold."}
          testID={`${testBase}-start-hold`}
          onPress={() => hold.start(ei, si, targets)}
        />
      ) : null}
      <View className="flex-row items-center gap-2">
        <Pressable
          testID={`${testBase}-controlled`}
          accessibilityRole="checkbox"
          accessibilityLabel={`${name} controlled`}
          accessibilityState={{ checked: set.controlled }}
          onPress={() => {
            haptic("selection");
            act({ controlled: !set.controlled });
          }}
          hitSlop={4}
          className={cn(
            "min-h-11 flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70",
            set.controlled ? "bg-primary-soft" : "bg-card",
          )}
        >
          <Symbol
            name={set.controlled ? "checkmark.square.fill" : "square"}
            size={18}
            tintColorClassName={set.controlled ? "accent-primary" : "accent-icon"}
          />
          <AppText textRole="footnote" weight="medium" tone={set.controlled ? "primary" : "secondary"}>
            Controlled
          </AppText>
        </Pressable>
        <View className="flex-1">
          <SetAction
            testID={`${testBase}-done`}
            label="Done"
            icon={set.done ? "checkmark.circle.fill" : "checkmark.circle"}
            accessibilityLabel={`${name} ${set.done ? "completed" : "complete"}`}
            selected={set.done}
            tone="done"
            onPress={() => {
              if (act({ done: !set.done, skipped: false })) haptic(set.done ? "light" : "success");
              else haptic("error");
            }}
          />
        </View>
        <SetAction
          testID={`${testBase}-skip`}
          label={set.skipped ? "Skipped" : "Skip"}
          icon="forward.end"
          accessibilityLabel={`${name} ${set.skipped ? "skipped" : "skip"}`}
          selected={set.skipped}
          tone="skip"
          onPress={() => {
            if (act({ skipped: !set.skipped, done: false })) haptic("light");
            else haptic("error");
          }}
        />
      </View>
      {problems.map((problem) => (
        <AppText key={problem.key} textRole="footnote" tone="danger" accessibilityRole="alert">
          {problem.text}
        </AppText>
      ))}
      {unconfirmed ? (
        <AppText textRole="footnote" tone="missed">
          Check this weight is in {units}, then leave the set to save it.
        </AppText>
      ) : held ? (
        <AppText textRole="footnote" tone="missed">
          Saved on another device since you typed here.
        </AppText>
      ) : null}
      {inputs.message?.place === id ? (
        <AppText textRole="footnote" tone="danger" accessibilityRole="alert">
          {inputs.message.text}
        </AppText>
      ) : null}
    </View>
  );
}

/** A large toggle for a set: Done or Skip. */
function SetAction({
  label,
  icon,
  accessibilityLabel,
  selected,
  tone,
  onPress,
  testID,
}: {
  label: string;
  icon: "checkmark.circle" | "checkmark.circle.fill" | "forward.end";
  accessibilityLabel: string;
  selected: boolean;
  tone: "done" | "skip";
  onPress: () => void;
  testID: string;
}) {
  const surface = selected ? (tone === "done" ? "bg-done" : "bg-card-alt border border-border-strong") : "bg-card border border-border";
  const tint = selected ? (tone === "done" ? "accent-primary-foreground" : "accent-foreground") : tone === "done" ? "accent-done" : "accent-icon";
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onPress}
      hitSlop={4}
      className={cn("min-h-11 flex-row items-center justify-center gap-1.5 rounded-full px-4 active:opacity-70", surface)}
    >
      <Symbol name={icon} size={17} weight="semibold" tintColorClassName={tint} />
      <AppText
        textRole="footnote"
        weight="semibold"
        tone={selected ? (tone === "done" ? "inverse" : "default") : tone === "done" ? "done" : "secondary"}
      >
        {label}
      </AppText>
    </Pressable>
  );
}
