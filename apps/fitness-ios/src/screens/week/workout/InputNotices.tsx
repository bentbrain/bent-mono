import { useEffect, useState } from "react";
import { View } from "react-native";
import { Field } from "../../../ui/Form";
import { Notice } from "../../../ui/Layout";
import { AppText, AppTextInput } from "../../../ui/Text";
import { cn } from "../../../ui/typography";
import type { WorkoutInputs } from "./useWorkoutInputs";

/** How typed values save, and warnings about values that need a check. */
export function InputNotices({ inputs }: { inputs: WorkoutInputs }) {
  return (
    <View className="gap-3">
      {/* Always shown, so saving a field never moves the controls below. */}
      <AppText textRole="footnote" tone="muted" className="px-1">
        Typed values stay on this device until you leave the set, press Done or Skip, or leave this screen. Then they save to your
        account.
      </AppText>
      {inputs.held.some((key) => !inputs.unconfirmed.includes(key)) ? (
        <View accessibilityRole="alert">
          <Notice tone="warning" testID="notice-input-held">
            A highlighted value changed on another device. Your typed value is still here. Leave the field to save it, or retype the
            saved value.
          </Notice>
        </View>
      ) : null}
      {inputs.unconfirmed.length > 0 ? (
        <View accessibilityRole="alert">
          <Notice tone="warning" testID="notice-input-unconfirmed">
            A weight typed on this device is waiting for you to check it. Confirm it is in {inputs.units}, then leave the set to save
            it.
          </Notice>
        </View>
      ) : null}
      <StorageNotice message={inputs.storageError} />
    </View>
  );
}

/**
 * Says when typed values could not be kept on this iPhone. After recovery
 * the warning keeps its space, so a save that runs when a field loses focus
 * cannot move a set button while it is being pressed.
 */
function StorageNotice({ message }: { message: string }) {
  const [previous, setPrevious] = useState(message);
  useEffect(() => {
    if (message) setPrevious(message);
  }, [message]);
  const text = message || previous;
  if (!text) return null;
  return (
    <View
      style={{ opacity: message ? 1 : 0 }}
      accessibilityElementsHidden={!message}
      importantForAccessibility={message ? "auto" : "no-hide-descendants"}
      pointerEvents={message ? "auto" : "none"}
    >
      <Notice tone="danger" testID="notice-input-storage">
        {text}
      </Notice>
    </View>
  );
}

/** Session notes. They save when the field loses focus. */
export function NotesField({ inputs }: { inputs: WorkoutInputs }) {
  const held = inputs.held.includes("notes");
  const error = inputs.message?.place === "notes" ? inputs.message.text : null;
  return (
    <Field label="Session notes" error={error}>
      <AppTextInput
        testID="workout-notes"
        accessibilityLabel="Session notes"
        accessibilityHint={held ? "Saved on another device since you typed here." : undefined}
        multiline
        maxLength={2000}
        value={inputs.text("notes")}
        onChangeText={(value) => inputs.setText("notes", value)}
        onBlur={() => inputs.commit({ keys: ["notes"], place: "notes" })}
        textAlignVertical="top"
        className={cn("min-h-28", held && "bg-missed-soft")}
      />
    </Field>
  );
}
