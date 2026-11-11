import { equalWorkerSettings } from "./native-worker-settings.mjs";
import { protectedConfig } from "./protected-config.mjs";
import { forwardRecoveryObject } from "./native-forward-recovery-reference.mjs";
import { createHash } from "node:crypto";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => { if (!value) throw Error(`Development completion stopped: ${reason}`); };

export const completionEffects = ["claim-failed-attempt", "record-completion-evidence", "upload-original-api-with-atomic-secrets", "resume-exact-control"];
export const completionVerificationEffects = ["claim-completion-verification", "record-completion-evidence", "resume-exact-control"];
export const isVerificationCompletion = authority => authority?.schemaVersion === 2 && authority.phase === "verify-uploaded-api";
export function completionReference(encoded) {
  check(typeof encoded === "string" && Buffer.byteLength(encoded) <= 4096, "bounded completion reference required.");
  const value = JSON.parse(encoded);
  check([1, 2].includes(value?.schemaVersion) && Object.keys(value).sort().join() === "authority,schemaVersion", "exact completion reference required.");
  forwardRecoveryObject(value.authority, "completion-authority.json");
  return value;
}
export function validateCompletionAuthority(authority, env, { staged = true, config = protectedConfig } = {}) {
  const verification = isVerificationCompletion(authority);
  const fields = "accountId,allowedEffects,applicationSourceCommit,cloudflareAccountId,environment,expectedApiLatestSettings,expectedApiSettings,failedAttempt,failedPreparation,failedRunId,kind,originalAuthority,originalPlan,region,schemaVersion,snapshot,toolSourceCommit".split(",");
  if (verification) fields.push("phase", "interruptedCompletion");
  check(authority && Object.keys(authority).sort().join() === fields.sort().join(), "exact completion authority schema required.");
  check((verification ? authority.kind === "development-failed-forward-completion-v2" : authority.schemaVersion === 1 && authority.kind === "development-failed-forward-completion-v1") &&
    authority.environment === "development" && authority.accountId === config("awsAccountId") && authority.region === "ap-southeast-2" &&
    authority.cloudflareAccountId === config("cloudflareAccountId") &&
    authority.toolSourceCommit === env.GITHUB_SHA && authority.toolSourceCommit === config("developmentCompletionSourceCommit") &&
    /^[a-f0-9]{40}$/.test(authority.toolSourceCommit) &&
    authority.applicationSourceCommit === config("developmentForwardRecoverySourceCommit") &&
    /^[a-f0-9]{40}$/.test(authority.applicationSourceCommit) && authority.applicationSourceCommit !== authority.toolSourceCommit &&
    /^[1-9][0-9]*$/.test(authority.failedRunId ?? "") && authority.failedRunId === config("developmentCompletionFailedRunId") &&
    authority.failedRunId !== env.GITHUB_RUN_ID && authority.failedAttempt === 1 &&
    JSON.stringify(authority.allowedEffects) === JSON.stringify(verification ? completionVerificationEffects : completionEffects), "separate current tool and failed application identities required.");
  forwardRecoveryObject(authority.originalAuthority, "forward-recovery-authority.json");
  forwardRecoveryObject(authority.originalPlan, "forward-recovery-plan.json");
  forwardRecoveryObject(authority.failedPreparation, "prepared.json");
  check(authority.originalAuthority.sha256 === config("developmentForwardRecoveryAuthoritySha256") &&
    authority.originalPlan.sha256 === config("developmentForwardRecoveryPlanSha256") &&
    authority.failedPreparation.key === `source/releases/native-${authority.failedRunId}/prepared.json`, "original approvals and failed preparation required.");
  check(authority.snapshot?.sha256 === config("developmentCompletionSnapshotSha256") && /^[a-f0-9]{64}$/.test(authority.snapshot.sha256) &&
    authority.expectedApiSettings && Array.isArray(authority.expectedApiSettings.bindings) && authority.expectedApiLatestSettings && Array.isArray(authority.expectedApiLatestSettings.bindings), "independently reviewed complete state and API settings required.");
  check(equalWorkerSettings(authority.expectedApiSettings, authority.expectedApiSettings) &&
    equalWorkerSettings(authority.expectedApiLatestSettings, authority.expectedApiLatestSettings), "complete uniquely named Worker settings required.");
  if (verification) {
    const old = authority.interruptedCompletion;
    check(old && Object.keys(old).sort().join() === "attempt,authority,claim,deployStarted,preparation,runId,sourceCommit" &&
      /^[1-9][0-9]*$/.test(old.runId ?? "") && old.runId !== env.GITHUB_RUN_ID && old.runId !== authority.failedRunId &&
      old.attempt === 1 && /^[a-f0-9]{40}$/.test(old.sourceCommit ?? "") && old.sourceCommit !== authority.toolSourceCommit &&
      old.sourceCommit !== authority.applicationSourceCommit, "exact interrupted first-attempt completion required.");
    forwardRecoveryObject(old.authority, "completion-authority.json");
    forwardRecoveryObject(old.preparation, "completion-prepared.json");
    check(old.preparation.key === `source/releases/native-${old.runId}/completion-prepared.json`, "original completion preparation run required.");
    for (const [event, stage] of [[old.claim, "completion-attempt-one-claimed"], [old.deployStarted, "completion-api-deploy-started"]])
      check(event && Object.keys(event).sort().join() === "created_at,payload,stage" && event.stage === stage &&
        typeof event.payload === "string" && event.payload.length <= 32000 && Number.isSafeInteger(event.created_at) && event.created_at > 0,
        "exact interrupted completion event required.");
  }
  if (staged) forwardRecoveryObject(authority.snapshot, "completion-snapshot.json");
  else check(Object.keys(authority.snapshot).join() === "sha256", "hash-only snapshot template required.");
}
export function approvedCompletionPackage(encoded, env) {
  check(typeof encoded === "string" && Buffer.byteLength(encoded) > 0 && Buffer.byteLength(encoded) <= 48 * 1024 &&
    hash(encoded) === protectedConfig("developmentCompletionPackageSha256"), "independently reviewed protected completion package required.");
  const value = JSON.parse(encoded);
  check([1, 2].includes(value?.schemaVersion) && Object.keys(value).sort().join() === "authority,schemaVersion", "exact completion package required.");
  check(value.schemaVersion === value.authority?.schemaVersion, "completion package version differs from authority.");
  validateCompletionAuthority(value.authority, env, { staged: false });
  return value.authority;
}
export function failedRecoveryProvenance(run, authority, config = protectedConfig) {
  return completionRunProvenance(run, authority.failedRunId, authority.applicationSourceCommit, "recover-forward-release", config);
}
export function interruptedCompletionProvenance(run, authority, config = protectedConfig) {
  const old = authority.interruptedCompletion;
  return completionRunProvenance(run, old.runId, old.sourceCommit, "complete-forward-release", config);
}
function completionRunProvenance(run, runId, sourceCommit, operation, config) {
  check(run?.id === Number(runId) && run.run_attempt === 1 && run.status === "completed" && run.conclusion === "failure" &&
    run.event === "workflow_dispatch" && run.head_branch === "main" && run.head_sha === sourceCommit &&
    run.path === ".github/workflows/native-development.yml" && run.repository?.full_name === "bentbrain/bent-mono" &&
    run.repository.id === Number(config("githubRepositoryId")) && run.repository.owner?.id === Number(config("githubOwnerId")) &&
    run.head_repository?.id === Number(config("githubRepositoryId")) &&
    (run.display_title ?? "").startsWith(`Native development · ${operation} · full · - · - · main · ${sourceCommit} ·`),
    "authenticated failed first-attempt recovery provenance required.");
  // Keep stable GitHub fields. Signed current identity is recorded separately.
  return Object.fromEntries(["id", "run_attempt", "status", "conclusion", "event", "head_branch", "head_sha", "path", "repository", "head_repository", "display_title"].map(key => [key, run[key]]));
}
