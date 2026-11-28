import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { haptic } from "../../ui/haptics";
import { Card, Screen, SectionTitle } from "../../ui/Layout";
import { AppText } from "../../ui/Text";
import { InputField, SaveBar, useDiscardGuard, useFieldFocus, useSettingsEditor } from "./parts";
import { PhotoLibrary } from "./PhotoLibrary";
import { formatDumbbells, newEquipment, parseDumbbells } from "./rules";
import { planningProfile } from "@bent/fitness-contracts/proposal";

export function EquipmentScreen() {
  const { sync } = useConfiguredAccount();
  return <EquipmentEditor key={sync.editorReset} />;
}

/** Dumbbell sizes, the equipment list with notes, and private equipment photos. */
function EquipmentEditor() {
  const { settings } = useConfiguredAccount();
  const [dumbbellText, setDumbbellText] = useState(() => formatDumbbells(settings.dumbbellsKg, settings.units));
  const [dumbbellError, setDumbbellError] = useState("");
  const editor = useSettingsEditor((saved) => dumbbellText !== formatDumbbells(saved.dumbbellsKg, saved.units));
  const { draft, update, saved } = editor;
  const fields = useFieldFocus();
  useDiscardGuard(editor.dirty);

  // A save or a newer saved version shows its sizes as Fitness keeps them.
  useEffect(() => {
    setDumbbellText(formatDumbbells(saved.dumbbellsKg, saved.units));
  }, [saved]);

  function save() {
    const dumbbells = parseDumbbells(dumbbellText, draft.units);
    if (!dumbbells.values) {
      setDumbbellError(dumbbells.error);
      editor.fail(dumbbells.error, "dumbbells");
      return;
    }
    setDumbbellError("");
    editor.save({ ...draft, dumbbellsKg: dumbbells.values });
  }

  return (
    <Screen testID="screen-equipment">
      <View className="gap-3">
        <SectionTitle>Planning profile</SectionTitle>
        {planningProfile(draft).length > 0 ? (
          <Card testID="planning-profile">
            {planningProfile(draft).map((row) => (
              <View key={row.label} className="gap-0.5 py-1">
                <AppText textRole="footnote" tone="secondary">
                  {row.label}
                </AppText>
                <AppText textRole="body">{row.value}</AppText>
              </View>
            ))}
          </Card>
        ) : null}
        <AppText textRole="footnote" tone="secondary" className="px-1">
          {planningProfile(draft).length > 0
            ? "Your assistant keeps this up to date when it plans your training with you."
            : "Your assistant fills this in when it plans your training with you."}
        </AppText>
        <SectionTitle>Your equipment</SectionTitle>
        <AppText textRole="footnote" tone="secondary" className="px-1">
          Add only the sizes you have checked. A dumbbell weight in a workout is for one dumbbell.
        </AppText>
        <Card>
          <InputField
            label={`Dumbbell sizes · ${draft.units}, comma separated`}
            value={dumbbellText}
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
            placeholder="5, 7.5, 10"
            error={dumbbellError || null}
            onChangeText={(text) => {
              setDumbbellText(text);
              setDumbbellError("");
              editor.markUnsaved();
            }}
            inputRef={fields.register("dumbbells")}
            testID="equipment-dumbbells"
          />
        </Card>
        {draft.equipment.map((item, i) => (
          <Card key={item.id} testID={`equipment-${i}`}>
            <InputField
              label="Equipment"
              value={item.name}
              maxLength={160}
              onChangeText={(name) =>
                update({ equipment: draft.equipment.map((v, j) => (j === i ? { ...v, name } : v)) })
              }
              inputRef={fields.register(`equipment-${i}`)}
              testID={`equipment-name-${i}`}
            />
            <InputField
              label="Notes and confirmed sizes"
              value={item.notes}
              maxLength={500}
              multiline
              onChangeText={(notes) =>
                update({ equipment: draft.equipment.map((v, j) => (j === i ? { ...v, notes } : v)) })
              }
              testID={`equipment-notes-${i}`}
            />
            <Button
              label="Remove equipment"
              tone="plain"
              size="compact"
              icon="minus.circle"
              accessibilityLabel={`Remove ${item.name}`}
              onPress={() =>
                Alert.alert("Remove equipment?", `Remove ${item.name} from your equipment?`, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => update({ equipment: draft.equipment.filter((_, j) => i !== j) }),
                  },
                ])
              }
            />
          </Card>
        ))}
        <Button
          label="Add equipment"
          icon="plus"
          tone="secondary"
          onPress={() => {
            haptic("light");
            update({ equipment: [...draft.equipment, newEquipment(crypto.randomUUID())] });
          }}
          testID="add-equipment"
        />
      </View>

      <SaveBar
        onSave={save}
        status={editor.status}
        error={editor.error}
        syncError={editor.sync.error}
        onGoTo={fields.focus}
      />

      <PhotoLibrary />
    </Screen>
  );
}
