import { isDeepStrictEqual as equal } from "node:util";
import { requireReleaseChecks, githubApi as canonicalGithub } from "../../../scripts/require-release-checks.mjs";
import { githubApi } from "./github-actions.mjs";
import { protectedConfig } from "./protected-config.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { inspectNativeDevelopmentIdentity } from "./native-ci-identity.mjs";
import { developmentCloudflare, inspectDevelopmentCloudflare } from "./native-ci-cloudflare.mjs";
import { developmentPrintExecutorClient } from "./native-print-executor.mjs";
import { developmentPrintStagingLifecycle } from "./native-print-staging-lifecycle.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { inspectDevelopmentRuntime } from "./native-ci-runtime.mjs";
import { loadVerifiedCandidate } from "./native-ci-candidate.mjs";
import { verifyDevelopmentPairStatus } from "./native-ci-worker.mjs";
import { enforceWorkerRelease } from "../apps/web/scripts/verify-worker-release.mjs";
import { recordReleaseEvent, resumeVerifiedRelease } from "./native-release-pause.mjs";
import { forwardRecoveryObject } from "./native-forward-recovery-reference.mjs";
import { recoveryCheck as check, recoveryHash as hash } from "./native-forward-recovery-inspection.mjs";
import { completionReference, approvedCompletionPackage, validateCompletionAuthority } from "./native-completion-authority.mjs";
import { completionInputs, inspectCompletionState, verifyCompletionDrain } from "./native-completion-inspection.mjs";
import { claimFailedRecoveryCompletion } from "./native-completion-claim.mjs";
import { prepareCompletionApi } from "./native-completion-worker.mjs";

