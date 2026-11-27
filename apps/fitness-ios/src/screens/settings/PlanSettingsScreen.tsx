import { useState } from "react";
import { View } from "react-native";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { DateField, Segmented } from "../../ui/Form";
import { Card, Screen, SectionTitle } from "../../ui/Layout";
import { AppText } from "../../ui/Text";
import { EditorIntro, NumberInput, SaveBar, useDiscardGuard, useFieldFocus, useSettingsEditor } from "./parts";
import { RotationPreview } from "./RotationPreview";
import { RoutineEditor } from "./RoutineEditor";
import { newRoutine, weekdayNames, weekdays } from "./rules";

type Day = "strength" | "run" | "rest";

/** The repeating week, used by Settings and by Week's Schedule screen. */
export function PlanSettingsScreen() {
  const { sync } = useConfiguredAccount();
  return <PlanEditor key={sync.editorReset} />;
}

function PlanEditor() {
  const editor = useSettingsEditor();
  const { draft, update } = editor;
  const fields = useFieldFocus();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useDiscardGuard(editor.dirty);

  /** Opens the routine that holds the field, then focuses it. */
  function goTo(id: string) {
    const match = /^(?:routine-(\d+)|[a-z]+-(\d+)-\d+)$/.exec(id);
    const index = Number(match?.[1] ?? match?.[2]);
    const routine = Number.isInteger(index) ? draft.routines[index] : undefined;
    if (routine) setExpanded((current) => new Set(current).add(routine.id));
    fields.focus(id);
  }

  return (
    <Screen testID="screen-plan-settings">
      <EditorIntro>
        Strength days take turns through your routines in calendar order, counted from the plan start date. A missed day keeps its routine,
        so the next strength day still moves on to the next routine. To catch up, open the missed day in Your week and choose Do this
        workout today. Changing the start date can change which routine falls on each future day. Recorded workouts keep their results.
      </EditorIntro>

      <Card>
        <DateField label="Plan start date" value={draft.startDate} onChange={(startDate) => update({ startDate })} testID="plan-start-date" />
        <NumberInput
          label="Introduction · weeks at 2 sets"
          value={draft.introductionWeeks}
          integer
          onChange={(weeks) => update({ introductionWeeks: weeks ?? Number.NaN })}
          inputRef={fields.register("introduction")}
          hint="Up to two sets per exercise for these first weeks, from 0 to 8."
          testID="plan-introduction"
        />
      </Card>

      <View className="gap-3">
        <SectionTitle>Days</SectionTitle>
        <Card>
          {weekdays.map((name, i) => (
            <View key={name} className="flex-row items-center gap-3">
              <AppText weight="semibold" className="w-11" accessibilityLabel={weekdayNames[i]}>
                {name}
              </AppText>
              <View className="flex-1">
                <Segmented<Day>
                  label={weekdayNames[i] ?? name}
                  value={draft.schedule[i] ?? "rest"}
                  options={[
                    { value: "strength", label: "Strength" },
                    { value: "run", label: "Easy run" },
                    { value: "rest", label: "Rest" },
                  ]}
                  onChange={(value) => update({ schedule: draft.schedule.map((day, j) => (i === j ? value : day)) })}
                  testID={`day-${i}`}
                />
              </View>
            </View>
          ))}
        </Card>
      </View>

      <RotationPreview draft={draft} />

      <View className="gap-3">
        <SectionTitle>Routines</SectionTitle>
        <AppText textRole="footnote" tone="secondary" className="px-1">
          Changes apply to new workouts. Sessions already started keep their exercise list and targets.
        </AppText>
        {draft.routines.map((routine, ri) => (
          <RoutineEditor
            key={routine.id}
            routine={routine}
            index={ri}
            expanded={expanded.has(routine.id)}
            onToggle={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (!next.delete(routine.id)) next.add(routine.id);
                return next;
              })
            }
            onChange={(next) => update({ routines: draft.routines.map((item, i) => (i === ri ? next : item)) })}
            onRemove={() => update({ routines: draft.routines.filter((_, i) => i !== ri) })}
            register={fields.register}
          />
        ))}
        <Button
          label="Add routine"
          icon="plus"
          tone="secondary"
          onPress={() => {
            const routine = newRoutine(crypto.randomUUID());
            update({ routines: [...draft.routines, routine] });
            setExpanded((current) => new Set(current).add(routine.id));
          }}
          testID="add-routine"
        />
      </View>

      <SaveBar onSave={() => editor.save(draft)} status={editor.status} error={editor.error} syncError={editor.sync.error} onGoTo={goTo} />
    </Screen>
  );
}
