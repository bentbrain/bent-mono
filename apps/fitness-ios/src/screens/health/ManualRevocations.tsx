import { useState } from "react";
import type { SyncStatus } from "../../../modules/fitness-health";
import { FitnessHealth } from "../../../modules/fitness-health";
import { copy } from "../../logic/copy";
import { manualRevocationNotice } from "../../logic/screens";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/Layout";

/** Keys to revoke in Fitness by hand, until the user dismisses the notice. */
export function ManualRevocations({ status, onChange }: { status: SyncStatus; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const notice = manualRevocationNotice(status);
  if (!notice) return null;
  async function dismiss(revision: number) {
    setBusy(true);
    try {
      await FitnessHealth.dismissManualRevocations(revision);
    } finally {
      setBusy(false);
      onChange();
    }
  }
  return (
    <Notice
      tone="warning"
      testID="manual-revocations"
      action={
        <Button
          label={copy.status.dismissManualRevocations}
          tone="secondary"
          size="compact"
          onPress={() => dismiss(notice.revision)}
          busy={busy}
          testID="dismiss-manual-revocations"
        />
      }
    >
      {notice.text}
    </Notice>
  );
}
