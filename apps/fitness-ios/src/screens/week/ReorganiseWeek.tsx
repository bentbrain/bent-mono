import { useState } from "react";
import { Alert, Modal, ScrollView, View } from "react-native";
import { HStack, Host, Image, List, Section, Spacer, Text as SwiftText } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityHint,
  accessibilityLabel,
  environment,
  font,
  foregroundStyle,
  frame,
  listRowBackground,
  listStyle,
  moveDisabled,
  scrollContentBackground,
} from "@expo/ui/swift-ui/modifiers";
import { useCSSVariable } from "uniwind";
import { formatDate, formatShortDate, settingsId } from "@bent/fitness-contracts/domain";
import type { Settings } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button, IconButton } from "../../ui/Button";
import { haptic } from "../../ui/haptics";
import { Notice } from "../../ui/Layout";
import { AppText } from "../../ui/Text";
import {
  canReorganise,
  canResetWeek,
  movableDays,
  planWeek,
  reorderPreview,
  reorderWeek,
  resetWeek,
  weekDays,
  weekSlots,
} from "@bent/fitness-contracts/week";
import type { WeekSlot } from "@bent/fitness-contracts/week";
import { saveStatus } from "./logic";
import { useWeekNavigation } from "./navigation";

type Origin = { settings: Settings; revision: number };

/** A colour token for SwiftUI, which takes plain colour values. */
function useColour(name: string) {
  const value = useCSSVariable(name);
  return typeof value === "string" ? value : undefined;
}

/** A foreground colour modifier, left out until the token resolves. */
function tinted(colour: string | undefined) {
  return colour ? [foregroundStyle(colour)] : [];
}

/**
 * Rearranges this week's planned sessions by dragging them between days, or
 * resets the week to the repeating plan. The sheet keeps the plan it opened
 * with, saves the new arrangement in one change, and refuses it when another
 * device changed the plan in the meantime.
 */
export function ReorganiseWeek({ monday }: { monday: string }) {
  const { sync, settings, today } = useConfiguredAccount();
  const navigation = useWeekNavigation();
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const days = weekDays(monday);
  const movable = movableDays(days, today, sync.records);

  function open() {
    const latest = sync.latest(settingsId);
    if (latest.data?.kind !== "settings") return;
    setOrigin({ settings: latest.data, revision: latest.revision });
    setOrder(days);
    setError("");
  }

  function close() {
    setOrigin(null);
  }

  function move(slots: WeekSlot[], sources: number[], destination: number) {
    const next = reorderWeek(
      slots.map((slot) => slot.source),
      slots.map((slot) => slot.locked),
      sources,
      destination,
    );
    haptic("selection");
    setOrder(next);
    setError("");
  }

  function save() {
    if (!origin) return;
    const result = planWeek(origin, sync.latest(settingsId), days, order, today, sync.records);
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

  const preview = origin ? reorderPreview(origin.settings, days, order) : "";

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
        <View className="flex-1 bg-screen" testID="reorganise-sheet">
          <View className="flex-row items-center justify-between gap-3 px-4 pb-2 pt-4">
            <AppText textRole="headline" weight="bold" accessibilityRole="header" className="flex-1">
              Reorganise week
            </AppText>
            <IconButton icon="xmark" label="Close reorganisation" tone="secondary" size={32} onPress={close} testID="reorganise-close" />
          </View>
          {origin ? (
            <WeekOrder
              slots={weekSlots(origin.settings, days, order, today, sync.records)}
              title={`${formatShortDate(days[0] ?? monday)} – ${formatShortDate(days[6] ?? monday)}`}
              onMove={move}
            />
          ) : (
            <View className="flex-1" />
          )}
          {/* The actions take at most 45% of the sheet and scroll, so the list keeps room at large text sizes. */}
          <ScrollView style={{ flexGrow: 0, maxHeight: "45%" }} contentContainerClassName="gap-3 px-4 pb-8 pt-3">
            {error ? (
              <Notice tone="danger" testID="reorganise-error">
                {error}
              </Notice>
            ) : null}
            <AppText textRole="footnote" weight="medium" className="px-1" testID="move-preview">
              {preview || "No changes yet."}
            </AppText>
            <Button label="Save week" disabled={!preview} onPress={save} testID="reorganise-save" />
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

/**
 * The week as a native list in edit mode. Open days show a drag handle;
 * past days and days with a recorded or started session show a lock and
 * stay where they are.
 */
function WeekOrder({
  slots,
  title,
  onMove,
}: {
  slots: WeekSlot[];
  title: string;
  onMove: (slots: WeekSlot[], sources: number[], destination: number) => void;
}) {
  const row = useColour("--color-grouped-card");
  const text = useColour("--color-foreground");
  const muted = useColour("--color-foreground-muted");
  const icon = useColour("--color-icon");
  return (
    <Host style={{ flex: 1 }} testID="reorganise-list">
      <List modifiers={[listStyle("insetGrouped"), scrollContentBackground("hidden"), environment("editMode", "active")]}>
        <Section
          title={title}
          footer={
            <SwiftText modifiers={[font({ textStyle: "footnote" }), ...tinted(muted)]}>
              {
                "Drag a session by its handle to another day. The sessions in between shift to make room. Past days and recorded or started sessions stay fixed. This changes only this week."
              }
            </SwiftText>
          }
        >
          <List.ForEach data={slots} keyExtractor={(slot) => slot.source} recycling={false} onMove={(sources, destination) => onMove(slots, sources, destination)}>
            {({ item }) => (
              <HStack
                spacing={12}
                modifiers={[
                  moveDisabled(item.locked),
                  ...(row ? [listRowBackground(row)] : []),
                  accessibilityElement("combine"),
                  accessibilityLabel(`${formatDate(item.day)}: ${item.session}${item.locked ? ", fixed" : ""}`),
                  accessibilityHint(item.locked ? "This day stays as it is." : "Drag to move this session to another day."),
                ]}
              >
                <SwiftText
                  modifiers={[
                    font({ textStyle: "subheadline", weight: "semibold" }),
                    frame({ minWidth: 60, alignment: "leading" }),
                    ...tinted(muted),
                  ]}
                >
                  {formatShortDate(item.day).split(" ").slice(0, 2).join(" ")}
                </SwiftText>
                <SwiftText modifiers={[font({ textStyle: "body" }), ...tinted(item.locked ? muted : text)]}>
                  {item.session}
                </SwiftText>
                <Spacer />
                {item.locked ? <Image systemName="lock.fill" size={13} color={icon} /> : null}
              </HStack>
            )}
          </List.ForEach>
        </Section>
      </List>
    </Host>
  );
}
