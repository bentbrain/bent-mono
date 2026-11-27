import { useState } from "react";
import { Alert, View } from "react-native";
import type { SyncStatus } from "../../../modules/fitness-health";
import { FitnessHealth } from "../../../modules/fitness-health";
import { copy, countLines, guidance } from "../../logic/copy";
import { backfillChoices, cutoffFor } from "../../logic/cutoff";
import { formatDay, formatTime } from "../../logic/format";
import { Button } from "../../ui/Button";
import { Notice, Screen } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { ManualRevocations } from "./ManualRevocations";
import { ValueRow } from "./parts";

export function Status({ status, onChange }: { status: SyncStatus; onChange: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [waitingChanged, setWaitingChanged] = useState(false);
  // The runs the button names; the choice covers exactly these.
  const waitingRuns = status.distanceWaitingRuns ?? [];

  async function syncNow() {
    setSyncing(true);
    try {
      await FitnessHealth.syncNow();
    } finally {
      setSyncing(false);
      onChange();
    }
  }

  async function sendWithoutDistance() {
    setSyncing(true);
    try {
      const next = await FitnessHealth.sendRunsWithoutDistance(waitingRuns, status.enrollmentId ?? "");
      setWaitingChanged(next.approval === "changed");
    } finally {
      setSyncing(false);
      onChange();
    }
  }

  async function changeHistory(cutoff: number) {
    await FitnessHealth.setCutoff(cutoff);
    onChange();
    await syncNow();
  }

  async function resync() {
    await FitnessHealth.resyncFromEarliest();
    onChange();
    await syncNow();
  }

  function disconnect() {
    Alert.alert("Disconnect Apple Health?", copy.consent.disconnect, [
      { text: "Cancel", style: "cancel" },
      {
        text: copy.settings.disconnect,
        style: "destructive",
        onPress: async () => {
          setDisconnecting(true);
          try {
            await FitnessHealth.disconnect();
          } finally {
            setDisconnecting(false);
            onChange();
          }
        },
      },
    ]);
  }

  const error = guidance(status.lastError);
  const paused = Object.values(status.paused ?? {});
  return (
    <Screen testID="screen-status">
      <ListSection>
        <ValueRow label="Account" value={status.email ?? ""} />
        <ValueRow
          label={copy.status.lastSync}
          value={formatTime(status.lastSyncAt) ?? copy.status.never}
          exact={status.lastSyncAt ? String(status.lastSyncAt) : "never"}
          testID="status-last-sync"
        />
      </ListSection>
      {status.backfilling ? (
        <Notice testID="status-backfill">{copy.status.backfill(status.backfillThrough)}</Notice>
      ) : null}
      {error ? (
        <Notice tone="warning" testID="status-error">
          {error}
        </Notice>
      ) : null}
      {paused.map((message) => (
        <Notice key={message} tone="warning">
          {message}
        </Notice>
      ))}
      <Button label={copy.status.syncNow} icon="arrow.triangle.2.circlepath" onPress={syncNow} busy={syncing} fullWidth testID="sync-now" />

      {(["weight", "run"] as const).map((type) => (
        <TypeCounts key={type} type={type} lines={countLines(status.counts, type)} />
      ))}
      {status.runsWithoutDistance ? (
        <AppText textRole="footnote" tone="muted" className="px-1">
          {copy.status.withoutDistance(status.runsWithoutDistance)}
        </AppText>
      ) : null}
      {status.deferred ? (
        <AppText textRole="footnote" tone="muted" className="px-1" testID="status-deferred">
          {copy.status.waiting(status.deferred)}
        </AppText>
      ) : null}
      {waitingRuns.length ? (
        <View className="gap-3">
          <Notice tone="warning" testID="status-distance-access">
            {copy.status.distanceAccess(waitingRuns.length)}
          </Notice>
          {waitingChanged ? (
            <Notice tone="warning" testID="status-waiting-changed">
              {copy.status.waitingChanged}
            </Notice>
          ) : null}
          <Button
            label={copy.status.sendWithoutDistance(waitingRuns.length)}
            tone="secondary"
            onPress={sendWithoutDistance}
            disabled={syncing}
            testID="send-without-distance"
          />
        </View>
      ) : null}
      <ManualRevocations status={status} onChange={onChange} />
      {status.unreadableRetired ? (
        <AppText textRole="footnote" tone="muted" className="px-1">
          {copy.status.unreadable(status.unreadableRetired)} {copy.settings.resyncHint}
        </AppText>
      ) : null}

      <ListSection title={copy.settings.history} footer={copy.settings.resyncHint}>
        <ValueRow label="Sending from" value={formatDay(status.cutoff) ?? ""} testID="settings-cutoff" />
        {backfillChoices.map((option) => {
          const cutoff = cutoffFor(option.value, Date.now());
          return (
            <ListRow
              key={option.value}
              label={option.label}
              onPress={() => void changeHistory(cutoff)}
              testID={`settings-backfill-${option.value}`}
            />
          );
        })}
        <ListRow label={copy.settings.resync} tone="primary" onPress={() => void resync()} disabled={syncing} testID="resync" />
      </ListSection>
      {status.pendingRevocations > 0 ? (
        <AppText textRole="footnote" tone="muted" className="px-1" testID="pending-revocations">
          {status.pendingRevocations} earlier {status.pendingRevocations === 1 ? "key is" : "keys are"} waiting to be
          revoked. The app retries when it opens.
        </AppText>
      ) : null}
      <ListSection>
        <ListRow label={copy.settings.disconnect} tone="danger" onPress={disconnect} disabled={disconnecting} testID="disconnect" />
      </ListSection>
    </Screen>
  );
}

function TypeCounts({ type, lines }: { type: "weight" | "run"; lines: { label: string; value: number }[] }) {
  return (
    <ListSection title={type === "weight" ? "Weigh-ins" : "Runs"}>
      {lines.length ? (
        lines.map((line) => (
          <ValueRow key={line.label} label={line.label} value={String(line.value)} testID={`count-${type}-${line.label}`} />
        ))
      ) : (
        <ValueRow label="None yet" value="" />
      )}
    </ListSection>
  );
}
