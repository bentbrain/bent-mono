import { usePreventRemove } from "@react-navigation/native";
import { useTabNavigation } from "../../navigation/hooks";
import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { correctionReplacement, formatDate } from "@bent/fitness-contracts/domain";
import type { Workout } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { DateField, Field, TextField } from "../../ui/Form";
import { Card, EmptyState, Notice, Screen } from "../../ui/Layout";
import { AppText, AppTextInput } from "../../ui/Text";
import { haptic } from "../../ui/haptics";
import { CorrectionSets } from "./CorrectionSets";
import type { CorrectionInputs } from "./CorrectionSets";
import { EditConflict } from "./EditConflict";
import { changeSet, commitTyped, fieldText, setKeys, without } from "./correction-inputs";
import type { Typed } from "./correction-inputs";
import { correctionStatus, correctionText, correctionsByWorkout, finishedOriginals, openCorrection, otherCorrection } from "./history";
import type { CorrectionEntry, OpenedCorrection, WorkoutEntry } from "./history";
import { historyNotice } from "./notice";

type Params = { workoutId: string };

const newId = () => crypto.randomUUID();

/** Corrects the results of a finished workout. The original stays in the account export. */
export function CorrectionScreen({ route }: StaticScreenProps<Params>) {
  const navigation = useTabNavigation<"ProgressTab">();
  const { sync } = useConfiguredAccount();
  const original = finishedOriginals(sync.records).get(route.params.workoutId);
  // The correction is read once, when the editor opens.
  const [correction] = useState(() => correctionsByWorkout(sync.records).get(route.params.workoutId));
  if (!original)
    return (
      <Screen testID="screen-correction">
        <EmptyState
          icon="clock.arrow.circlepath"
          title="This workout is not in your history"
          body="It may have been deleted on another device."
          action={<Button label="Back to History" tone="tinted" onPress={() => navigation.goBack()} />}
        />
      </Screen>
    );
  return <CorrectionEditor key={original.id} original={original} correction={correction} />;
}

