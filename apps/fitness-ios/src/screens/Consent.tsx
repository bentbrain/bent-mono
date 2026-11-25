import { useState } from "react";
import type { SyncStatus } from "../../modules/fitness-health";
import { FitnessHealth } from "../../modules/fitness-health";
import { copy, fitnessHost } from "../logic/copy";
import { backfillChoices, cutoffFor } from "../logic/cutoff";
import type { BackfillChoice } from "../logic/cutoff";
import { Body, Button, Choice, Heading, Page, Row } from "../ui/parts";

export function Consent({ status, onChange }: { status: SyncStatus; onChange: () => void }) {
  const [choice, setChoice] = useState<BackfillChoice>("1y");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await FitnessHealth.confirmConsent(cutoffFor(choice, Date.now()));
    } finally {
      setBusy(false);
      onChange();
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await FitnessHealth.declineConsent();
    } finally {
      setBusy(false);
      onChange();
    }
  }

  return (
    <Page title={copy.consent.title} testID="screen-consent">
      <Row label="Account" value={status.email ?? ""} testID="consent-email" />
      <Body>{copy.consent.types}</Body>
      <Body>{copy.consent.destination(fitnessHost(status.origin))}</Body>
      {copy.consent.promise.map((line) => (
        <Body key={line} muted>
          {line}
        </Body>
      ))}
      <Body muted>{copy.consent.disconnect}</Body>
      <Heading>{copy.consent.history}</Heading>
      {backfillChoices.map((option) => (
        <Choice
          key={option.value}
          label={option.label}
          selected={choice === option.value}
          onPress={() => setChoice(option.value)}
          testID={`backfill-${option.value}`}
        />
      ))}
      <Button label={copy.consent.confirm} onPress={confirm} busy={busy} testID="consent-confirm" />
      <Button
        label={copy.consent.decline}
        appearance="outline"
        onPress={decline}
        disabled={busy}
        testID="consent-decline"
      />
    </Page>
  );
}
