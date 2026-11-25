import { useState } from "react";
import { FitnessHealth } from "../../modules/fitness-health";
import { authorize, oauthSettings } from "../auth";
import { connect } from "../logic/connect";
import { copy, enrollMessage } from "../logic/copy";
import { Body, Button, Notice, Page } from "../ui/parts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function SignIn({
  onChange,
  title = copy.signIn.title,
  body = copy.signIn.body,
}: {
  onChange: () => void;
  title?: string;
  body?: string;
}) {
  const settings = oauthSettings();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start(revokeLater: boolean) {
    if (!settings) return;
    setBusy(true);
    setMessage(null);
    const result = await connect(
      {
        authorize: () => authorize(settings),
        enroll: (token, later) => FitnessHealth.enroll(token, later),
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
    <Page title={title} testID="screen-sign-in">
      <Body>{body}</Body>
      {settings ? null : <Notice testID="sign-in-unconfigured">{copy.signIn.unconfigured}</Notice>}
      {message ? <Notice testID="sign-in-message">{message}</Notice> : null}
      <Button
        label={copy.signIn.button}
        onPress={() => start(false)}
        busy={busy}
        disabled={!settings}
        testID="sign-in"
      />
      {pending ? (
        <Button
          label="Continue and revoke later"
          appearance="outline"
          onPress={() => start(true)}
          disabled={busy}
          testID="sign-in-revoke-later"
        />
      ) : null}
    </Page>
  );
}
