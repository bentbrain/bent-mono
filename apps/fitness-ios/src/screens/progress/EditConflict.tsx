import { View } from "react-native";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/Layout";

/**
 * Explains that another device changed or removed the record being edited.
 * The form keeps the person's typed values until they choose what to save.
 */
export function EditConflict({
  status,
  noun,
  current,
  onKeepMine,
  onUseCurrent,
  onSaveAsNew,
}: {
  status: "changed" | "removed";
  noun: string;
  /** A short description of the saved version. */
  current?: string;
  onKeepMine: () => void;
  onUseCurrent: () => void;
  onSaveAsNew: () => void;
}) {
  return (
    <View accessibilityRole="alert" testID="edit-conflict">
      <Notice
        tone="warning"
        action={
          status === "changed" ? (
            <View className="gap-2">
              <Button label="Save my changes instead" onPress={onKeepMine} fullWidth testID="conflict-keep-mine" />
              <Button
                label="Load saved version"
                tone="secondary"
                onPress={onUseCurrent}
                fullWidth
                testID="conflict-use-saved"
              />
            </View>
          ) : (
            <Button
              label={`Save my changes as a new ${noun}`}
              onPress={onSaveAsNew}
              fullWidth
              testID="conflict-save-new"
            />
          )
        }
      >
        {status === "changed"
          ? `This ${noun} changed on another device after you opened it.${current ? ` Saved version: ${current}.` : ""} Your changes are still in the form.`
          : `This ${noun} was removed on another device. Your changes are still in the form.`}
      </Notice>
    </View>
  );
}
