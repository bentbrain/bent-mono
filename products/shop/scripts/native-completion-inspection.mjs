import { isDeepStrictEqual as equal } from "node:util";
import { readdir } from "node:fs/promises";
import { protectedConfig } from "./protected-config.mjs";
import { recoveryCheck as check, recoveryHash as hash, recoveryControl, validateForwardRecoverySnapshot } from "./native-forward-recovery-inspection.mjs";
import { forwardWorkerPlan } from "./native-forward-recovery.mjs";
import { inspectDevelopmentWorker, activeWorkerSettings, inspectDevelopmentConsumer } from "./native-ci-worker.mjs";
import { readSealedWorkerUpload, workerContentManifest, workerContentResponse, verifyWorkerUpload, verifyWorkerUploadEvidence } from "./native-worker-content.mjs";
import { verifyPrintExecutorSettings, verifyPrintExecutorConfig, verifyPrintExecutorLifecycle, verifyApiPrintExecutorBinding } from "./native-print-executor.mjs";
import { verifyPauseSchema } from "./native-release-pause.mjs";
import { isReviewedMigrationInventory } from "./native-migration-inventory.mjs";
import { failedRecoveryProvenance } from "./native-completion-authority.mjs";

const failedStages = ["prepared", "forward-pause-transferred", "drained", "forward-migration-started", "migration-verified", "image-apply-started", "image-verified", "image-startup-verified", "worker-deploy-started", "print-staging-lifecycle-started", "print-staging-lifecycle-verified", "print-executor-deploy-started"].sort();
const read = async (store, reference) => {
  const bytes = await store.read(reference);
  check(hash(bytes) === reference.sha256, "immutable completion input changed.");
  return JSON.parse(bytes);
};
export async function completionInputs(store, authority) {
  const original = await read(store, authority.originalAuthority), plan = await read(store, authority.originalPlan), prepared = await read(store, authority.failedPreparation);
  check(original.kind === "development-interrupted-forward-release-v1" && original.sourceCommit === authority.applicationSourceCommit &&
    original.original?.repository === protectedConfig("developmentForwardRecoveryOriginalRepository") && original.original.repository !== "bentbrain/bent-mono" &&
    String(original.original.repositoryId) === protectedConfig("developmentForwardRecoveryOriginalRepositoryId") &&
    String(original.original.ownerId) === protectedConfig("githubOwnerId") &&
    original.accountId === authority.accountId && original.cloudflareAccountId === authority.cloudflareAccountId && original.region === authority.region &&
    original.environment === "development", "original foreign-repository authority remains required.");
  validateForwardRecoverySnapshot(await read(store, original.snapshot), original);
  const releaseId = `native-${authority.failedRunId}`;
  check(prepared.operation === "recover-forward-release" && prepared.releaseId === releaseId && prepared.sourceCommit === authority.applicationSourceCommit &&
    prepared.environment === "development" && prepared.accountId === authority.accountId && prepared.region === authority.region &&
    equal(prepared.authority, authority.originalAuthority) && equal(prepared.reviewedPlan, authority.originalPlan) &&
    plan.operation === "plan-forward-recovery" && plan.sourceCommit === authority.applicationSourceCommit && equal(plan.authority, authority.originalAuthority) &&
    equal(plan.interrupted, prepared.interrupted) && equal(plan.candidate, prepared.candidate) && equal(plan.image, prepared.image) &&
    equal(forwardWorkerPlan(plan.worker, plan.releaseId), forwardWorkerPlan(prepared.worker, releaseId)) &&
    plan.planArtifact.sha256 === prepared.planArtifact.sha256, "exact failed preparation and original reviewed full plan required.");
  check(plan.previous.runtime.runtimeVerified === true && prepared.interrupted.owner === original.control.release_id &&
    prepared.interrupted.namespaceId === original.namespaceId, "original interrupted ownership required.");
  await store.read(prepared.planArtifact);
  const uploads = {};
  for (const [name, review, artifacts, plannedReview, plannedArtifacts] of [
    ["api", prepared.worker, prepared.artifacts, plan.worker, plan.artifacts],
    ["executor", prepared.worker.printExecutor, prepared.artifacts.printExecutor, plan.worker.printExecutor, plan.artifacts.printExecutor],
  ]) {
    const upload = await readSealedWorkerUpload(store, artifacts, review), planned = await readSealedWorkerUpload(store, plannedArtifacts, plannedReview);
    check(equal(upload.code, planned.code) && equal(upload.map, planned.map) && upload.map, "exact original raw code and map artifacts required.");
    // A separately approved V3 seal is derived from exact V2 artifacts. The V2
    // record remains unchanged and continues to enforce raw byte equality.
    const content = await workerContentManifest(workerContentResponse(upload), { sourceMapData: true });
    uploads[name] = { ...review, schemaVersion: 3, content };
  }
  check(equal(await read(store, prepared.artifacts.printExecutor.foundationArtifact), prepared.worker.printExecutor), "original executor foundation changed.");
  return { original, plan, prepared, uploads };
}
async function completionJournals(cf, inputs, authority, extra = []) {
  const owner = inputs.prepared.releaseId, oldOwner = inputs.original.control.release_id;
  const journals = {};
  for (const [key, releaseId] of [["failed", owner], ["original", oldOwner]]) {
    const rows = (await cf.query("SELECT stage, payload, created_at FROM native_video_release_events WHERE release_id = ? ORDER BY stage", [releaseId]))[0].results;
    check(new Set(rows.map(row => row.stage)).size === rows.length, "ambiguous release journals.");
    if (key === "failed") {
      for (const event of extra) check(equal(rows.find(row => row.stage === event.stage), event), "completion journal changed.");
      journals[key] = rows.filter(row => !extra.some(event => event.stage === row.stage));
      check(equal(journals[key].map(row => row.stage).sort(), failedStages), "failed recovery advanced beyond the executor verification boundary.");
    } else journals[key] = rows;
  }
  const event = stage => JSON.parse(journals.failed.find(row => row.stage === stage).payload);
  const { preparation, ...prepared } = event("prepared");
  check(equal(preparation, authority.failedPreparation) && equal(prepared, inputs.prepared), "failed D1 and immutable preparation disagree.");
  const claims = journals.original.filter(row => row.stage === "forward-recovery-claimed");
  check(claims.length === 1, "original consumed claim required.");
  const claim = JSON.parse(claims[0].payload);
  check(claim.releaseId === owner && claim.sourceCommit === authority.applicationSourceCommit &&
    equal(claim.control, inputs.original.control) && equal(claim.authority, authority.originalAuthority) && equal(claim.plan, authority.originalPlan) &&
    equal(claim.preparation, authority.failedPreparation) && Number.isSafeInteger(claim.pausedAt), "consumed claim provenance differs.");
  check(equal(event("forward-pause-transferred"), { preparation: authority.failedPreparation, reviewedPlan: authority.originalPlan }) &&
    equal(event("worker-deploy-started"), inputs.prepared.worker) &&
    equal(event("print-executor-deploy-started"), { review: inputs.prepared.worker.printExecutor, artifacts: inputs.prepared.artifacts.printExecutor }) &&
    equal(event("image-apply-started"), inputs.prepared.image) && event("image-startup-verified").startupVerified === true,
    "original image, startup and executor intents required.");
  const control = { ...claim.control, release_id: owner, paused_at: claim.pausedAt, updated_at: claim.pausedAt };
  return { journals, control, stagingEvidence: event("print-staging-lifecycle-verified").evidence, runtime: event("image-verified"), startup: event("image-startup-verified") };
}
export async function inspectCompletionState({ cf, client, staging, store, authority, inputs, runtimeRead, bindingsRead, runRead, extra = [], liveApi, env = process.env }) {
  const evidence = await completionJournals(cf, inputs, authority, extra), control = await recoveryControl(cf);
  check(equal(control, evidence.control), "exact failed-owner pause tuple changed.");
  await verifyPauseSchema(cf);
  const { prepared, uploads } = inputs;
  const migrations = (await cf.query("SELECT name FROM d1_migrations ORDER BY name"))[0].results.map(row => row.name);
  const expected = (await readdir(new URL("../workers/api/drizzle/", import.meta.url))).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  check(isReviewedMigrationInventory(expected) && equal(migrations, expected), "complete current reviewed migrations required.");
  const schema = (await cf.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name"))[0].results;
  check(schema.length > 0, "complete schema unavailable.");
  const api = await inspectDevelopmentWorker(cf, undefined, liveApi ? uploads.api : undefined), executor = await inspectDevelopmentWorker(client, undefined, uploads.executor);
  await verifyWorkerUploadEvidence(executor.content, uploads.executor, { store, env, filename: "completion-executor-content-diagnostic.json" });
  const apiSettings = await activeWorkerSettings(cf, api), executorSettings = await activeWorkerSettings(client, executor);
  verifyPrintExecutorConfig(uploads.executor.config);
  const namespace = verifyPrintExecutorSettings(executorSettings, uploads.executor);
  check(namespace.namespaceId === inputs.original.namespaceId, "existing private executor namespace changed.");
  verifyApiPrintExecutorBinding(apiSettings, namespace);
  const executorLifecycle = verifyPrintExecutorLifecycle(await client.version(executor.workerVersion), executor.workerVersion), privateEndpoint = await client.subdomain();
  check(privateEndpoint.enabled === false && privateEndpoint.previews_enabled === false, "executor endpoint must remain private.");
  if (liveApi) {
    verifyWorkerUpload(api.content, uploads.api);
    check(equal(api, liveApi) && equal(apiSettings, authority.expectedApiSettings), "deployed API complete content, version or full settings changed.");
  } else check(equal(api, prepared.previous.worker) && equal(api, inputs.original.observed.api), "API predecessor changed.");
  const consumer = await inspectDevelopmentConsumer(cf), schedules = await cf.schedules(), stagingLifecycle = await staging.read();
  check(equal(consumer, prepared.previous.consumer) && equal(schedules, inputs.original.schedules) &&
    equal(stagingLifecycle, uploads.executor.stagingLifecycle.after) && uploads.executor.stagingLifecycle.mutationRequired === false, "queue, schedules or staging lifecycle changed.");
  const stagingEvidence = JSON.parse(await store.read(evidence.stagingEvidence));
  check(equal(stagingEvidence, { sourceCommit: prepared.sourceCommit, releaseId: prepared.releaseId,
    before: uploads.executor.stagingLifecycle.before, reviewed: uploads.executor.stagingLifecycle.after, after: stagingLifecycle }), "verified staging evidence changed.");
  const runtime = await runtimeRead();
  check(equal(runtime, evidence.runtime) && runtime.runtimeVerified === true && runtime.environment === "development" &&
    runtime.renderer.imageDigest === prepared.candidate.imageDigest && runtime.failure.imageDigest === prepared.candidate.imageDigest &&
    runtime.renderer.sourceDigest === prepared.candidate.sourceDigest && prepared.candidate.candidateVerified === true && prepared.candidate.reused === true,
    "already-applied immutable candidate runtime changed.");
  const state = { schemaVersion: 1, run: failedRecoveryProvenance(await runRead(), authority), control, journals: evidence.journals,
    api, executor, apiSettings, executorSettings, latestApiSettings: await cf.settings(), latestExecutorSettings: await client.settings(),
    consumer, schedules, stagingLifecycle, stagingEvidence: evidence.stagingEvidence, executorLifecycle, privateEndpoint,
    runtime, startup: evidence.startup, migrations, schema, bindings: await bindingsRead(), uploads };
  check(equal(await recoveryControl(cf), control) && equal(await inspectDevelopmentWorker(client, undefined, uploads.executor), executor) &&
    equal(await inspectDevelopmentWorker(cf, undefined, liveApi ? uploads.api : undefined), api), "provider state changed during completion inspection.");
  return state;
}

// Verification only. Running or expired attempts require a separate reviewed
// procedure; this continuation never recovers leases or replays a drain.
export async function verifyCompletionDrain(cf, control, now = Date.now()) {
  check(equal(await recoveryControl(cf), control) && control.paused === 1 && now >= control.paused_at + 300_000, "exact held pause required for fresh drain.");
  for (const sql of [
    "SELECT count(*) AS count FROM story_video_jobs WHERE status = 'rendering'",
    "SELECT count(*) AS count FROM print_asset_jobs WHERE status = 'running'",
    "SELECT count(*) AS count FROM product_image_jobs WHERE status = 'rendering'",
    "SELECT count(*) AS count FROM artwork_preparation_jobs WHERE status = 'processing'",
  ]) {
    const rows = (await cf.query(sql))[0].results;
    check(rows.length === 1 && rows[0].count === 0, "active or expired execution requires independent drain recovery; admissions remain paused.");
  }
  check(equal(await recoveryControl(cf), control), "pause changed during fresh drain inspection.");
}
