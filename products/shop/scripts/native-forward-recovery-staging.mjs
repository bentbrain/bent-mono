import { requireReleaseChecks, githubApi } from "../../../scripts/require-release-checks.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { inspectNativeDevelopmentIdentity } from "./native-ci-identity.mjs";
import { developmentCloudflare } from "./native-ci-cloudflare.mjs";
import { developmentPrintExecutorClient } from "./native-print-executor.mjs";
import { developmentPrintStagingLifecycle } from "./native-print-staging-lifecycle.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { approvedForwardRecoveryPackage } from "./native-forward-recovery-package.mjs";
import { forwardRecoveryObject } from "./native-forward-recovery-reference.mjs";
import { validateForwardRecoveryAuthority, validateForwardRecoverySnapshot, inspectInterruptedDevelopmentRelease,
  recoveryHash, recoveryCheck as check } from "./native-forward-recovery-inspection.mjs";

export async function stageDevelopmentForwardRecoveryAuthority(env, dependencies = {}) {
  const operation = developmentOperation(env);
  check(operation === "stage-forward-recovery-authority", "dedicated authority staging operation required.");
  await (dependencies.currentMain ?? (() => requireReleaseChecks(env.GITHUB_SHA, githubApi)))();
  const identity = await (dependencies.identity ?? inspectNativeDevelopmentIdentity)(env);
  check(identity.signatureVerified === true && identity.runId === env.GITHUB_RUN_ID && identity.sourceCommit === env.GITHUB_SHA,
    "current canonical CI signature required.");
  const approved = approvedForwardRecoveryPackage(env.NATIVE_FORWARD_RECOVERY_PACKAGE, env.GITHUB_SHA);
  validateForwardRecoveryAuthority({ env, authority: approved.authority });
  validateForwardRecoverySnapshot(approved.snapshot, approved.authority);
  const cf = dependencies.cf ?? developmentCloudflare(env), client = dependencies.client ?? developmentPrintExecutorClient(env),
    staging = dependencies.staging ?? developmentPrintStagingLifecycle(env), store = dependencies.store ?? await createDevelopmentReleaseStore(env);
  const inspect = () => inspectInterruptedDevelopmentRelease({ cf, client, staging, store, authority: approved.authority, snapshot: approved.snapshot });
  await inspect();
  const releaseId = `native-${env.GITHUB_RUN_ID}`;
  const save = async (filename, bytes) => {
    // Fixed names, create-only store writes and version/hash readback. A failed
    // acknowledgement is terminal; neither this route nor the CI client retries.
    const reference = await store.save(filename, bytes);
    forwardRecoveryObject(reference, filename);
    check(reference.key === `source/releases/${releaseId}/${filename}` && reference.sha256 === recoveryHash(bytes), "current-run evidence reference differs.");
    check(recoveryHash(await store.read(reference)) === reference.sha256, "staged evidence readback differs.");
    return reference;
  };
  const snapshot = await save("forward-recovery-snapshot.json", Buffer.from(JSON.stringify(approved.snapshot)));
  await inspect();
  const authority = await save("forward-recovery-authority.json", Buffer.from(JSON.stringify({ ...approved.authority, snapshot })));
  await inspect();
  return { operation, releaseId, reference: { schemaVersion: 1, authority }, admissionsPaused: true, deploymentPerformed: false };
}
