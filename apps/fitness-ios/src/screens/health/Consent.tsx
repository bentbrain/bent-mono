import { useState } from "react";
import { View } from "react-native";
import type { SyncStatus } from "../../../modules/fitness-health";
import { FitnessHealth } from "../../../modules/fitness-health";
import { copy, fitnessHost } from "../../logic/copy";
import { backfillChoices, cutoffFor } from "../../logic/cutoff";
import type { BackfillChoice } from "../../logic/cutoff";
import { Button } from "../../ui/Button";
import { Notice, Screen } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { ValueRow } from "./parts";

export function Consent({ status, onChange }: { status: SyncStatus; onChange: () => void }) {
  const [choice, setChoice] = useState<BackfillChoice>("1y");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  // Consent and decline name the enrollment this screen shows, so they never
  // act on a key for another account that replaced it.
  const enrollmentId = status.enrollmentId ?? "";

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setChanged(false);
    try {
      await action();
    } catch {
      setChanged(true);
    } finally {
      setBusy(false);
      onChange();
    }
  }

  const confirm = () => act(() => FitnessHealth.confirmConsent(cutoffFor(choice, Date.now()), enrollmentId));
  const decline = () => act(() => FitnessHealth.declineConsent(enrollmentId));

  return (
    <Screen testID="screen-consent">
      <View className="gap-2 px-1">
        <AppText textRole="title" weight="bold" accessibilityRole="header">
          {copy.consent.title}
        </AppText>
        <AppText>{copy.consent.types}</AppText>
        <AppText tone="muted">{copy.consent.destination(fitnessHost(status.origin))}</AppText>
      </View>
      {changed ? (
        <Notice tone="warning" testID="consent-changed">
          {copy.consent.changed}
        </Notice>
      ) : null}
      <ListSection>
        <ValueRow label="Account" value={status.email ?? ""} testID="consent-email" />
      </ListSection>
      <ListSection title="When it syncs" footer={copy.consent.disconnect}>
        {copy.consent.promise.map((line) => (
          <ListRow key={line} label={line} />
        ))}
      </ListSection>
      <ListSection title={copy.consent.history}>
        {backfillChoices.map((option) => (
          <ListRow
            key={option.value}
            label={option.label}
            selected={choice === option.value}
            onPress={() => setChoice(option.value)}
            testID={`backfill-${option.value}`}
          />
        ))}
      </ListSection>
      <View className="gap-3">
        <Button label={copy.consent.confirm} onPress={confirm} busy={busy} fullWidth testID="consent-confirm" />
        <Button label={copy.consent.decline} tone="plain" onPress={decline} disabled={busy} testID="consent-decline" />
      </View>
    </Screen>
  );
}
