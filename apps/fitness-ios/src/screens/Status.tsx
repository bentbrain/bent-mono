import { useState } from "react";
import { Alert } from "react-native";
import * as Application from "expo-application";
import type { SyncStatus } from "../../modules/fitness-health";
import { FitnessHealth } from "../../modules/fitness-health";
import { copy, countLines, guidance } from "../logic/copy";
import { backfillChoices, cutoffFor } from "../logic/cutoff";
import { formatDay, formatTime } from "../logic/format";
import { Body, Button, Choice, Heading, Notice, Page, Row } from "../ui/parts";

export function Status({ status, onChange }: { status: SyncStatus; onChange: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function syncNow() {
    setSyncing(true);
    try {
      await FitnessHealth.syncNow();
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
    Alert.alert("Disconnect this iPhone?", copy.consent.disconnect, [
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
    <Page title={copy.status.title} testID="screen-status">
      <Row label="Account" value={status.email ?? ""} />
      <Row
        label={copy.status.lastSync}
        value={formatTime(status.lastSyncAt) ?? copy.status.never}
        testID="status-last-sync"
      />
      {status.backfilling ? <Body testID="status-backfill">{copy.status.backfill(status.backfillThrough)}</Body> : null}
      {error ? <Notice testID="status-error">{error}</Notice> : null}
      {paused.map((message) => (
        <Notice key={message}>{message}</Notice>
      ))}
      <Button label={copy.status.syncNow} onPress={syncNow} busy={syncing} testID="sync-now" />

      {(["weight", "run"] as const).map((type) => (
        <TypeCounts key={type} type={type} lines={countLines(status.counts, type)} />
      ))}
      {status.runsWithoutDistance ? <Body muted>{copy.status.withoutDistance(status.runsWithoutDistance)}</Body> : null}
      {status.deferred ? <Body muted testID="status-deferred">{copy.status.waiting(status.deferred)}</Body> : null}
      {status.unreadableRetired ? (
        <Body muted>
          {copy.status.unreadable(status.unreadableRetired)} {copy.settings.resyncHint}
        </Body>
      ) : null}

      <Heading>{copy.settings.title}</Heading>
      <Row label={copy.settings.history} value={`From ${formatDay(status.cutoff) ?? ""}`} testID="settings-cutoff" />
      {backfillChoices.map((option) => {
        const cutoff = cutoffFor(option.value, Date.now());
        return (
          <Choice
            key={option.value}
            label={option.label}
            selected={false}
            onPress={() => changeHistory(cutoff)}
            testID={`settings-backfill-${option.value}`}
          />
        );
      })}
      <Button label={copy.settings.resync} appearance="outline" onPress={resync} disabled={syncing} testID="resync" />
      <Body muted>{copy.settings.resyncHint}</Body>
      {status.pendingRevocations > 0 ? (
        <Body muted testID="pending-revocations">
          {status.pendingRevocations} earlier {status.pendingRevocations === 1 ? "key is" : "keys are"} waiting to be
          revoked. The app retries when it opens.
        </Body>
      ) : null}
      <Button
        label={copy.settings.disconnect}
        appearance="outline"
        onPress={disconnect}
        busy={disconnecting}
        testID="disconnect"
      />
      <Body muted testID="version">
        {copy.settings.version(Application.nativeApplicationVersion ?? "", Application.nativeBuildVersion ?? "")}
      </Body>
    </Page>
  );
}

function TypeCounts({ type, lines }: { type: "weight" | "run"; lines: { label: string; value: number }[] }) {
  return (
    <>
      <Heading>{type === "weight" ? "Weigh-ins" : "Runs"}</Heading>
      {lines.length ? (
        lines.map((line) => (
          <Row key={line.label} label={line.label} value={String(line.value)} testID={`count-${type}-${line.label}`} />
        ))
      ) : (
        <Body muted>None yet</Body>
      )}
    </>
  );
}
