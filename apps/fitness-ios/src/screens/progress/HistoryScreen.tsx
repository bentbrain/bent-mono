import { useTabNavigation } from "../../navigation/hooks";
import { useHeaderHeight } from "@react-navigation/elements";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, View } from "react-native";
import { formatDate, setResult } from "@bent/fitness-contracts/domain";
import type { Settings } from "@bent/fitness-contracts/domain";
import { useConfiguredAccount } from "../../account/AccountProvider";
import { Button } from "../../ui/Button";
import { Badge, Card, EmptyState, Notice, Screen } from "../../ui/Layout";
import type { ScrollHandle } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { Symbol } from "../../ui/Symbol";
import { AppText } from "../../ui/Text";
import { haptic } from "../../ui/haptics";
import {
  correctionsByWorkout,
  finishedOriginals,
  groupByDate,
  groupFor,
  historySessions,
  removalFor,
  removedWorkouts,
  sessionLabel,
} from "./history";
import type { CorrectionEntry, RunEntry, WorkoutEntry } from "./history";
import { historyNotice } from "./notice";
import { runText } from "../../logic/format";

/** Asks before a change, with a destructive action button. */
function confirm(title: string, message: string, action: string, onConfirm: () => void, destructive = true) {
  haptic("warning");
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: destructive ? "destructive" : "default", onPress: onConfirm },
  ]);
}

