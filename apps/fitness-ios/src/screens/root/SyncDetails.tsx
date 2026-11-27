import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useAccount } from "../../account/AccountProvider";
import { syncStatus } from "../../navigation/SyncStatusButton";
import { Button } from "../../ui/Button";
import { Card, Notice, Screen } from "../../ui/Layout";
import { ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { ValueRow } from "../health/parts";
import { shareJson } from "../settings/share";

/** JSON in a horizontally scrolling monospace block. */
function JsonBlock({ text, testID }: { text: string; testID?: string }) {
  return (
    <Card className="p-3">
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <AppText textRole="caption" testID={testID} selectable style={{ fontFamily: "Menlo" }}>
          {text}
        </AppText>
      </ScrollView>
    </Card>
  );
}

/**
 * How saving stands: the connection, changes waiting on this iPhone, the
 * last error and, when a record changed on another device, both versions
 * and the choice to keep the cloud version.
 */
export function SyncDetails() {
  const { sync, inputPending } = useAccount();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const status = syncStatus(sync, inputPending);

  async function exportPending() {
    setMessage(null);
    try {
      await shareJson("fitness-pending.json", sync.draftExport(), "Export pending changes");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "The pending changes could not be exported.");
    }
  }

  async function retry() {
    setBusy(true);
    try {
      await sync.retry();
    } finally {
      setBusy(false);
    }
  }

  function useCloud() {
    Alert.alert(
      "Use the cloud version?",
      "This iPhone's changes to this record are discarded. Export them first to keep a copy.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Use cloud version",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await sync.useCloud();
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  function discardRejected() {
    Alert.alert(
      "Discard the refused change?",
      "Fitness refused this change, so it can't be saved. Export the pending changes first to keep a copy.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Discard change", style: "destructive", onPress: () => void sync.discardRejected() },
      ],
    );
  }

  return (
    <Screen testID="screen-sync">
      <ListSection>
        <ValueRow label="Status" value={status.label} testID="sync-details-status" />
        <ValueRow label="Connection" value={sync.online ? "Online" : "Offline"} />
        <ValueRow label="Changes waiting on this iPhone" value={String(sync.pending)} testID="sync-details-pending" />
      </ListSection>
      {sync.online ? null : (
        <Notice tone="warning">Changes stay on this iPhone and save when Fitness can be reached.</Notice>
      )}
      {sync.error ? (
        <Notice tone="danger" testID="sync-details-error">
          {sync.error}
        </Notice>
      ) : null}
      {message ? <Notice tone="danger">{message}</Notice> : null}
      <View className="gap-3">
        {sync.rejected ? (
          <Button
            label="Discard the refused change"
            icon="trash"
            tone="danger"
            onPress={discardRejected}
            fullWidth
            testID="sync-discard-rejected"
          />
        ) : null}
        {sync.conflict ? null : (
          <Button label="Retry connection" icon="arrow.clockwise" onPress={() => void retry()} busy={busy} fullWidth testID="sync-retry" />
        )}
        {sync.unsaved() || sync.conflict ? (
          <Button
            label="Export pending changes"
            icon="square.and.arrow.up"
            tone="secondary"
            onPress={() => void exportPending()}
            fullWidth
            testID="sync-export-pending"
          />
        ) : null}
      </View>
      {sync.conflict ? (
        <View className="gap-4" testID="sync-conflict">
          <View className="gap-1 px-1">
            <AppText textRole="headline" weight="bold" accessibilityRole="header">
              Review the conflict
            </AppText>
            <AppText tone="muted">
              Your iPhone's changes are kept until you choose. Export them first if you want to keep both versions.
            </AppText>
          </View>
          <AppText textRole="footnote" weight="semibold" tone="secondary" className="px-1">
            Cloud version
          </AppText>
          <JsonBlock text={JSON.stringify(sync.conflict.current?.data ?? null, null, 2)} testID="sync-cloud-version" />
          <AppText textRole="footnote" weight="semibold" tone="secondary" className="px-1">
            Changes on this iPhone
          </AppText>
          <JsonBlock text={sync.draftExport()} />
          <Button label="Use cloud version for this record" tone="danger" onPress={useCloud} busy={busy} fullWidth testID="sync-use-cloud" />
          <AppText textRole="footnote" tone="muted" className="px-1">
            To keep parts of your changes, export them, use the cloud version, then enter your changes again.
          </AppText>
        </View>
      ) : null}
    </Screen>
  );
}
