import { useState } from "react";
import { View } from "react-native";
import type { SyncStatus } from "../../../modules/fitness-health";
import { FitnessHealth } from "../../../modules/fitness-health";
import { session } from "../../account/AccountProvider";
import { connect } from "../../logic/connect";
import { copy, enrollMessage } from "../../logic/copy";
import { Button } from "../../ui/Button";
import { Notice, Screen } from "../../ui/Layout";
import { ListRow, ListSection } from "../../ui/List";
import { AppText } from "../../ui/Text";
import { ManualRevocations } from "./ManualRevocations";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Connects Apple Health with a new access token from the signed-in account.
 * Fitness exchanges it once for this iPhone's import-only device key.
 */
export function Connect({
  status,
  onChange,
  title = copy.signIn.title,
  body = copy.signIn.body,
}: {
  status: SyncStatus;
  onChange: () => void;
  title?: string;
  body?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start(revokeLater: boolean) {
    setBusy(true);
    setMessage(null);
    const result = await connect(
      {
        authorize: async () => ({ token: await session.token({ fresh: true }), expiresAt: session.expiresAt() }),
        begin: () => FitnessHealth.beginEnrollment(),
        enroll: (token, later, attempt) => FitnessHealth.enroll(token, later, attempt),
        sleep,
        now: () => Date.now(),
      },
      revokeLater,
    );
    setBusy(false);
    if (result.kind === "cancelled") return;
    if (result.kind === "signInFailed") return setMessage(result.message);
    if (result.kind === "tokenExpires") return setMessage(copy.signIn.tryLater(result.retryAfter));
    if (result.kind === "consentPending") return onChange();
    setPending(result.kind === "pendingRevocations");
    setMessage(enrollMessage(result));
  }

  return (
    <Screen testID="screen-connect">
      <View className="gap-2 px-1">
        <AppText textRole="title" weight="bold" accessibilityRole="header">
          {title}
        </AppText>
        <AppText>{body}</AppText>
      </View>
      <ListSection>
        <ListRow icon="scalemass" iconTile="bg-primary" label="Weigh-ins" description="Body mass from Health" />
        <ListRow icon="figure.run" iconTile="bg-done" label="Runs" description="Running workouts and their distance" />
      </ListSection>
      {message ? (
        <Notice tone="warning" testID="sign-in-message">
          {message}
        </Notice>
      ) : null}
      <ManualRevocations status={status} onChange={onChange} />
      <Button
        label={copy.signIn.button}
        icon="heart.fill"
        onPress={() => void start(false)}
        busy={busy}
        fullWidth
        testID="health-connect"
      />
      {pending ? (
        <Button
          label="Continue and revoke later"
          tone="secondary"
          onPress={() => void start(true)}
          disabled={busy}
          testID="sign-in-revoke-later"
        />
      ) : null}
    </Screen>
  );
}
