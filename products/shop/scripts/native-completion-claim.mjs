import { isDeepStrictEqual as equal } from "node:util";
import { recoveryCheck as check, recoveryControl } from "./native-forward-recovery-inspection.mjs";

const completionClaimStage = "completion-attempt-one-claimed";
// INSERT SELECT atomically checks the complete original control fence. A lost
// acknowledgement consumes this failed-owner/attempt claim without transfer.
export async function claimFailedRecoveryCompletion({ cf, authority, reference, preparation, control, identity, now = Date.now() }) {
  check(control.paused === 1 && control.release_id === `native-${authority.failedRunId}` && authority.failedAttempt === 1 &&
    identity.signatureVerified === true && identity.sourceCommit === authority.toolSourceCommit && identity.runId !== authority.failedRunId &&
    Number.isSafeInteger(now) && now > control.updated_at, "exact signed completion claim required.");
  check(equal(await recoveryControl(cf), control), "pause changed before completion claim.");
  const payload = JSON.stringify({ schemaVersion: 1, failedRunId: authority.failedRunId, failedAttempt: 1,
    authority: reference, preparation, identity, control });
  check(payload.length <= 32000, "bounded completion claim required.");
  const result = await cf.query(`INSERT INTO native_video_release_events (release_id, stage, payload, created_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM native_video_release_control
      WHERE singleton = 1 AND paused = 1 AND release_id = ? AND current_release_id = ? AND paused_at = ? AND updated_at = ?)
    ON CONFLICT (release_id, stage) DO NOTHING`, [control.release_id, completionClaimStage, payload, now,
    control.release_id, control.current_release_id, control.paused_at, control.updated_at]);
  check(result.length === 1 && result[0].meta?.changes === 1, "one-use completion claim was not confirmed; inspect only.");
  const rows = (await cf.query("SELECT stage, payload, created_at FROM native_video_release_events WHERE release_id = ? AND stage = ?", [control.release_id, completionClaimStage]))[0].results;
  const event = { stage: completionClaimStage, payload, created_at: now };
  check(rows.length === 1 && equal(rows[0], event) && equal(await recoveryControl(cf), control), "completion acknowledgement was not confirmed; inspect only.");
  return event;
}
