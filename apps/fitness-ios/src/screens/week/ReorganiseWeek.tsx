import { useState } from "react";
import { Alert, Modal, ScrollView, View } from "react-native";
import { settingsId } from "@bent/fitness-contracts/domain";
import type { Settings } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button, IconButton } from "../../ui/Button";
import { haptic } from "../../ui/haptics";
import { Notice } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import {
  canReorganise,
  canResetWeek,
  chooseSource,
  dayOption,
  firstMove,
  moveDestinations,
  movableDays,
  movePreview,
  moveSources,
  planMove,
  resetWeek,
  saveStatus,
  weekDays,
} from "./logic";
import { useWeekNavigation } from "./navigation";

type Origin = { settings: Settings; revision: number };

/**
 * Moves a planned session within this week, or resets the week to the
 * repeating plan. The sheet keeps the plan it opened with and refuses a move
 * when another device changed the plan in the meantime.
 */
export function ReorganiseWeek({ monday }: { monday: string }) {
  const { sync, settings, today } = useConfiguredAccount();
  const navigation = useWeekNavigation();
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const days = weekDays(monday);
  const movable = movableDays(days, today, sync.records);

  function open() {
    const latest = sync.latest(settingsId);
    if (latest.data?.kind !== "settings") return;
    const opened = { settings: latest.data, revision: latest.revision };
    const move = firstMove(opened.settings, movable);
    setOrigin(opened);
    setFrom(move.from);
    setTo(move.to);
    setError("");
  }

  function close() {
    setOrigin(null);
  }

  function apply() {
    if (!origin) return;
    const result = planMove(origin, sync.latest(settingsId), from, to, today, sync.records);
    if ("error" in result) {
      haptic("error");
      setError(result.error);
      return;
    }
    if (sync.put(result.settings, settingsId, origin.revision)) {
      haptic("success");
      setNotice("Week updated.");
      close();
    } else {
      haptic("error");
      setError(`The change could not be queued. ${sync.error || "Resolve the sync message and try again."}`);
    }
  }

  function reset() {
    Alert.alert(
      "Reset this week?",
      "Reset this week to the repeating schedule? Recorded workouts and runs will stay unchanged.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset week",
          style: "destructive",
          onPress: () => {
            const latest = sync.latest(settingsId);
            if (latest.data?.kind !== "settings") return;
            if (sync.put(resetWeek(latest.data, days), settingsId, latest.revision)) {
              haptic("success");
              setNotice("Week reset.");
            } else {
              haptic("error");
              setNotice("");
              Alert.alert("The week wasn't reset", sync.error || "Resolve the sync message and try again.");
            }
          },
        },
      ],
    );
  }

  const sources = origin ? moveSources(origin.settings, movable) : [];
  const destinations = origin ? moveDestinations(movable, from) : [];
  const preview = origin ? movePreview(origin.settings, from, to) : "";

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Reorganise week"
          icon="arrow.left.arrow.right"
          tone="tinted"
          size="compact"
          disabled={!canReorganise(settings, movable)}
          onPress={open}
          testID="reorganise-week"
        />
        <Button
          label="Reset week to repeating plan"
          icon="arrow.counterclockwise"
          tone="plain"
          size="compact"
          disabled={!canResetWeek(settings, days)}
          onPress={reset}
          testID="reset-week"
        />
      </View>
      {notice ? (
        <Notice tone="success" testID="reorganise-notice">
          {`${notice} Save status: ${saveStatus(sync)}.`}
        </Notice>
      ) : null}
      <Modal
        visible={origin !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        allowSwipeDismissal
        onRequestClose={close}
      >
        <View className="flex-1 bg-screen">
          <View className="flex-row items-center justify-between gap-3 px-4 pb-2 pt-4">
            <AppText textRole="headline" weight="bold" accessibilityRole="header" className="flex-1">
              Move a planned session
            </AppText>
            <IconButton icon="xmark" label="Close reorganisation" tone="secondary" size={32} onPress={close} testID="reorganise-close" />
          </View>
          <ScrollView
            className="flex-1"
            contentContainerClassName="gap-6 px-4 pb-10 pt-2"
            keyboardShouldPersistTaps="handled"
            testID="reorganise-sheet"
          >
            <View className="gap-2 px-1">
              <AppText textRole="footnote" tone="secondary">
                Choose where this session goes. If that day has a session, the two will swap. This changes only this week.
              </AppText>
              <AppText textRole="footnote" tone="muted">
                Past days and recorded or started sessions stay fixed.
              </AppText>
            </View>
            {origin ? (
              <>
                <ListSection title="Session to move">
                  {sources.map((day) => (
                    <ListRow
                      key={day}
                      label={dayOption(origin.settings, day)}
                      selected={day === from}
                      onPress={() => {
                        const next = chooseSource(movable, day, to);
                        setFrom(next.from);
                        setTo(next.to);
                        setError("");
                      }}
                      testID={`move-source-${day}`}
                    />
                  ))}
                </ListSection>
                <ListSection title="Move to">
                  {destinations.map((day) => (
                    <ListRow
                      key={day}
                      label={dayOption(origin.settings, day)}
                      selected={day === to}
                      onPress={() => {
                        setTo(day);
                        setError("");
                      }}
                      testID={`move-destination-${day}`}
                    />
                  ))}
                </ListSection>
              </>
            ) : null}
            {preview ? (
              <AppText textRole="footnote" weight="medium" className="px-1" testID="move-preview">
                {preview}
              </AppText>
            ) : null}
            {error ? (
              <Notice tone="danger" testID="reorganise-error">
                {error}
              </Notice>
            ) : null}
            <Button label="Apply move" disabled={!from || !to || from === to} onPress={apply} testID="apply-move" />
            <Button
              label="Edit the repeating schedule"
              tone="plain"
              icon="calendar"
              onPress={() => {
                close();
                navigation.navigate("Schedule");
              }}
              testID="reorganise-schedule"
            />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
