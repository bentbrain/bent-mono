import { useState } from "react";
import type { ReadableHistory, SyncStatus } from "../../modules/fitness-health";
import { FitnessHealth } from "../../modules/fitness-health";
import { copy } from "../logic/copy";
import { formatDay } from "../logic/format";
import { Body, Button, Heading, Notice, Page, Row } from "../ui/parts";

export function Health({ status, onStarted }: { status: SyncStatus; onStarted: () => void }) {
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

  async function start() {
    onStarted();
    await FitnessHealth.syncNow();
  }

  const readable = history && (history.weight || history.run);
  return (
    <Page title={copy.health.title} testID="screen-health">
      <Body>{copy.health.body}</Body>
      {status.healthAvailable ? null : <Notice>Health data is unavailable on this device.</Notice>}
      {failed ? <Notice>{failed}</Notice> : null}
      <Button label={copy.health.allow} onPress={allow} busy={busy} testID="health-allow" />
      {history ? (
        <>
          <Heading>{copy.health.readable}</Heading>
          <Row label="Weigh-ins from" value={formatDay(history.weight) ?? copy.health.none} testID="readable-weight" />
          <Row label="Runs from" value={formatDay(history.run) ?? copy.health.none} testID="readable-run" />
          {readable ? null : <Notice testID="readable-none">{copy.health.noneHint}</Notice>}
          <Body muted>{copy.health.keepOpen}</Body>
          <Button label={copy.health.start} onPress={start} testID="health-start" />
        </>
      ) : null}
    </Page>
  );
}
