import { requireReleaseChecks, githubApi } from "../../../scripts/require-release-checks.mjs";
import { enforceWorkerRelease } from "../apps/web/scripts/verify-worker-release.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { setTimeout } from "node:timers/promises";
import { protectedConfig } from "./protected-config.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { inspectNativeDevelopmentIdentity } from "./native-ci-identity.mjs";
import { developmentCloudflare, inspectDevelopmentCloudflare } from "./native-ci-cloudflare.mjs";
import { developmentPrintExecutorClient } from "./native-print-executor.mjs";
import { developmentPrintStagingLifecycle } from "./native-print-staging-lifecycle.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { inspectDevelopmentRuntime } from "./native-ci-runtime.mjs";
import { loadVerifiedCandidate } from "./native-ci-candidate.mjs";
import { prepareDevelopmentImage } from "./native-ci-terraform.mjs";
import { prepareDevelopmentWorker, inspectDevelopmentWorker, verifyDevelopmentPairStatus } from "./native-ci-worker.mjs";
import { probeDevelopmentFunctions } from "./native-ci-health.mjs";
import { forwardRecoveryReference } from "./native-forward-recovery-reference.mjs";
import { loadForwardRecoveryAuthority, inspectInterruptedDevelopmentRelease, recoveryHash, recoveryCheck as check, recoveryControl } from "./native-forward-recovery-inspection.mjs";
import { claimForwardRecovery } from "./native-forward-recovery-claim.mjs";
import { assertReleasePaused, inspectDevelopmentDrain, recordReleaseEvent, installPauseSchema, resumeVerifiedRelease, pauseSchemaManifest } from "./native-release-pause.mjs";
import { NATIVE_MIGRATION_LATEST, isReviewedAppliedMigrationPrefix, isReviewedMigrationInventory } from "./native-migration-inventory.mjs";
import { readdir } from "node:fs/promises";
import { readSealedWorkerUpload } from "./native-worker-content.mjs";

// Generation is the sole execution-time substitution in the reviewed Worker
// plan. Content, source, resources, namespace and original interrupted evidence
// remain exact. The current run owns its own complete preparation and events.
export function forwardWorkerPlan(review, releaseId) {
  const copy = structuredClone(review);
  check(copy.printExecutor?.before?.interrupted && copy.printExecutor.schemaVersion === 2 && copy.schemaVersion === 2 &&
    copy.printExecutor.releaseId === releaseId, "complete interrupted-state upload plan required.");
  copy.printExecutor.releaseId = "execution-run";
  return copy;
}

async function inspectRecoveryMigrations(cf) {
  const expected = (await readdir(new URL("../workers/api/drizzle/", import.meta.url))).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const applied = (await cf.query("SELECT name FROM d1_migrations ORDER BY name"))[0].results.map(row => row.name);
  check(isReviewedMigrationInventory(expected) && isReviewedAppliedMigrationPrefix(expected, applied), "reviewed current migration prefix required.");
  return { expected, applied };
}