export async function runFailedForwardCompletion(env, dependencies = {}) {
  const operation = developmentOperation(env), stage = operation === "stage-forward-completion-authority";
  check(stage || operation === "complete-forward-release", "dedicated failed-recovery completion operation required.");
  const currentMain = dependencies.currentMain ?? (() => requireReleaseChecks(env.GITHUB_SHA, canonicalGithub));
  await currentMain();
  const identity = await (dependencies.identity ?? inspectNativeDevelopmentIdentity)(env);
  check(identity.signatureVerified === true && identity.runId === env.GITHUB_RUN_ID && identity.sourceCommit === env.GITHUB_SHA, "fresh signed canonical tool identity required.");
  const cf = dependencies.cf ?? developmentCloudflare(env), client = dependencies.client ?? developmentPrintExecutorClient(env),
    staging = dependencies.staging ?? developmentPrintStagingLifecycle(env), store = dependencies.store ?? await createDevelopmentReleaseStore(env);
  const reference = stage ? undefined : completionReference(env.NATIVE_COMPLETION_REFERENCE).authority;
  let authority, approved;
  if (stage) authority = approvedCompletionPackage(env.NATIVE_COMPLETION_PACKAGE, env);
  else {
    check(reference.sha256 === protectedConfig("developmentCompletionAuthoritySha256"), "separate final authority approval required after staged readback.");
    const bytes = await store.read(reference);
    check(hash(bytes) === reference.sha256, "completion authority bytes changed.");
    authority = JSON.parse(bytes); validateCompletionAuthority(authority, env);
    const snapshot = await store.read(authority.snapshot);
    check(hash(snapshot) === authority.snapshot.sha256, "completion snapshot bytes changed.");
    approved = JSON.parse(snapshot);
  }
  const inputs = await completionInputs(store, authority), extra = [];
  const runtimeRead = dependencies.runtimeRead ?? (() => inspectDevelopmentRuntime(env));
  const inspect = liveApi => inspectCompletionState({ cf, client, staging, store, authority, inputs, runtimeRead, extra, liveApi, env,
    bindingsRead: dependencies.bindingsRead ?? (() => inspectDevelopmentCloudflare(env)),
    runRead: dependencies.runRead ?? (() => githubApi({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY })(`actions/runs/${authority.failedRunId}/attempts/1`)) });
  const state = await inspect();
  check(hash(JSON.stringify(state)) === authority.snapshot.sha256 && (!approved || equal(state, approved)), "current complete failed state differs from independently approved snapshot.");
  inputs.state = state;
  const save = async (filename, value) => {
    const bytes = Buffer.from(JSON.stringify(value)), ref = await store.save(filename, bytes);
    forwardRecoveryObject(ref, filename);
    check(ref.key === `source/releases/native-${env.GITHUB_RUN_ID}/${filename}` && hash(bytes) === ref.sha256 &&
      equal(await store.read(ref), bytes), "current-tool immutable evidence readback differs.");
    return ref;
  };
  if (stage) {
    const snapshot = await save("completion-snapshot.json", state);
    check(equal(await inspect(), state), "state changed during snapshot staging.");
    const staged = await save("completion-authority.json", { ...authority, snapshot });
    check(equal(await inspect(), state), "state changed during authority staging.");
    return { operation, reference: { schemaVersion: 1, authority: staged }, deploymentPerformed: false, admissionsPaused: true, rollbackQualified: false };
  }
  const currentCandidate = await (dependencies.candidate ?? loadVerifiedCandidate)(JSON.parse(env.NATIVE_CANDIDATE_RECEIPT), env);
  const { verifiedForCommit: originalVerification, ...originalCandidate } = inputs.prepared.candidate;
  const { verifiedForCommit: toolVerification, ...observedCandidate } = currentCandidate;
  check(originalVerification === authority.applicationSourceCommit && toolVerification === authority.toolSourceCommit &&
    equal(originalCandidate, observedCandidate), "fresh immutable candidate authentication must bind original application and current tool source independently.");
  let deployedBindings;
  const verify = async liveApi => {
    const actual = await inspect(liveApi);
    if (liveApi) {
      check(liveApi.workerVersion !== state.api.workerVersion && actual.bindings.workerVersion === liveApi.workerVersion &&
        actual.bindings.deploymentId !== state.bindings.deploymentId, "completion requires the verified new API deployment.");
      // Keep the first independently inspected deployment identity for every
      // subsequent check. Only these two binding-summary fields may change.
      deployedBindings ??= { ...state.bindings, workerVersion: liveApi.workerVersion, deploymentId: actual.bindings.deploymentId };
    }
    const expected = liveApi ? { ...state, api: liveApi, apiSettings: authority.expectedApiSettings,
      latestApiSettings: authority.expectedApiLatestSettings, bindings: deployedBindings } : state;
    check(equal(actual, expected), "approved current state changed before completion mutation.");
    // Latest settings must match the same uploaded active version's reviewed
    // runtime and bindings. The full latest read is sealed after deployment.
    await verifyCompletionDrain(cf, state.control);
  };
  await verify();
  const worker = await (dependencies.worker ?? prepareCompletionApi)({ env, cf, store, authority, inputs });
  await verify(); await currentMain();
  const foundationArtifact = await save("completion-executor-foundation.json", inputs.uploads.executor);
  const completedPreparation = { ...inputs.prepared, worker: { ...inputs.uploads.api, printExecutor: inputs.uploads.executor },
    artifacts: { ...inputs.prepared.artifacts, printExecutor: { ...inputs.prepared.artifacts.printExecutor, foundationArtifact } },
    completion: { authority: reference, originalPreparation: authority.failedPreparation, toolIdentity: identity, currentCandidate, startup: state.startup }, rollbackQualified: false };
  const preparation = await save("completion-prepared.json", completedPreparation);
  await verify(); await currentMain();
  extra.push(await claimFailedRecoveryCompletion({ cf, authority, reference, preparation, control: state.control, identity }));
  await verify();
  const executor = { worker: state.executor, namespaceId: inputs.original.namespaceId, lifecycle: state.executorLifecycle,
    stagingEvidence: state.stagingEvidence, sourceCommit: authority.applicationSourceCommit, configSha256: inputs.uploads.executor.configSha256,
    releaseId: inputs.prepared.releaseId, artifacts: completedPreparation.artifacts.printExecutor };
  const executorEvidence = await save("completion-deployed-executor.json", executor);
  const record = async (stageName, value) => {
    const created_at = Date.now(), payload = JSON.stringify(value);
    await recordReleaseEvent(cf, inputs.prepared.releaseId, stageName, value, created_at);
    extra.push({ stage: stageName, payload, created_at });
  };
  await verify();
  await record("completion-api-deploy-started", { authority: reference, preparation, originalArtifacts: inputs.prepared.artifacts });
  const live = await worker.deploy(() => verify());
  await verify(live);
  // These completion records describe newly verified facts. Original failed
  // journals, original seals and the consumed transfer claim remain intact.
  await record("completion-api-verified", { worker: live, preparation });
  await verify(live);
  return resumeVerifiedRelease(cf, inputs.prepared.releaseId, async () => {
    await verify(live);
    const status = await (dependencies.verifyStatus ?? (async () => {
      const value = await verifyDevelopmentPairStatus(env, inputs.prepared.candidate, inputs.prepared.releaseId, fetch, { sourceCommit: authority.applicationSourceCommit });
      await enforceWorkerRelease({ enforcement: "1", apiUrl: env.WORKER_URL, sharedSecret: env.FOREVER_TEE_API_SHARED_SECRET });
      return { ...value, artworkMediaCapabilityVerified: true };
    }))();
    await verify(live);
    return { releaseId: inputs.prepared.releaseId, sourceCommit: authority.applicationSourceCommit, candidate: inputs.prepared.candidate,
      worker: { ...live, printExecutor: { ...executor, evidence: executorEvidence } }, runtime: state.runtime, status,
      completion: { authority: reference, preparation, toolIdentity: identity, originalPreparation: authority.failedPreparation },
      forwardRecovery: { authority: authority.originalAuthority, plan: authority.originalPlan, interrupted: inputs.prepared.interrupted, rollbackQualified: false }, rollbackQualified: false };
  }, { expectedControl: state.control });
}
