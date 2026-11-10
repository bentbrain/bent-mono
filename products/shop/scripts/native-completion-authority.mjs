import { protectedConfig } from "./protected-config.mjs";
import { forwardRecoveryObject } from "./native-forward-recovery-reference.mjs";
import { createHash } from "node:crypto";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => { if (!value) throw Error(`Development completion stopped: ${reason}`); };

export const completionEffects = ["claim-failed-attempt", "record-completion-evidence", "upload-original-api-with-atomic-secrets", "resume-exact-control"];
export function completionReference(encoded) {
  check(typeof encoded === "string" && Buffer.byteLength(encoded) <= 4096, "bounded completion reference required.");
  const value = JSON.parse(encoded);
  check(value?.schemaVersion === 1 && Object.keys(value).sort().join() === "authority,schemaVersion", "exact completion reference required.");
  forwardRecoveryObject(value.authority, "completion-authority.json");
  return value;
}
export function validateCompletionAuthority(authority, env, { staged = true, config = protectedConfig } = {}) {
  check(authority && Object.keys(authority).sort().join() ===
    "accountId,allowedEffects,applicationSourceCommit,cloudflareAccountId,environment,expectedApiLatestSettings,expectedApiSettings,failedAttempt,failedPreparation,failedRunId,kind,originalAuthority,originalPlan,region,schemaVersion,snapshot,toolSourceCommit", "exact completion authority schema required.");
  check(authority.schemaVersion === 1 && authority.kind === "development-failed-forward-completion-v1" &&
    authority.environment === "development" && authority.accountId === config("awsAccountId") && authority.region === "ap-southeast-2" &&
    authority.cloudflareAccountId === config("cloudflareAccountId") &&
    authority.toolSourceCommit === env.GITHUB_SHA && authority.toolSourceCommit === config("developmentCompletionSourceCommit") &&
    /^[a-f0-9]{40}$/.test(authority.toolSourceCommit) &&
    authority.applicationSourceCommit === config("developmentForwardRecoverySourceCommit") &&
    /^[a-f0-9]{40}$/.test(authority.applicationSourceCommit) && authority.applicationSourceCommit !== authority.toolSourceCommit &&
    /^[1-9][0-9]*$/.test(authority.failedRunId ?? "") && authority.failedRunId === config("developmentCompletionFailedRunId") &&
    authority.failedRunId !== env.GITHUB_RUN_ID && authority.failedAttempt === 1 &&
    JSON.stringify(authority.allowedEffects) === JSON.stringify(completionEffects), "separate current tool and failed application identities required.");
  forwardRecoveryObject(authority.originalAuthority, "forward-recovery-authority.json");
  forwardRecoveryObject(authority.originalPlan, "forward-recovery-plan.json");
  forwardRecoveryObject(authority.failedPreparation, "prepared.json");
  check(authority.originalAuthority.sha256 === config("developmentForwardRecoveryAuthoritySha256") &&
    authority.originalPlan.sha256 === config("developmentForwardRecoveryPlanSha256") &&
    authority.failedPreparation.key === `source/releases/native-${authority.failedRunId}/prepared.json`, "original approvals and failed preparation required.");
  check(authority.snapshot?.sha256 === config("developmentCompletionSnapshotSha256") && /^[a-f0-9]{64}$/.test(authority.snapshot.sha256) &&
    authority.expectedApiSettings && Array.isArray(authority.expectedApiSettings.bindings) && authority.expectedApiLatestSettings && Array.isArray(authority.expectedApiLatestSettings.bindings), "independently reviewed complete state and API settings required.");
  if (staged) forwardRecoveryObject(authority.snapshot, "completion-snapshot.json");
  else check(Object.keys(authority.snapshot).join() === "sha256", "hash-only snapshot template required.");
}
export function approvedCompletionPackage(encoded, env) {
  check(typeof encoded === "string" && Buffer.byteLength(encoded) > 0 && Buffer.byteLength(encoded) <= 48 * 1024 &&
    hash(encoded) === protectedConfig("developmentCompletionPackageSha256"), "independently reviewed protected completion package required.");
  const value = JSON.parse(encoded);
  check(value?.schemaVersion === 1 && Object.keys(value).sort().join() === "authority,schemaVersion", "exact completion package required.");
  validateCompletionAuthority(value.authority, env, { staged: false });
  return value.authority;
}
export function failedRecoveryProvenance(run, authority, config = protectedConfig) {
  check(run?.id === Number(authority.failedRunId) && run.run_attempt === 1 && run.status === "completed" && run.conclusion === "failure" &&
    run.event === "workflow_dispatch" && run.head_branch === "main" && run.head_sha === authority.applicationSourceCommit &&
    run.path === ".github/workflows/native-development.yml" && run.repository?.full_name === "bentbrain/bent-mono" &&
    run.repository.id === Number(config("githubRepositoryId")) && run.repository.owner?.id === Number(config("githubOwnerId")) &&
    run.head_repository?.id === Number(config("githubRepositoryId")) &&
    (run.display_title ?? "").startsWith(`Native development · recover-forward-release · full · - · - · main · ${authority.applicationSourceCommit} ·`),
    "authenticated failed first-attempt recovery provenance required.");
  // Keep stable GitHub fields. Signed current identity is recorded separately.
  return Object.fromEntries(["id", "run_attempt", "status", "conclusion", "event", "head_branch", "head_sha", "path", "repository", "head_repository", "display_title"].map(key => [key, run[key]]));
}