export async function runDevelopmentForwardRecovery(env, dependencies = {}) {
  const operation = developmentOperation(env), execution = operation === "recover-forward-release";
  check(execution || operation === "plan-forward-recovery", "dedicated recovery operation required.");
  const currentMain = dependencies.currentMain ?? (() => requireReleaseChecks(env.GITHUB_SHA, githubApi));
  await currentMain();
  const reference = forwardRecoveryReference(env.NATIVE_FORWARD_RECOVERY_REFERENCE, execution);
  // This verifies a fresh signed canonical monorepo token, independently of
  // the protected personal-operator snapshot of the original private run.
  const identity = await (dependencies.identity ?? inspectNativeDevelopmentIdentity)(env);
  check(identity.signatureVerified === true && identity.runId === env.GITHUB_RUN_ID && identity.sourceCommit === env.GITHUB_SHA,
    "current canonical CI signature required.");
  const cf = dependencies.cf ?? developmentCloudflare(env), client = dependencies.client ?? developmentPrintExecutorClient(env),
    staging = dependencies.staging ?? developmentPrintStagingLifecycle(env), store = dependencies.store ?? await createDevelopmentReleaseStore(env);
  const loaded = await loadForwardRecoveryAuthority({ env, store, reference: reference.authority });
  const { authority, snapshot } = loaded, releaseId = `native-${env.GITHUB_RUN_ID}`;
  let control = authority.control, executorDeployed = false, imageApplied = false;
  const inspectInterrupted = pauseSchema => inspectInterruptedDevelopmentRelease({ cf, client, staging, store, authority, snapshot, expectedControl: control, pauseSchema });
  const interrupted = await inspectInterrupted(), pauseSchema = await pauseSchemaManifest(cf);
  const runtimeRead = dependencies.inspectRuntime ?? (() => inspectDevelopmentRuntime(env));
  const runtime = await runtimeRead(), bindings = await (dependencies.bindings ?? inspectDevelopmentCloudflare)(env), migrations = await inspectRecoveryMigrations(cf);
  check(runtime.runtimeVerified === true && runtime.environment === "development", "fresh current runtime required.");
  check(typeof env.NATIVE_CANDIDATE_RECEIPT === "string" && env.NATIVE_CANDIDATE_RECEIPT.length > 0, "authenticated existing candidate receipt required; recovery never builds an image.");
  const candidate = await (dependencies.candidate ?? loadVerifiedCandidate)(JSON.parse(env.NATIVE_CANDIDATE_RECEIPT), env);
  check(candidate.candidateVerified === true && candidate.reused === true && candidate.verifiedForCommit === env.GITHUB_SHA, "fresh candidate source and immutable build readback required.");
  let approvedPlan;
  if (execution) {
    check(reference.plan.sha256 === protectedConfig("developmentForwardRecoveryPlanSha256"), "independently approved exact full plan hash required.");
    const bytes = await store.read(reference.plan);
    check(recoveryHash(bytes) === reference.plan.sha256, "approved full plan bytes changed.");
    approvedPlan = JSON.parse(bytes);
    check(approvedPlan.schemaVersion === 1 && approvedPlan.operation === "plan-forward-recovery" &&
      approvedPlan.sourceCommit === env.GITHUB_SHA && equal(approvedPlan.authority, reference.authority) &&
      /^native-[1-9][0-9]*$/.test(approvedPlan.releaseId ?? "") && approvedPlan.releaseId !== releaseId &&
      reference.plan.key === `source/releases/${approvedPlan.releaseId}/forward-recovery-plan.json` &&
      approvedPlan.releaseId !== authority.control.release_id && equal(approvedPlan.interrupted, interrupted) &&
      equal(approvedPlan.previous, { runtime, bindings, migrations, pauseSchema }), "approved plan source, authority or prior live state differs.");
    // Candidate receipts are reauthenticated above, including current source.
    check(equal(approvedPlan.candidate, candidate), "approved candidate differs from authenticated current candidate.");
    await readSealedWorkerUpload(store, approvedPlan.artifacts, approvedPlan.worker);
    await readSealedWorkerUpload(store, approvedPlan.artifacts.printExecutor, approvedPlan.worker.printExecutor);
  }
  const image = await (dependencies.image ?? prepareDevelopmentImage)(candidate, env,
    execution ? { sealedPlan: { reference: approvedPlan.planArtifact, review: approvedPlan.image, store } } : {});
  const verifyRuntime = async () => {
    const live = await runtimeRead();
    if (!imageApplied) check(equal(live, runtime), "prior runtime changed before mutation.");
    else check(live.renderer.imageDigest === candidate.imageDigest && live.failure.imageDigest === candidate.imageDigest &&
      live.renderer.sourceDigest === candidate.sourceDigest, "current candidate runtime changed.");
  };
  const recovery = { review: interrupted,
    ...(execution ? { sealedWorker: { store, artifacts: approvedPlan.artifacts, review: approvedPlan.worker },
      sealedExecutor: { store, artifacts: approvedPlan.artifacts.printExecutor, review: approvedPlan.worker.printExecutor } } : {}),
    schedules: authority.schedules, verifyPrevious: inspectInterrupted, beforeMutation: async stage => {
    await assertReleasePaused(cf, releaseId);
    check(equal(await recoveryControl(cf), control), "new exact pause tuple changed.");
    await verifyRuntime();
    if (!executorDeployed) await inspectInterrupted(stage === "pause-schema" ? pauseSchema : undefined);
    else {
      check(stage === "api-deploy", "unexpected mutation after executor deployment.");
      check(equal(await inspectDevelopmentWorker(cf), interrupted.api), "old API changed before activation.");
      await worker.verifyPrintExecutor(false);
    }
  } };
  const worker = await (dependencies.worker ?? prepareDevelopmentWorker)(env, { recovery });
  check(worker.review.printExecutor?.before?.interrupted && worker.review.printExecutor.stagingLifecycle.mutationRequired === false,
    "existing namespace and verified staging fallback required.");
  if (execution) {
    check(equal(forwardWorkerPlan(worker.review, releaseId), forwardWorkerPlan(approvedPlan.worker, approvedPlan.releaseId)) &&
      equal(image.review, approvedPlan.image), "new preparation differs from approved complete upload/image plan.");
  }
  check(equal(await runtimeRead(), runtime) && equal(await inspectRecoveryMigrations(cf), migrations), "runtime or migrations changed during preparation.");
  await inspectInterrupted();
  const artifacts = await worker.preserve(store), planArtifact = await image.preserve(store);
  const plan = { schemaVersion: 1, operation: "plan-forward-recovery", releaseId, sourceCommit: env.GITHUB_SHA,
    authority: reference.authority, interrupted, candidate, worker: worker.review, image: image.review,
    artifacts, planArtifact, previous: { runtime, bindings, migrations, pauseSchema } };
  if (!execution) {
    const evidence = await store.save("forward-recovery-plan.json", Buffer.from(JSON.stringify(plan)));
    check(equal(JSON.parse(await store.read(evidence)), plan), "sealed plan readback differs.");
    await inspectInterrupted();
    return { operation, releaseId, plan: evidence, admissionsPaused: true, deploymentPerformed: false, rollbackQualified: false };
  }
  const release = { ...plan, operation, environment: "development", accountId: authority.accountId, region: authority.region,
    planSha256: image.review.planSha256, reviewedPlan: reference.plan,
    previous: { ...plan.previous, worker: worker.before, consumer: worker.consumer } };
  return executeForwardRecovery({ cf, store, release, worker, image, authority, reference, now: dependencies.now, wait: dependencies.wait,
    verifyBefore: async () => { await inspectInterrupted(); await verifyRuntime(); },
    transfer: async saved => { await currentMain(); await inspectInterrupted(); await verifyRuntime(); control = await claimForwardRecovery({ cf, control, releaseId, sourceCommit: env.GITHUB_SHA,
      authority: reference.authority, plan: reference.plan, preparation: saved, now: (dependencies.now ?? Date.now)() }); return control; },
    beforeMutation: recovery.beforeMutation,
    imageApplied: () => { imageApplied = true; }, executorApplied: () => { executorDeployed = true; },
    inspectRuntime: runtimeRead, probeRuntime: dependencies.probeRuntime ?? (() => probeDevelopmentFunctions(env)),
    verifyStatus: dependencies.verifyStatus ?? (async () => {
      const status = await verifyDevelopmentPairStatus(env, candidate, releaseId);
      await inspectDevelopmentCloudflare(env);
      await enforceWorkerRelease({ enforcement: "1", apiUrl: env.WORKER_URL, sharedSecret: env.FOREVER_TEE_API_SHARED_SECRET });
      return { ...status, artworkMediaCapabilityVerified: true };
    }) });
}

