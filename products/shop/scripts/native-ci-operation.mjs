import { forwardRecoveryReference } from "./native-forward-recovery-reference.mjs";
import { rollbackRecoveryReference } from "./native-rollback-reference.mjs";
import { recoveryReference, rendererReference, failedQualificationReference } from "./native-qualification-reference.mjs";
import { assertActionsIdentityContext } from "./native-ci-identity.mjs";

export function developmentOperation(env) {
  assertActionsIdentityContext(env);
  const operation = env.NATIVE_OPERATION ?? "plan";
  const mode = env.NATIVE_RELEASE_MODE ?? "full";
  if (env.NATIVE_SCHEDULED_QUALIFICATION && !["false", "true"].includes(env.NATIVE_SCHEDULED_QUALIFICATION)) throw Error("Invalid scheduled qualification flag.");
  if (env.NATIVE_SCHEDULED_QUALIFICATION === "true" && (operation !== "qualify-all" || env.GITHUB_REF !== "refs/heads/main"))
    throw Error("Scheduled checks require full main qualification.");
  if (!["full", "api"].includes(mode) || (mode === "api" && operation !== "release")) throw Error("API-only mode requires a release operation.");
  if (operation === "cleanup-failed-qualification") {
    failedQualificationReference(env.NATIVE_QUALIFICATION_REFERENCE, env.NATIVE_VERIFY_RELEASE);
    if (env.GITHUB_REF !== "refs/heads/main") throw Error("Failed qualification cleanup requires main.");
  } else if (operation === "cleanup-qualification") {
    recoveryReference(env.NATIVE_QUALIFICATION_REFERENCE,env.NATIVE_VERIFY_RELEASE);
    if (env.GITHUB_REF !== "refs/heads/main") throw Error("Qualification cleanup requires main.");
  } else if (env.NATIVE_QUALIFICATION_REFERENCE) throw Error("Qualification reference is restricted to cleanup recovery.");
  if (operation === "qualify-components") {
    rendererReference(env.NATIVE_RENDERER_REFERENCE);
    if (env.GITHUB_REF !== "refs/heads/main" || typeof env.NATIVE_RENDERER_REFERENCE !== "string" || env.NATIVE_RENDERER_REFERENCE.length > 4096)
      throw Error("Component qualification requires main and a bounded renderer reference.");
  } else if (env.NATIVE_RENDERER_REFERENCE) throw Error("Renderer reference is restricted to component qualification.");
  if (operation === "recover-rollback") {
    rollbackRecoveryReference(env.NATIVE_ROLLBACK_REFERENCE, env.NATIVE_ROLLBACK_RELEASE);
    if (env.GITHUB_REF !== "refs/heads/main") throw Error("Paused rollback recovery requires main.");
  } else if (env.NATIVE_ROLLBACK_REFERENCE) throw Error("Rollback reference is restricted to paused rollback recovery.");
  if (["plan-forward-recovery", "recover-forward-release"].includes(operation)) {
    forwardRecoveryReference(env.NATIVE_FORWARD_RECOVERY_REFERENCE, operation === "recover-forward-release");
    if (env.GITHUB_REF !== "refs/heads/main" || mode !== "full") throw Error("Forward recovery requires first-attempt current-main full preparation.");
  } else if (env.NATIVE_FORWARD_RECOVERY_REFERENCE) throw Error("Forward recovery reference requires its dedicated operation.");
  const referencedRelease = ["qualify", "qualify-exhaustion", "qualify-faults", "qualify-termination", "qualify-load", "qualify-all", "qualify-components", "verify-qualification", "repair-schedule", "cleanup-qualification", "cleanup-failed-qualification"].includes(operation);
  if (env.GITHUB_WORKFLOW_REF !== `bentbrain/bent-mono/.github/workflows/native-development.yml@${env.GITHUB_REF}` ||
    !["plan", "build-candidate", "release", "rollback", "recover-rollback", "plan-forward-recovery", "recover-forward-release", "qualify", "qualify-exhaustion", "qualify-faults", "qualify-termination", "qualify-load", "qualify-all", "qualify-components", "verify-qualification", "repair-schedule", "cleanup-qualification", "cleanup-failed-qualification"].includes(operation) ||
    (operation === "repair-schedule" && env.GITHUB_REF !== "refs/heads/main") ||
    (operation !== "plan" && (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_RUN_ATTEMPT !== "1")) ||
    (!["rollback", "recover-rollback"].includes(operation) && env.NATIVE_ROLLBACK_RELEASE) ||
    (!referencedRelease && env.NATIVE_VERIFY_RELEASE) ||
    (referencedRelease && !/^native-\d+$/.test(env.NATIVE_VERIFY_RELEASE ?? "")) ||
    (["rollback", "recover-rollback"].includes(operation) && (!/^native-\d+$/.test(env.NATIVE_ROLLBACK_RELEASE ?? "") || env.NATIVE_ROLLBACK_RELEASE === `native-${env.GITHUB_RUN_ID}`))) {
    throw new Error("Native operation refused. Mutations require an explicit first-attempt workflow dispatch; interrupted runs require recorded-pair recovery.");
  }
  return operation;
}