function RunCard({ run }: { run: RunEntry }) {
  const navigation = useTabNavigation<"ProgressTab">();
  const { sync } = useConfiguredAccount();
  const label = sessionLabel(run);
  return (
    <Card testID={`history-run-${run.id}`}>
      <View className="flex-row items-center gap-2">
        <Symbol name="figure.run" size={18} tintColorClassName="accent-done" />
        <AppText textRole="headline" weight="semibold" accessibilityRole="header" className="flex-1">
          Easy run
        </AppText>
      </View>
      <AppText tone="secondary">{runText(run.data)}</AppText>
      {run.data.notes ? <AppText textRole="footnote">{run.data.notes}</AppText> : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Edit run"
          tone="secondary"
          size="compact"
          icon="pencil"
          accessibilityLabel={`Edit ${label}`}
          onPress={() =>
            navigation.navigate("WeekTab", { screen: "Run", params: { date: run.data.date, runId: run.id } })
          }
        />
        <Button
          label="Remove run"
          tone="plain"
          size="compact"
          accessibilityLabel={`Remove ${label}`}
          onPress={() =>
            confirm("Remove run?", `Remove the ${label}?`, "Remove", () => {
              if (sync.put(null, run.id, run.revision)) {
                haptic("success");
                historyNotice.set(`Removed the ${label}.`);
              }
            })
          }
        />
      </View>
    </Card>
  );
}

function WorkoutCard({
  workout,
  original,
  correction,
  units,
  open,
  onToggle,
  onRemove,
  onRestore,
}: {
  workout: WorkoutEntry;
  original: WorkoutEntry | undefined;
  correction: CorrectionEntry | undefined;
  units: Settings["units"];
  open: boolean;
  onToggle: () => void;
  onRemove: (original: WorkoutEntry) => void;
  onRestore: (correction: CorrectionEntry, label: string) => void;
}) {
  const navigation = useTabNavigation<"ProgressTab">();
  const label = sessionLabel(workout);
  const data = workout.data;
  return (
    <Card testID={`history-workout-${workout.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${data.name}${correction ? ", corrected" : ""}`}
        accessibilityHint={open ? "Hides the results" : "Shows the results"}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          haptic("selection");
          onToggle();
        }}
        className="flex-row items-center gap-2 active:opacity-70"
      >
        <Symbol name="dumbbell" size={18} tintColorClassName="accent-primary" />
        <AppText textRole="headline" weight="semibold" className="flex-1">
          {data.name}
        </AppText>
        {correction ? <Badge label="Corrected" tone="primary" /> : null}
        <Symbol
          name={open ? "chevron.up" : "chevron.down"}
          size={13}
          weight="semibold"
          tintColorClassName="accent-chevron"
        />
      </Pressable>
      {open ? (
        <>
          {data.exercises.map((exercise, index) => (
            <View key={index} className="gap-0.5">
              <AppText weight="semibold">{exercise.prescription.name}</AppText>
              <AppText textRole="footnote" tone="secondary">
                {exercise.sets.map((set) => setResult(set, exercise.prescription, units)).join(" · ")}
              </AppText>
            </View>
          ))}
          {data.notes ? <AppText textRole="footnote">{data.notes}</AppText> : null}
          {correction ? (
            <AppText textRole="footnote" tone="muted">
              Correction note: {correction.data.reason}
            </AppText>
          ) : null}
          {original ? (
            <View className="flex-row flex-wrap gap-2">
              <Button
                label="Correct results"
                tone="secondary"
                size="compact"
                icon="pencil"
                accessibilityLabel={`Correct ${label}`}
                testID={`history-correct-${workout.id}`}
                onPress={() => {
                  historyNotice.set("");
                  navigation.navigate("HistoryCorrection", { workoutId: workout.id });
                }}
              />
              {correction ? (
                <Button
                  label="Restore original"
                  tone="plain"
                  size="compact"
                  accessibilityLabel={`Restore original results for ${label}`}
                  onPress={() => onRestore(correction, label)}
                />
              ) : null}
              <Button
                label="Remove workout"
                tone="plain"
                size="compact"
                accessibilityLabel={`Remove ${label}`}
                onPress={() => onRemove(original)}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

export function HistoryScreen() {
  const { sync, settings, date, today } = useConfiguredAccount();
  const scroll = useRef<ScrollHandle>(null);
  const scrolledFor = useRef<string | null>(null);
  const headerHeight = useHeaderHeight();
  const notice = useSyncExternalStore(historyNotice.subscribe, historyNotice.get);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => () => historyNotice.set(""), []);

  const corrections = correctionsByWorkout(sync.records);
  const originals = finishedOriginals(sync.records);
  const groups = groupByDate(historySessions(sync.records));
  const removed = removedWorkouts(sync.records);
  // A chosen day other than today, such as from "View results", scrolls into view.
  const target = date === today ? undefined : groupFor(groups, date);

  function remove(workout: WorkoutEntry) {
    const name = `${workout.data.name} on ${formatDate(workout.data.date)}`;
    confirm(
      "Remove workout?",
      `Remove ${name} from History and weight suggestions? You can restore it from Removed workouts.`,
      "Remove",
      () => {
        const change = removalFor(workout, corrections.get(workout.id));
        if (sync.put(change.data, change.id, change.revision)) {
          haptic("success");
          historyNotice.set(`Removed ${name}.`);
        }
      },
    );
  }
  function restore(correction: CorrectionEntry, name: string) {
    confirm(
      "Restore original results?",
      `Restore the original recorded results for ${name}? Your correction will be removed.`,
      "Restore",
      () => {
        if (sync.put(null, correction.id, correction.revision)) {
          haptic("success");
          historyNotice.set(`Restored the original results for ${name}.`);
        }
      },
      false,
    );
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await sync.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen scrollRef={scroll} testID="screen-history" onRefresh={() => void refresh()} refreshing={refreshing}>
      {notice ? (
        <Notice tone="success" testID="history-notice">
          {notice}
        </Notice>
      ) : null}
      {!groups.length ? (
        <EmptyState
          icon="list.bullet.rectangle"
          title="No sessions yet"
          body="Your completed workouts and runs will appear here."
        />
      ) : null}
      {groups.map((group) => (
        <View
          key={group.date}
          className="gap-2"
          onLayout={(event) => {
            if (group.date !== target || scrolledFor.current === date) return;
            scrolledFor.current = date;
            scroll.current?.scrollTo({ y: Math.max(0, event.nativeEvent.layout.y - headerHeight - 8), animated: true });
          }}
        >
          <AppText
            textRole="footnote"
            weight="medium"
            tone="muted"
            accessibilityRole="header"
            className="px-4 uppercase"
          >
            {formatDate(group.date)}
          </AppText>
          {group.sessions.map((session) =>
            session.data.kind === "run" ? (
              <RunCard key={session.id} run={{ ...session, data: session.data }} />
            ) : (
              <WorkoutCard
                key={session.id}
                workout={{ ...session, data: session.data }}
                original={originals.get(session.id)}
                correction={corrections.get(session.id)}
                units={settings.units}
                open={toggled[session.id] ?? session.data.date === date}
                onToggle={() =>
                  setToggled((value) => ({
                    ...value,
                    [session.id]: !(value[session.id] ?? session.data.date === date),
                  }))
                }
                onRemove={remove}
                onRestore={restore}
              />
            ),
          )}
        </View>
      ))}
      {removed.length > 0 ? (
        <ListSection
          title="Removed workouts"
          footer="These workouts are hidden from History, your schedule and weight suggestions. Your account export keeps the original results."
          testID="history-removed"
        >
          {removed.map(({ correction, original }) => {
            const name = `${original.data.name} on ${formatDate(original.data.date)}`;
            return (
              <ListRow
                key={correction.id}
                label={original.data.name}
                description={formatDate(original.data.date)}
                trailing={
                  <Button
                    label="Restore"
                    tone="tinted"
                    size="compact"
                    accessibilityLabel={`Restore ${name}`}
                    onPress={() => restore(correction, name)}
                  />
                }
              />
            );
          })}
        </ListSection>
      ) : null}
    </Screen>
  );
}
