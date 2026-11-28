import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert, View } from "react-native";
import type { TextInputInstance, TextInputProps } from "react-native";
import { settingsId, withNutrient } from "@bent/fitness-contracts/domain";
import type { Nutrient, Settings } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Form";
import { haptic } from "../../ui/haptics";
import { Notice } from "../../ui/Layout";
import { AppText, AppTextInput } from "../../ui/Text";
import { cn } from "../../ui/typography";
import {
  checkSettings,
  numberText,
  parseNumberText,
  queuedNotice,
  saveStatus,
  settingsRevision,
  unsavedNotice,
} from "./rules";

type FieldError = { text: string; id?: string };

/**
 * An edited copy of the settings, saved with the revision it was opened
 * at, as the web Settings editor saves. Screens key this on
 * `sync.editorReset`, so choosing the cloud version reloads it. While
 * nothing is edited, it follows settings saved elsewhere.
 */
export function useSettingsEditor(extraDirty: (saved: Settings) => boolean = () => false) {
  const { sync, settings } = useConfiguredAccount();
  const revision = settingsRevision(sync.records);
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(settings);
  const [originRevision, setOriginRevision] = useState(revision);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<FieldError | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || extraDirty(saved);

  useEffect(() => {
    if (dirty || revision === originRevision) return;
    setDraft(settings);
    setSaved(settings);
    setOriginRevision(revision);
    // Follows a newer saved version only while nothing is edited.
  }, [revision, settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setNotice(unsavedNotice);
  }, []);

  /** Tracks a nutrient with a daily target in grams or none, or stops tracking it with false. */
  const track = useCallback((nutrient: Nutrient, target: number | null | false) => {
    setDraft((current) => withNutrient(current, nutrient, target));
    setNotice(unsavedNotice);
  }, []);

  function fail(text: string, id?: string) {
    haptic("error");
    setError({ text, id });
  }

  /** Validates and queues `candidate`. True once it is queued. */
  function save(candidate: Settings) {
    const checked = checkSettings(candidate);
    if (!checked.data) {
      fail(checked.error.text, checked.error.id);
      return false;
    }
    if (sync.put(checked.data, settingsId, originRevision)) {
      setOriginRevision(originRevision + 1);
      setDraft(checked.data);
      setSaved(checked.data);
      setNotice(queuedNotice);
      setError(null);
      haptic("success");
      return true;
    }
    fail("Settings changed on another device or need attention. Check the sync message below.");
    return false;
  }

  return {
    sync,
    draft,
    saved,
    dirty,
    update,
    track,
    save,
    fail,
    error,
    clearError: () => setError(null),
    markUnsaved: () => setNotice(unsavedNotice),
    status: saveStatus(notice, sync),
  };
}

/** Asks before leaving a screen with unsaved settings. */
export function useDiscardGuard(dirty: boolean) {
  const navigation = useNavigation();
  usePreventRemove(dirty, ({ data }) => {
    haptic("warning");
    Alert.alert("Discard unsaved changes?", "Leave Settings and discard your unsaved changes?", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });
}

/** Text inputs by field ID, so a validation message can move focus to its field. */
export function useFieldFocus() {
  const fields = useRef(new Map<string, TextInputInstance>());
  const register = useCallback(
    (id: string) => (instance: TextInputInstance | null) => {
      if (instance) fields.current.set(id, instance);
      else fields.current.delete(id);
    },
    [],
  );
  /** Focuses the field, after a frame so a just-expanded section has rendered. */
  const focus = useCallback((id: string) => {
    requestAnimationFrame(() => fields.current.get(id)?.focus());
  }, []);
  return { register, focus };
}

/** A labelled text input whose focus the editor can move to. */
export function InputField({
  label,
  hint,
  error,
  inputRef,
  className,
  ...props
}: TextInputProps & {
  label: string;
  hint?: string;
  error?: string | null;
  inputRef?: (instance: TextInputInstance | null) => void;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      <AppTextInput ref={inputRef} accessibilityLabel={label} {...props} />
    </Field>
  );
}

/**
 * A labelled number input. It keeps the typed text, so "62." stays while
 * editing, and reports the number it reads: NaN for text that is not one,
 * and null for an empty optional field.
 */
export function NumberInput({
  label,
  unit,
  hint,
  value,
  onChange,
  optional,
  integer,
  inputRef,
  testID,
  className,
}: {
  label: string;
  unit?: string;
  hint?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  optional?: boolean;
  integer?: boolean;
  inputRef?: (instance: TextInputInstance | null) => void;
  testID?: string;
  className?: string;
}) {
  const [text, setText] = useState(() => numberText(value));
  useEffect(() => {
    const typed = parseNumberText(text, optional);
    const same =
      Object.is(typed, value) ||
      (typeof typed === "number" && typeof value === "number" && Number.isNaN(typed) && Number.isNaN(value));
    if (!same) setText(numberText(value));
    // Only a value changed from outside replaces the typed text.
  }, [value]);
  return (
    <Field label={label} hint={hint} className={className}>
      <View className="flex-row items-center">
        <AppTextInput
          ref={inputRef}
          testID={testID}
          accessibilityLabel={unit ? `${label}, ${unit}` : label}
          value={text}
          onChangeText={(next) => {
            setText(next);
            onChange(parseNumberText(next, optional));
          }}
          keyboardType={integer ? "number-pad" : "decimal-pad"}
          inputMode={integer ? "numeric" : "decimal"}
          selectTextOnFocus
          className={cn("flex-1", unit && "pr-14")}
          style={{ fontVariant: ["tabular-nums"] }}
        />
        {unit ? (
          <AppText tone="muted" className="absolute right-3.5" pointerEvents="none">
            {unit}
          </AppText>
        ) : null}
      </View>
    </Field>
  );
}

/** The Save button, its status line and the first problem to fix. */
export function SaveBar({
  onSave,
  status,
  error,
  syncError,
  onGoTo,
  testID = "save-settings",
}: {
  onSave: () => void;
  status: string;
  error: FieldError | null;
  syncError: string;
  onGoTo: (id: string) => void;
  testID?: string;
}) {
  return (
    <View className="gap-3">
      <Button label="Save settings" icon="checkmark" fullWidth onPress={onSave} testID={testID} />
      {status ? (
        <AppText
          textRole="footnote"
          tone="muted"
          className="text-center"
          accessibilityLiveRegion="polite"
          testID="settings-status"
        >
          {status}
        </AppText>
      ) : null}
      {error ? (
        <Notice
          tone="danger"
          testID="settings-error"
          action={
            error.id && error.id !== "start-date" ? (
              <Button
                label="Go to this setting"
                tone="plain"
                size="compact"
                onPress={() => {
                  const id = error.id;
                  if (id) onGoTo(id);
                }}
                testID="go-to-setting"
              />
            ) : undefined
          }
        >
          {error.text}
        </Notice>
      ) : null}
      {syncError ? <Notice tone="warning">{syncError}</Notice> : null}
    </View>
  );
}

/** A heading and lede at the top of an editor. */
export function EditorIntro({ children }: { children: ReactNode }) {
  return (
    <AppText textRole="footnote" tone="secondary" className="px-1">
      {children}
    </AppText>
  );
}