function CorrectionEditor({ original, correction }: { original: WorkoutEntry; correction: CorrectionEntry | undefined }) {
  const navigation = useTabNavigation<"ProgressTab">();
  const { sync, settings, today } = useConfiguredAccount();
  const units = settings.units;
  // Saving checks the correction still matches the version this editor opened.
  const [opened, setOpened] = useState(() => openCorrection(original, correction, newId));
  const [draft, setDraft] = useState<Workout>(opened.workout);
  const latest = useRef(draft);
  const [typed, setTyped] = useState<Typed>({});
  const typedRef = useRef(typed);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ place: string; text: string }>();
  const [reason, setReason] = useState(opened.reason);
  const [date, setDate] = useState(opened.workout.date);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<"changed" | "removed">();
  const [closing, setClosing] = useState(false);

  const label = `${original.data.name} on ${formatDate(original.data.date)}`;
  useLayoutEffect(() => navigation.setOptions({ title: `Correct ${original.data.name}` }), [navigation, original.data.name]);

  function writeTyped(next: Typed) {
    typedRef.current = next;
    setTyped(next);
  }
  function writeDraft(next: Workout) {
    latest.current = next;
    setDraft(next);
  }
  /** Applies typed values to the draft. False when a value needs fixing. */
  function commit(options: Parameters<typeof commitTyped>[2] & { place?: string } = {}) {
    const result = commitTyped(latest.current, typedRef.current, options);
    if (result.status === "invalid") {
      setErrors((value) => ({ ...value, ...result.errors }));
      haptic("error");
      return false;
    }
    if (result.status === "problem") {
      setMessage({ place: options.place ?? "finish", text: result.message });
      haptic("error");
      return false;
    }
    writeDraft(result.workout);
    setMessage(undefined);
    setErrors((value) => without(value, result.done));
    if (result.done.length) writeTyped(without(typedRef.current, result.done));
    return true;
  }
  function clearTyped() {
    writeTyped({});
    setErrors({});
  }
  const inputs: CorrectionInputs = {
    units,
    errors,
    message,
    text: (key) => fieldText(draft, typed, key, units),
    setText: (key, text) => {
      writeTyped({ ...typedRef.current, [key]: { text, units } });
      setErrors((value) => without(value, [key]));
    },
    leaveSet: (ei, si) => void commit({ keys: setKeys(ei, si), place: `${ei}:${si}` }),
    act: (ei, si, change) =>
      void commit({
        keys: setKeys(ei, si),
        dropInvalid: change.skipped === true,
        place: `${ei}:${si}`,
        change: (current) => changeSet(current, ei, si, change),
      }),
  };

  const live = sync.records.find((record) => record.id === opened.version.id);
  const liveOther = otherCorrection(sync.records, original.id, opened.version.id);
  const derived = correctionStatus(opened.version, { revision: live?.revision ?? 0, data: live?.data ?? null }, liveOther);
  const status = derived === "current" ? checked : derived;
  const saved = liveOther?.data ?? (live?.data.kind === "workoutCorrection" ? live.data : undefined);
  const dirty =
    !closing &&
    (Object.keys(typed).length > 0 ||
      reason !== opened.reason ||
      date !== opened.workout.date ||
      JSON.stringify(draft) !== JSON.stringify(opened.workout));

  usePreventRemove(dirty, ({ data }) => {
    haptic("warning");
    Alert.alert("Leave without saving this correction?", undefined, [
      { text: "Keep editing", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  // Runs after the prevent-remove hook has seen `closing`.
  useEffect(() => {
    if (closing) navigation.goBack();
  }, [closing, navigation]);

  function close(notice: string) {
    historyNotice.set(notice);
    setClosing(true);
  }

  /** The newest saved correction for this workout, including other devices. */
  function savedVersion(): OpenedCorrection | undefined {
    const other = otherCorrection(sync.records, original.id, opened.version.id);
    if (other) return { id: other.id, revision: other.revision, data: other.data };
    const current = sync.latest(opened.version.id);
    return current.data?.kind === "workoutCorrection"
      ? { id: opened.version.id, revision: current.revision, data: current.data }
      : undefined;
  }

  function save(target: OpenedCorrection) {
    if (!reason.trim()) {
      setError("Enter a short reason for the correction.");
      haptic("error");
      return;
    }
    if (!date || date > today) {
      setError("Choose today or an earlier date.");
      haptic("error");
      return;
    }
    if (!commit({ change: (workout) => ({ ...workout, date }) })) return;
    const result = correctionReplacement(original.data, latest.current, date);
    if ("problem" in result) {
      setError(result.problem);
      haptic("error");
      return;
    }
    const state = correctionStatus(target, sync.latest(target.id), otherCorrection(sync.records, original.id, target.id));
    if (state !== "current") {
      setChecked(state);
      setError("");
      haptic("warning");
      return;
    }
    if (
      sync.put(
        { kind: "workoutCorrection", workoutId: original.id, replacement: result.replacement, reason: reason.trim() },
        target.id,
        target.revision,
      )
    ) {
      haptic("success");
      close(`Saved corrected results for ${label}.`);
    } else {
      haptic("error");
      setError("This correction could not be saved. Check the message above, then cancel and open the workout again.");
    }
  }

  /** Replaces the typed values with the saved correction. */
  function loadSaved() {
    const next = savedVersion();
    if (!next?.data) return;
    if (!next.data.replacement) {
      clearTyped();
      close(`${label} was removed from History on another device. Restore it from Removed workouts to correct it.`);
      return;
    }
    const version = openCorrection(original, { ...next, data: next.data }, newId);
    setOpened(version);
    clearTyped();
    writeDraft(version.workout);
    setReason(version.reason);
    setDate(version.workout.date);
    setChecked(undefined);
    setError("");
  }

  function cancel() {
    if (!dirty) {
      close("");
      return;
    }
    haptic("warning");
    Alert.alert("Discard the changes to this correction?", undefined, [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          clearTyped();
          close("");
        },
      },
    ]);
  }

  return (
    <Screen testID="screen-correction">
      <View className="gap-2 px-1">
        <AppText textRole="footnote" weight="medium" tone="muted" className="uppercase">
          Correct results · {formatDate(original.data.date)}
        </AppText>
        <AppText tone="secondary">
          Your corrected results replace the originals in History, your schedule and future weight suggestions. Your
          account export keeps the original results, and you can restore them at any time.
        </AppText>
      </View>

      <Card>
        <DateField label="Workout date" value={date} maximum={today} onChange={setDate} testID="correction-date" />
        <TextField
          label="Reason for correction"
          value={reason}
          maxLength={160}
          placeholder="For example, entered the wrong weight"
          onChangeText={setReason}
          testID="correction-reason"
        />
      </Card>

      <AppText textRole="footnote" tone="muted" className="px-1">
        Typed values apply when you leave a field or press Done or Skip. Nothing saves to your account until you save
        the correction.
      </AppText>

      <CorrectionSets workout={draft} inputs={inputs} />

      <Field label="Session notes" error={message?.place === "notes" ? message.text : null}>
        <AppTextInput
          accessibilityLabel="Session notes"
          value={inputs.text("notes")}
          onChangeText={(text) => inputs.setText("notes", text)}
          onEndEditing={() => void commit({ keys: ["notes"], place: "notes" })}
          maxLength={2000}
          multiline
          textAlignVertical="top"
          className="min-h-24"
          testID="correction-notes"
        />
      </Field>

      {message?.place === "finish" ? <Notice tone="danger">{message.text}</Notice> : null}
      {status ? (
        <EditConflict
          status={status}
          noun="correction"
          current={correctionText(saved)}
          onKeepMine={() => {
            const next = savedVersion();
            if (!next) return;
            setOpened((value) => ({ ...value, version: next }));
            setChecked(undefined);
            save(next);
          }}
          onUseCurrent={loadSaved}
          onSaveAsNew={() => save({ id: newId(), revision: 0, data: null })}
        />
      ) : null}
      {error ? (
        <Notice tone="danger" testID="correction-error">
          {error}
        </Notice>
      ) : null}

      <View className="gap-2">
        <Button
          label="Save correction"
          icon="checkmark"
          disabled={Boolean(status)}
          onPress={() => save(opened.version)}
          fullWidth
          testID="correction-save"
        />
        <Button label="Cancel" tone="plain" onPress={cancel} fullWidth testID="correction-cancel" />
      </View>
    </Screen>
  );
}