export async function executeForwardRecovery({ cf, store, release, worker, image, verifyBefore, transfer, beforeMutation,
  imageApplied, executorApplied, inspectRuntime, probeRuntime, verifyStatus, now = Date.now, wait = setTimeout }) {
  await verifyBefore();
  const saved = await store.save("prepared.json", Buffer.from(JSON.stringify(release)));
  check(equal(JSON.parse(await store.read(saved)), release), "new complete preparation readback differs.");
  await recordReleaseEvent(cf, release.releaseId, "prepared", { ...release, preparation: saved }, now());
  const transferred = await transfer(saved);
  check(transferred?.release_id === release.releaseId && transferred.paused === 1, "exact transferred pause required.");
  await recordReleaseEvent(cf, release.releaseId, "forward-pause-transferred", { preparation: saved, reviewedPlan: release.reviewedPlan }, now());
  // A completely fresh all-family drain starts at the atomic ownership transfer.
  const drainClient = { ...cf, query: async (sql, params) => {
    if (/^UPDATE /.test(sql.trim())) await verifyBefore();
    return cf.query(sql, params);
  } };
  const drainDeadline = transferred.paused_at + 20 * 60_000;
  for (;;) {
    check(now() <= drainDeadline, "fresh full drain exceeded twenty minutes; admissions remain paused.");
    await verifyBefore();
    const drain = await inspectDevelopmentDrain(drainClient, release.releaseId, now());
    if (drain.drained) break;
    check(now() < drainDeadline, "fresh full drain exceeded twenty minutes; admissions remain paused.");
    await wait(Math.min(15000, drain.remainingMs, drainDeadline - now()));
  }
  await recordReleaseEvent(cf, release.releaseId, "drained", { minimumHoldMs: 300000, families: ["video", "print", "image", "artwork"] }, now());
  await beforeMutation("migration");
  await recordReleaseEvent(cf, release.releaseId, "forward-migration-started", { migration: NATIVE_MIGRATION_LATEST }, now());
  await worker.migrate(release.releaseId);
  await beforeMutation("pause-schema");
  await installPauseSchema(cf);
  await recordReleaseEvent(cf, release.releaseId, "migration-verified", { migration: NATIVE_MIGRATION_LATEST }, now());
  await beforeMutation("image-apply");
  await recordReleaseEvent(cf, release.releaseId, "image-apply-started", image.review, now());
  await image.apply(cf, release.releaseId);
  imageApplied();
  const runtime = await inspectRuntime();
  check(runtime.renderer.imageDigest === release.candidate.imageDigest && runtime.failure.imageDigest === release.candidate.imageDigest &&
    runtime.renderer.sourceDigest === release.candidate.sourceDigest, "new immutable Lambda pair differs.");
  await recordReleaseEvent(cf, release.releaseId, "image-verified", runtime, now());
  const startup = await probeRuntime();
  check(startup.startupVerified === true, "fresh startup probes required.");
  await recordReleaseEvent(cf, release.releaseId, "image-startup-verified", startup, now());
  await beforeMutation("executor-deploy");
  await recordReleaseEvent(cf, release.releaseId, "worker-deploy-started", worker.review, now());
  const live = await worker.deploy(release.releaseId, release.candidate, executorApplied);
  await recordReleaseEvent(cf, release.releaseId, "worker-verified", live, now());
  return resumeVerifiedRelease(cf, release.releaseId, async () => {
    await assertReleasePaused(cf, release.releaseId);
    await worker.verifyDeployed(live);
    const finalRuntime = await inspectRuntime();
    check(equal(finalRuntime, runtime), "runtime changed before final resume.");
    const status = await verifyStatus();
    await worker.verifyDeployed(live);
    await assertReleasePaused(cf, release.releaseId);
    return { releaseId: release.releaseId, sourceCommit: release.sourceCommit, candidate: release.candidate, worker: live,
      runtime: finalRuntime, status, forwardRecovery: { authority: release.authority, plan: release.reviewedPlan,
        interrupted: release.interrupted, rollbackQualified: false } };
  }, { expectedControl: transferred });
}
