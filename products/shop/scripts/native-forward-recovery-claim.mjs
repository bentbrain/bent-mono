import { isDeepStrictEqual as equal } from "node:util";
import { recordReleaseEvent, verifyPauseSchema } from "./native-release-pause.mjs";
import { recoveryCheck as check, recoveryControl } from "./native-forward-recovery-inspection.mjs";

// A lost acknowledgement consumes the claim. Neither this function nor a new
// dispatch can retry it, even when the old control still appears unchanged.
export async function claimForwardRecovery({ cf, control, releaseId, sourceCommit, authority, plan, preparation, now = Date.now() }) {
  check(/^native-[1-9][0-9]*$/.test(releaseId) && releaseId !== control.release_id && releaseId !== control.current_release_id && control.paused === 1 &&
    [control.paused_at, control.updated_at].every(time => Number.isSafeInteger(time) && time > 0) &&
    /^[a-f0-9]{40}$/.test(sourceCommit) && Number.isSafeInteger(now) && now > control.updated_at &&
    [authority, plan, preparation].every(ref => /^[a-f0-9]{64}$/.test(ref?.sha256 ?? "")), "distinct source-bound recovery claim required.");
  await verifyPauseSchema(cf);
  check(equal(await recoveryControl(cf), control), "control changed before claim.");
  const prior = (await cf.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = ?", [control.release_id, "forward-recovery-claimed"]))[0].results;
  check(prior.length === 0, "old owner already has a one-use recovery claim; inspect only.");
  const claim = { schemaVersion: 1, releaseId, sourceCommit, authority, plan, preparation, control, pausedAt: now };
  await recordReleaseEvent(cf, control.release_id, "forward-recovery-claimed", claim, now);
  const changed = await cf.query(`UPDATE native_video_release_control SET release_id = ?, paused_at = ?, updated_at = ?
    WHERE singleton = 1 AND paused = 1 AND release_id = ? AND current_release_id = ? AND paused_at = ? AND updated_at = ?
      AND EXISTS (SELECT 1 FROM native_video_release_events WHERE release_id = ? AND stage = 'forward-recovery-claimed' AND payload = ?)`,
  [releaseId, now, now, control.release_id, control.current_release_id, control.paused_at, control.updated_at, control.release_id, JSON.stringify(claim)]);
  check(changed.length === 1 && changed[0].meta?.changes === 1, "exact pause transfer was not confirmed; inspect only.");
  const transferred = { ...control, release_id: releaseId, paused_at: now, updated_at: now };
  check(equal(await recoveryControl(cf), transferred), "pause transfer acknowledgement was not confirmed; inspect only.");
  return transferred;
}
