import { useState } from "react";
import { View } from "react-native";
import type { ReadableHistory, SyncStatus } from "../../../modules/fitness-health";
import { FitnessHealth } from "../../../modules/fitness-health";
import { copy } from "../../logic/copy";
import { formatDay } from "../../logic/format";
import { Button } from "../../ui/Button";
import { Notice, Screen } from "../../ui/Layout";
import { ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { ValueRow } from "./parts";

export function HealthAccess({ status, onStarted }: { status: SyncStatus; onStarted: (next: SyncStatus) => void }) {
  const [history, setHistory] = useState<ReadableHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function allow() {
    setBusy(true);
    setFailed(null);
    try {
      await FitnessHealth.requestHealthAccess();
      setHistory(await FitnessHealth.readableHistory());
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "Health access could not be requested.");
    } finally {
      setBusy(false);
    }
  }

  // Starting is stored natively, so a relaunch never skips this step and
  // the first sync never begins before it.
  async function start() {
    const next = await FitnessHealth.startFirstSync();
    onStarted(next);
  }

  const readable = history && (history.weight || history.run);
  return (
    <Screen testID="screen-health">
      <View className="gap-2 px-1">
        <AppText textRole="title" weight="bold" accessibilityRole="header">
          {copy.health.title}
        </AppText>
        <AppText>{copy.health.body}</AppText>
      </View>
      {status.healthAvailable ? null : <Notice tone="warning">Health data is unavailable on this device.</Notice>}
      {failed ? (
        <Notice tone="danger" testID="health-failed">
          {failed}
        </Notice>
      ) : null}
      <Button label={copy.health.allow} icon="heart.fill" onPress={allow} busy={busy} fullWidth testID="health-allow" />
      {history ? (
        <>
          <ListSection title={copy.health.readable}>
            <ValueRow
              label="Weigh-ins from"
              value={formatDay(history.weight) ?? copy.health.none}
              testID="readable-weight"
            />
            <ValueRow label="Runs from" value={formatDay(history.run) ?? copy.health.none} testID="readable-run" />
            {history.weightAllowedFrom ? (
              <ValueRow
                label={`${copy.health.allowedFrom} (weigh-ins)`}
                value={formatDay(history.weightAllowedFrom) ?? ""}
                testID="allowed-weight"
              />
            ) : null}
            {history.runAllowedFrom ? (
              <ValueRow
                label={`${copy.health.allowedFrom} (runs)`}
                value={formatDay(history.runAllowedFrom) ?? ""}
                testID="allowed-run"
              />
            ) : null}
          </ListSection>
          {readable ? null : (
            <Notice tone="warning" testID="readable-none">
              {copy.health.noneHint}
            </Notice>
          )}
          <AppText textRole="footnote" tone="muted" className="px-1">
            {copy.health.keepOpen}
          </AppText>
          <Button label={copy.health.start} onPress={start} fullWidth testID="health-start" />
        </>
      ) : null}
    </Screen>
  );
}
