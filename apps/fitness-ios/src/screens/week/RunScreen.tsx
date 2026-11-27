import { useState } from "react";
import { View } from "react-native";
import type { StaticScreenProps } from "@react-navigation/native";
import { formatDate } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { DateField, NumberField, TextField } from "../../ui/Form";
import { haptic } from "../../ui/haptics";
import { Card, Notice, Screen } from "../../ui/Layout";
import { AppText } from "../../ui/Text";
import { editStatus, isDay, parseRun, runForm, runSummary } from "./logic";
import type { Opened, Run } from "./logic";
import { useWeekNavigation } from "./navigation";
import { Unavailable } from "./parts";

/**
 * Records a completed run, or edits one. Saving checks the run still
 * matches the version the form opened with, so a change made on another
 * device is never overwritten without a choice.
 */
export function RunScreen({ route }: StaticScreenProps<{ date: string; runId?: string }>) {
  const { sync, date: selectedDate, today, setDate } = useConfiguredAccount();
  const navigation = useWeekNavigation();
  const { runId } = route.params;
  const live = sync.records.find((record) => record.id === runId);
  // The run version the form opened with. Saving checks it is still current.
  const [editing, setEditing] = useState<Opened<Run> | undefined>(() =>
    live?.data.kind === "run" ? { id: live.id, revision: live.revision, data: live.data } : undefined,
  );
  const [checked, setChecked] = useState<"changed" | "removed">();
  const run = editing?.data;
  const saved = live?.data.kind === "run" ? live.data : undefined;
  const derived = editStatus(editing, live);
  const status = derived === "current" ? checked : derived;
  const day = run?.date || route.params.date || selectedDate;
  const [values, setValues] = useState(() => runForm(run, day, today));
  const [error, setError] = useState("");

  if (!isDay(day) || (runId && !editing)) return <Unavailable title="Run unavailable" />;

  const update = (field: keyof typeof values) => (text: string) => {
    setValues((current) => ({ ...current, [field]: text }));
    setError("");
  };

  function savedVersion(): Opened<Run> | undefined {
    const current = editing ? sync.latest(editing.id) : undefined;
    return editing && current?.data?.kind === "run"
      ? { id: editing.id, revision: current.revision, data: current.data }
      : undefined;
  }

  function save(target: Opened<Run> | undefined) {
    const result = parseRun(values, today);
    if ("error" in result) {
      haptic("error");
      setError(result.error);
      return;
    }
    if (target) {
      const state = editStatus(target, sync.latest(target.id));
      if (state !== "current") {
        haptic("warning");
        setChecked(state);
        setError("");
        return;
      }
    }
    if (sync.put(result.run, target?.id, target?.revision ?? 0)) {
      haptic("success");
      setDate(result.run.date);
      // Show the saved run in History, and close this form under it.
      navigation.navigate("ProgressTab", { screen: "History", initial: false });
      navigation.goBack();
    } else {
      haptic("error");
      setError(`The run could not be queued. ${sync.error || "Resolve the sync message and try again."}`);
    }
  }

  return (
    <Screen testID="screen-run">
      <View className="gap-1 px-1">
        <AppText textRole="footnote" weight="medium" tone="muted">
          {run ? "Recorded run" : "Run plan"} · {formatDate(day)}
        </AppText>
        <AppText textRole="largeTitle" weight="bold" accessibilityRole="header">
          Easy run
        </AppText>
        <AppText textRole="footnote" tone="secondary">
          Keep a conversational pace. You should be able to talk in sentences.
        </AppText>
      </View>

      <Card testID="run-form">
        <AppText textRole="headline" weight="bold" accessibilityRole="header">
          {run ? "Edit your run" : "Record your completed run"}
        </AppText>
        <DateField label="Date" value={values.date} maximum={today} onChange={update("date")} testID="run-date" />
        <NumberField
          label="Duration"
          unit="min"
          value={values.minutes}
          onChangeText={update("minutes")}
          hint="Up to 1,440 minutes."
          testID="run-minutes"
        />
        <NumberField
          label="Distance"
          unit="km"
          value={values.distance}
          onChangeText={update("distance")}
          hint="Up to 500 km."
          testID="run-distance"
        />
        <TextField
          label="Notes"
          value={values.notes}
          onChangeText={update("notes")}
          maxLength={2000}
          multiline
          className="min-h-24"
          textAlignVertical="top"
          testID="run-notes"
        />
        {status ? (
          <Notice
            tone="warning"
            testID="run-conflict"
            action={
              status === "changed" ? (
                <View className="gap-2">
                  <Button
                    label="Save my changes instead"
                    onPress={() => {
                      const next = savedVersion();
                      if (!next) return;
                      setEditing(next);
                      setChecked(undefined);
                      save(next);
                    }}
                    testID="run-keep-mine"
                  />
                  <Button
                    label="Load saved version"
                    tone="secondary"
                    onPress={() => {
                      const next = savedVersion();
                      setEditing(next);
                      setChecked(undefined);
                      setValues(runForm(next?.data, next?.data.date ?? day, today));
                      setError("");
                    }}
                    testID="run-use-saved"
                  />
                </View>
              ) : (
                <Button label="Save my changes as a new run" onPress={() => save(undefined)} testID="run-save-new" />
              )
            }
          >
            {status === "changed"
              ? `This run changed on another device after you opened it. Saved version: ${saved ? runSummary(saved) : "unknown"}. Your changes are still in the form.`
              : "This run was removed on another device. Your changes are still in the form."}
          </Notice>
        ) : null}
        <Button label={run ? "Save run changes" : "Save run"} disabled={Boolean(status)} onPress={() => save(editing)} testID="save-run" />
        {error ? (
          <Notice tone="danger" testID="run-error">
            {error}
          </Notice>
        ) : null}
      </Card>
    </Screen>
  );
}
