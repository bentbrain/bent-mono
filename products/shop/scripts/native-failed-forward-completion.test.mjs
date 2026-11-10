import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderWranglerConfig } from "./deployment-config.mjs";
import { prepareCompletionApi } from "./native-completion-worker.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import test from "node:test";
import { resolveProtectedTemplate } from "./protected-config.mjs";
import { workerContentManifest, workerContentResponse } from "./native-worker-content.mjs";
import { inspectDevelopmentWorker, developmentReleaseVariables } from "./native-ci-worker.mjs";
import { planPrintStagingLifecycle } from "./native-print-staging-lifecycle.mjs";
import { installPauseSchema } from "./native-release-pause.mjs";
import { recoveryHash as hash, recoveryControl } from "./native-forward-recovery-inspection.mjs";
import { completionEffects, validateCompletionAuthority, failedRecoveryProvenance } from "./native-completion-authority.mjs";
import { completionInputs, inspectCompletionState, verifyCompletionDrain } from "./native-completion-inspection.mjs";
import { claimFailedRecoveryCompletion } from "./native-completion-claim.mjs";
import { runFailedForwardCompletion } from "./native-failed-forward-completion.mjs";
import { loadDevelopmentPreparation } from "./native-development-preparation.mjs";
import { verifyRecordedPrintExecutor } from "./native-print-executor.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { offlinePreflight } from "./release-preflight.mjs";
import { sealDispatchInputs, resolveDispatchInputs } from "./release-dispatch-inputs.mjs";

const app = "a".repeat(40), tool = "c".repeat(40), oldOwner = "native-101", failedOwner = "native-304", namespaceId = "e".repeat(32);
async function fixture(t, { mapBytes = 0 } = {}) {
  const previousConfig = process.env.SHOP_PROTECTED_CONFIG_JSON;
  t.after(() => { process.env.SHOP_PROTECTED_CONFIG_JSON = previousConfig; });
  const config = JSON.parse(previousConfig), db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE story_video_jobs(id TEXT, status TEXT, attempt_count INTEGER, renderer_version TEXT, updated_at INTEGER, last_error TEXT);
    CREATE TABLE print_asset_jobs(id TEXT, status TEXT, attempt_count INTEGER, lease_id TEXT, next_attempt_at INTEGER, updated_at INTEGER);
    CREATE TABLE product_image_jobs(id TEXT, status TEXT, attempt_count INTEGER, updated_at INTEGER);
    CREATE TABLE artwork_preparation_jobs(id TEXT, status TEXT, attempts INTEGER, lease_token TEXT, next_attempt_at INTEGER, updated_at INTEGER);
    CREATE TABLE d1_migrations(name TEXT);`);
  const calls = [], state = { apiDeployed: false, mapChanged: false, lostClaim: false, lostResume: false };
  const query = async (sql, params = []) => {
    calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
    const statement = db.prepare(sql), result = statement.columns().length ? { results: statement.all(...params).map(row => ({ ...row })) }
      : { results: [], meta: statement.run(...params) };
    if (state.lostClaim && sql.includes("SELECT ?, ?, ?, ? WHERE EXISTS")) throw Error("claim acknowledgement lost");
    if (state.lostResume && sql.includes("SET paused = 0")) throw Error("resume acknowledgement lost");
    return [result];
  };
  const cf = { query };
  await installPauseSchema(cf);
  for (const name of (await readdir(new URL("../workers/api/drizzle/", import.meta.url))).filter(name => /^\d{4}_.+\.sql$/.test(name))) db.prepare("INSERT INTO d1_migrations VALUES (?)").run(name);
  const time = Date.now() - 600_000, oldControl = { paused: 1, release_id: oldOwner, current_release_id: "native-100", paused_at: time - 1, updated_at: time - 1 },
    control = { ...oldControl, release_id: failedOwner, paused_at: time, updated_at: time };
  db.prepare("UPDATE native_video_release_control SET paused=1,release_id=?,current_release_id=?,paused_at=?,updated_at=?").run(failedOwner, control.current_release_id, time, time);
  const saved = new Map();
  const save = async (id, name, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)), key = `source/releases/${id}/${name}`;
    assert.ok(!saved.has(key)); saved.set(key, bytes);
    return { key, version: "synthetic-version", sha256: hash(bytes) };
  };
  const store = { read: async ref => { const bytes = saved.get(ref.key); assert.ok(bytes, ref.key); assert.equal(hash(bytes), ref.sha256); return bytes; },
    save: (name, bytes) => save("native-401", name, bytes) };
  const code = Buffer.from('export const capability="owner-artwork-media-v1";export default {}'), map = Buffer.from(JSON.stringify({ version: 3, file: "index.js", sources: ["synthetic.ts"], sourcesContent: ["export default {}"], names: [], mappings: "" }).padEnd(mapBytes)),
    content = await workerContentManifest(workerContentResponse({ code, map }));
  const temporary = await mkdtemp(join(tmpdir(), "completion-test-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const rendered = await renderWranglerConfig(fileURLToPath(new URL("../workers/api/wrangler.jsonc", import.meta.url)), join(temporary, "api.json"));
  const uploadReview = { schemaVersion: 2, sourceCommit: app, bundleSha256: content.modules[0].sha256, bundleBytes: code.length, content };
  const configSource = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../workers/print-executor/wrangler.jsonc", import.meta.url))));
  const stagingState = planPrintStagingLifecycle({ rules: [] }).after, stagingLifecycle = planPrintStagingLifecycle(stagingState), staging = { read: async () => stagingState };
  const executorReview = id => ({ ...uploadReview, releaseId: id, worker: "forever-tee-print-executor-development", accountId: config.cloudflareAccountId,
    configSha256: "d".repeat(64), config: configSource, migrations: configSource.migrations, before: { interrupted: { owner: oldOwner, namespaceId } }, stagingLifecycle });
  const executorSettings = { compatibility_date: "2026-08-12", compatibility_flags: ["nodejs_compat"], migration_tag: "print-execution-v1", bindings: [
    { name: "DB", type: "d1", id: config.resource_fb377032d2f5 }, { name: "DESIGN_ARTWORK", type: "r2_bucket", bucket_name: "forever-tee-design-artwork-development" },
    { name: "IMAGES", type: "images" }, { name: "PRINT_EXECUTIONS", type: "durable_object_namespace", class_name: "PrintAssetExecution", namespace_id: namespaceId },
    ...Object.entries({ PRINT_EXECUTOR_SOURCE_COMMIT: app, PRINT_EXECUTOR_CONFIG_SHA256: "d".repeat(64), PRINT_EXECUTOR_BUNDLE_SHA256: uploadReview.bundleSha256,
      PRINT_EXECUTION_RELEASE_ID: failedOwner }).map(([name, text]) => ({ name, type: "plain_text", text })) ] };
  const oldApiSettings = { bindings: [{ name: "PRINT_EXECUTION_MODE", type: "plain_text", text: "durable-object" },
    { name: "PRINT_EXECUTIONS", type: "durable_object_namespace", class_name: "PrintAssetExecution", script_name: executorReview(failedOwner).worker, namespace_id: namespaceId }] };
  let nextApiSettings;
  const response = () => workerContentResponse({ code, map: Buffer.from(JSON.stringify(Object.fromEntries(Object.entries({ ...JSON.parse(map), ...(state.mapChanged ? { mappings: "AAAA" } : {}) }).reverse()), null, 2)) });
  const provider = (settings, id, response, deploymentId = () => "66666666-6666-4666-8666-666666666666") => ({ settings: async () => settings(), deployments: async () => ({ deployments: [{ id: deploymentId(), versions: [{ version_id: id(), percentage: 100 }] }] }),
    versions: async () => ({ items: [{ id: id() }] }), version: async versionId => { const { bindings, ...script_runtime } = settings(); return { id: versionId, resources: { bindings, script_runtime } }; }, content: async () => response() });
  Object.assign(cf, provider(() => state.apiDeployed ? nextApiSettings : oldApiSettings, () => state.apiDeployed ? "33333333-3333-4333-8333-333333333333" : "22222222-2222-4222-8222-222222222222", () => state.apiDeployed ? response() : new Response("synthetic predecessor"),
    () => state.apiDeployed ? "55555555-5555-4555-8555-555555555555" : "44444444-4444-4444-8444-444444444444"));
  const client = { ...provider(() => executorSettings, () => "11111111-1111-4111-8111-111111111111", response), subdomain: async () => ({ enabled: false, previews_enabled: false }) };
  const api = await inspectDevelopmentWorker(cf), consumer = { consumerId: "f".repeat(32), settings: { batch_size: 1, max_retries: 100, max_wait_time_ms: 1000, max_concurrency: 2, retry_delay: 10 } }, schedules = { schedules: [{ cron: "* * * * *" }] };
  cf.consumers = async () => [{ type: "worker", script: "forever-tee-api-development", consumer_id: consumer.consumerId, settings: consumer.settings }]; cf.schedules = async () => schedules;
  const candidate = { environment: "development", imageDigest: `sha256:${"b".repeat(64)}`, sourceDigest: "f".repeat(64), candidateVerified: true, reused: true, verifiedForCommit: app };
  const runtime = { runtimeVerified: true, environment: "development", renderer: { imageDigest: candidate.imageDigest, sourceDigest: candidate.sourceDigest }, failure: { imageDigest: candidate.imageDigest } };
  const originalRun = { id: 101, run_attempt: 1, status: "completed", conclusion: "failure", event: "workflow_dispatch", head_branch: "main", head_sha: "b".repeat(40),
    path: ".github/workflows/native-development.yml", repository: { full_name: "fixtures/retired-release", id: 70001, owner: { id: Number(config.githubOwnerId) } }, head_repository: { id: 70001 },
    display_title: `Native development · release · full · - · - · main · ${"b".repeat(40)} · synthetic` };
  const original = { kind: "development-interrupted-forward-release-v1", sourceCommit: app, control: oldControl, original: { repository: originalRun.repository.full_name,
    repositoryId: originalRun.repository.id, ownerId: originalRun.repository.owner.id, sourceCommit: originalRun.head_sha, runId: 101 }, environment: "development", accountId: config.awsAccountId,
    cloudflareAccountId: config.cloudflareAccountId, region: "ap-southeast-2", namespaceId, observed: { api }, schedules,
    snapshot: await save("native-201", "forward-recovery-snapshot.json", { schemaVersion: 1, authentication: { method: "personal-github-api", repository: originalRun.repository.full_name, repositoryId: 70001 },
      run: originalRun, operation: "release", releaseMode: "full", prepared: {}, executorIntent: {}, workerIntent: {} }) };
  const originalAuthority = await save("native-201", "forward-recovery-authority.json", original);
  const makeArtifacts = async id => ({ candidateArtifact: await save(id, "candidate-worker.js", code), candidateMapArtifact: await save(id, "candidate-worker-map.json", map),
    printExecutor: { candidateArtifact: await save(id, "candidate-print-executor.js", code), candidateMapArtifact: await save(id, "candidate-print-executor-map.json", map),
      foundationArtifact: await save(id, "print-executor-foundation.json", executorReview(id)) } });
  const plan = { schemaVersion: 1, operation: "plan-forward-recovery", releaseId: "native-302", sourceCommit: app, authority: originalAuthority,
    interrupted: { owner: oldOwner, namespaceId }, candidate, worker: { ...uploadReview, configuration: { api: rendered.resolvedSha256 }, printExecutor: executorReview("native-302") },
    image: { planSha256: hash("synthetic plan") }, artifacts: await makeArtifacts("native-302"), planArtifact: await save("native-302", "candidate.tfplan", Buffer.from("synthetic plan")), previous: { runtime } };
  const originalPlan = await save("native-302", "forward-recovery-plan.json", plan);
  const prepared = { ...plan, operation: "recover-forward-release", releaseId: failedOwner, environment: "development", accountId: config.awsAccountId, region: "ap-southeast-2",
    reviewedPlan: originalPlan, worker: { ...plan.worker, printExecutor: executorReview(failedOwner) }, artifacts: await makeArtifacts(failedOwner), previous: { runtime, worker: api, consumer } };
  const failedPreparation = await save(failedOwner, "prepared.json", prepared);
  const stagingEvidence = await save(failedOwner, "print-staging-lifecycle.json", { sourceCommit: app, releaseId: failedOwner, before: stagingState, reviewed: stagingState, after: stagingState });
  const event = (owner, stage, value) => db.prepare("INSERT INTO native_video_release_events(release_id,stage,payload,created_at) VALUES (?,?,?,?)").run(owner, stage, JSON.stringify(value), time);
  event(oldOwner, "forward-recovery-claimed", { releaseId: failedOwner, sourceCommit: app, authority: originalAuthority, plan: originalPlan, preparation: failedPreparation, control: oldControl, pausedAt: time });
  for (const [stage, payload] of Object.entries({ prepared: { ...prepared, preparation: failedPreparation }, "forward-pause-transferred": { preparation: failedPreparation, reviewedPlan: originalPlan },
    drained: {}, "forward-migration-started": {}, "migration-verified": {}, "image-apply-started": plan.image, "image-verified": runtime, "image-startup-verified": { startupVerified: true },
    "worker-deploy-started": prepared.worker, "print-staging-lifecycle-started": {}, "print-staging-lifecycle-verified": { evidence: stagingEvidence },
    "print-executor-deploy-started": { review: prepared.worker.printExecutor, artifacts: prepared.artifacts.printExecutor } })) event(failedOwner, stage, payload);
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: config.githubRepositoryId, GITHUB_REPOSITORY_OWNER_ID: config.githubOwnerId,
    GITHUB_REF: "refs/heads/main", GITHUB_SHA: tool, GITHUB_RUN_ID: "401", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main", NATIVE_OPERATION: "stage-forward-completion-authority", NATIVE_RELEASE_MODE: "full", WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev", RUNNER_TEMP: temporary, PATH: process.env.PATH, SHOP_EVIDENCE_ENCRYPTION_KEY: process.env.SHOP_EVIDENCE_ENCRYPTION_KEY, SHOP_EVIDENCE_KEY_VERSION: process.env.SHOP_EVIDENCE_KEY_VERSION, NATIVE_CANDIDATE_RECEIPT: "{}" };
  for (const name of ["CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET", "PRODUCT_IMAGE_RENDERER_BYPASS_SECRET"]) env[name] = "synthetic-".padEnd(64, "x");
  nextApiSettings = { bindings: [...oldApiSettings.bindings.filter(binding => binding.name !== "PRINT_EXECUTION_MODE"),
    ...Object.entries(developmentReleaseVariables(env, candidate, failedOwner, app)).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...["SHOP_PROTECTED_CONFIG_JSON", "CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET", "PRODUCT_IMAGE_RENDERER_BYPASS_SECRET"].map(name => ({ name, type: "secret_text" }))] };
  const authority = { schemaVersion: 1, kind: "development-failed-forward-completion-v1", environment: "development", accountId: config.awsAccountId, region: "ap-southeast-2", cloudflareAccountId: config.cloudflareAccountId,
    toolSourceCommit: tool, applicationSourceCommit: app, failedRunId: "304", failedAttempt: 1, originalAuthority, originalPlan, failedPreparation,
    allowedEffects: completionEffects, snapshot: { sha256: "0".repeat(64) }, expectedApiSettings: nextApiSettings, expectedApiLatestSettings: nextApiSettings };
  const run = { ...originalRun, id: 304, head_sha: app, repository: { full_name: env.GITHUB_REPOSITORY, id: Number(config.githubRepositoryId), owner: { id: Number(config.githubOwnerId) } }, head_repository: { id: Number(config.githubRepositoryId) },
    display_title: `Native development · recover-forward-release · full · - · - · main · ${app} · synthetic` };
  Object.assign(config, { developmentForwardRecoverySourceCommit: app, developmentForwardRecoveryOriginalRepository: originalRun.repository.full_name, developmentForwardRecoveryOriginalRepositoryId: "70001",
    developmentForwardRecoveryAuthoritySha256: originalAuthority.sha256, developmentForwardRecoveryPlanSha256: originalPlan.sha256,
    developmentCompletionSourceCommit: tool, developmentCompletionFailedRunId: "304" });
  const install = () => { process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(config); }; install();
  const inputs = await completionInputs(store, authority), dependencies = { cf, client, staging, store, currentMain: async () => { calls.push("current-main"); },
    identity: async context => ({ signatureVerified: true, sourceCommit: context.GITHUB_SHA, runId: context.GITHUB_RUN_ID }), runtimeRead: async () => runtime,
    bindingsRead: async () => {
      const active = (await cf.deployments()).deployments[0];
      return { cloudflareVerified: true, environment: "development", workerVersion: active.versions[0].version_id, deploymentId: active.id,
        executionFencePresent: true, jobCounts: (await cf.query("SELECT status, COUNT(*) AS count FROM story_video_jobs GROUP BY status"))[0].results,
        applicationMutations: false };
    }, runRead: async () => run,
    candidate: async () => ({ ...candidate, verifiedForCommit: tool }), verifyStatus: async () => ({ protocolVerified: true, artworkMediaCapabilityVerified: true }),
    worker: async () => ({ deploy: async before => { await before(); calls.push("upload-api"); state.apiDeployed = true; return inspectDevelopmentWorker(cf, undefined, inputs.uploads.api); } }) };
  const snapshot = await inspectCompletionState({ ...dependencies, authority, inputs });
  inputs.state = snapshot;
  authority.snapshot.sha256 = hash(JSON.stringify(snapshot)); config.developmentCompletionSnapshotSha256 = authority.snapshot.sha256;
  env.NATIVE_COMPLETION_PACKAGE = JSON.stringify({ schemaVersion: 1, authority }); config.developmentCompletionPackageSha256 = hash(env.NATIVE_COMPLETION_PACKAGE); install();
  const stage = () => runFailedForwardCompletion(env, dependencies);
  const execution = async () => {
    const staged = await stage(); config.developmentCompletionAuthoritySha256 = staged.reference.authority.sha256; install();
    return { ...env, GITHUB_RUN_ID: "402", NATIVE_OPERATION: "complete-forward-release", NATIVE_COMPLETION_PACKAGE: "", NATIVE_COMPLETION_REFERENCE: JSON.stringify(staged.reference) };
  };
  // Execute with a distinct current tool-run store while preserving staged refs.
  const execute = async context => runFailedForwardCompletion(context, { ...dependencies, store: { ...store, save: (name, bytes) => save(`native-${context.GITHUB_RUN_ID}`, name, bytes) } });
  calls.length = 0;
  return { db, cf, client, store, saved, state, calls, env, config, authority, run, inputs, snapshot, dependencies, install, stage, execution, execute, control, event };
}

test("completion stages separately approved immutable state, then uploads only the original API under the failed generation", async t => {
  const f = await fixture(t), context = await f.execution();
  assert.equal(f.calls.includes("upload-api"), false);
  assert.deepEqual(await recoveryControl(f.cf), f.control);
  const originalPrepared = f.saved.get(f.authority.failedPreparation.key);
  const result = await f.execute(context);
  assert.equal(result.releaseId, failedOwner); assert.equal(result.sourceCommit, app); assert.equal(result.completion.toolIdentity.sourceCommit, tool);
  assert.equal(result.rollbackQualified, false); assert.equal(f.calls.filter(call => call === "upload-api").length, 1);
  assert.equal((await recoveryControl(f.cf)).paused, 0); assert.equal((await recoveryControl(f.cf)).current_release_id, failedOwner);
  assert.notEqual(result.worker.workerVersion, f.snapshot.bindings.workerVersion);
  assert.equal(f.saved.get(f.authority.failedPreparation.key), originalPrepared);
  const prepared = await loadDevelopmentPreparation(f.cf, f.store, failedOwner);
  assert.equal(prepared.worker.schemaVersion, 3); assert.equal(prepared.worker.printExecutor.schemaVersion, 3);
  const recorded = await verifyRecordedPrintExecutor({ env: context, api: f.cf, prepared, store: f.store, client: f.client, inspectWorker: inspectDevelopmentWorker,
    staging: { read: async () => f.snapshot.stagingLifecycle } });
  assert.equal(recorded.worker.content.sourceMapData.algorithm, "complete-json-data-v1");
  f.client.versions = async () => ({ items: [{ id: "44444444-4444-4444-8444-444444444444" }] });
  await verifyRecordedPrintExecutor({ env: context, api: f.cf, prepared, store: f.store, client: f.client, inspectWorker: inspectDevelopmentWorker,
    staging: { read: async () => f.snapshot.stagingLifecycle } });
  assert.equal(f.calls.some(sql => /^(?:UPDATE (?:story|product|artwork)|CREATE)/.test(sql)), false);
});

test("completion stages V3 evidence for sealed maps above ten megabytes without changing raw artifacts", async t => {
  const f = await fixture(t, { mapBytes: 10_000_001 });
  const reference = f.inputs.prepared.artifacts.candidateMapArtifact;
  const original = Buffer.from(await f.store.read(reference));
  assert.equal(original.byteLength, 10_000_001);
  assert.equal(f.inputs.uploads.api.content.modules.find(part => part.name === "index.js.map").bytes, original.byteLength);
  const result = await f.stage();
  assert.equal(result.deploymentPerformed, false);
  assert.deepEqual(await recoveryControl(f.cf), f.control);
  assert.deepEqual(await f.store.read(reference), original);
  assert.equal(f.calls.includes("upload-api"), false);
});

test("post-upload binding summaries preserve every field except the verified new deployment identities", async t => {
  for (const patch of [
    { workerVersion: "77777777-7777-4777-8777-777777777777" },
    { deploymentId: "44444444-4444-4444-8444-444444444444" },
    { deploymentId: "not-a-deployment" },
    { cloudflareVerified: false }, { environment: "production" }, { executionFencePresent: false },
    { jobCounts: [{ status: "rendering", count: 1 }] }, { applicationMutations: true }, { unexpected: true },
  ]) {
    const f = await fixture(t), context = await f.execution(), read = f.dependencies.bindingsRead;
    f.dependencies.bindingsRead = async () => ({ ...await read(), ...(f.state.apiDeployed ? patch : {}) });
    await assert.rejects(f.execute(context));
    assert.equal(f.calls.filter(call => call === "upload-api").length, 1);
    assert.deepEqual(await recoveryControl(f.cf), f.control);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='completion-attempt-one-claimed'").get().n, 1);
  }
});

test("completion rejects an API deployment change during binding inspection", async t => {
  const f = await fixture(t), context = await f.execution(), read = f.dependencies.bindingsRead, deployments = f.cf.deployments;
  f.dependencies.bindingsRead = async () => {
    const result = await read();
    if (f.state.apiDeployed) f.cf.deployments = async () => {
      const value = await deployments();
      value.deployments[0].id = "88888888-8888-4888-8888-888888888888";
      return value;
    };
    return result;
  };
  await assert.rejects(f.execute(context), /binding-summary deployment changed/);
  assert.deepEqual(await recoveryControl(f.cf), f.control);
  assert.equal(f.calls.filter(call => call === "upload-api").length, 1);
});

test("completion rejects a new API version reported under the predecessor deployment ID", async t => {
  const f = await fixture(t), context = await f.execution(), deployments = f.cf.deployments;
  f.cf.deployments = async () => {
    const value = await deployments();
    value.deployments[0].id = f.snapshot.bindings.deploymentId;
    return value;
  };
  await assert.rejects(f.execute(context), /verified new API deployment/);
  assert.deepEqual(await recoveryControl(f.cf), f.control);
  assert.equal(f.calls.filter(call => call === "upload-api").length, 1);
});

test("completion pins the first verified deployment through the final status check", async t => {
  const f = await fixture(t), context = await f.execution(), deployments = f.cf.deployments;
  f.dependencies.verifyStatus = async () => {
    f.cf.deployments = async () => {
      const value = await deployments();
      value.deployments[0].id = "99999999-9999-4999-8999-999999999999";
      return value;
    };
    return { protocolVerified: true, artworkMediaCapabilityVerified: true };
  };
  await assert.rejects(f.execute(context), /approved current state changed/);
  assert.deepEqual(await recoveryControl(f.cf), f.control);
  assert.equal(f.calls.filter(call => call === "upload-api").length, 1);
});

test("completion rejects altered authority, source, failed provenance and operation boundaries", async t => {
  const f = await fixture(t);
  validateCompletionAuthority(f.authority, f.env, { staged: false });
  for (const change of [{ failedAttempt: 2 }, { failedRunId: "999" }, { applicationSourceCommit: tool }, { toolSourceCommit: app }, { allowedEffects: [...completionEffects, "executor-upload"] }, { extra: true }])
    assert.throws(() => validateCompletionAuthority({ ...f.authority, ...change }, f.env, { staged: false }));
  for (const change of [{ run_attempt: 2 }, { conclusion: "success" }, { head_sha: tool }, { event: "push" }, { path: ".github/workflows/native-production.yml" }, { display_title: f.run.display_title.replace("recover-forward-release", "release") }])
    assert.throws(() => failedRecoveryProvenance({ ...f.run, ...change }, f.authority));
  for (const change of [{ GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_EVENT_NAME: "push" }, { NATIVE_RELEASE_MODE: "api" }, { GITHUB_REF: "refs/heads/feature" }, { GITHUB_WORKFLOW_REF: "foreign" }])
    assert.throws(() => developmentOperation({ ...f.env, ...change }));
  const sealed = sealDispatchInputs({ completion_reference: JSON.stringify({ schemaVersion: 1, authority: { key: "source/releases/native-401/completion-authority.json", version: "v1", sha256: "a".repeat(64) } }) }, tool);
  const envelope = { ...process.env, GITHUB_SHA: tool, NATIVE_COMPLETION_REFERENCE: sealed.completion_reference }; resolveDispatchInputs(envelope);
  assert.ok(envelope.NATIVE_COMPLETION_REFERENCE.includes("completion-authority.json"));
  assert.throws(() => resolveDispatchInputs({ GITHUB_SHA: app, NATIVE_COMPLETION_REFERENCE: sealed.completion_reference }));
  const preflight = offlinePreflight({ environment: "development", lane: "native", operation: f.env.NATIVE_OPERATION, ref: f.env.GITHUB_REF, sha: tool,
    migrations: f.snapshot.migrations, completionPackage: f.env.NATIVE_COMPLETION_PACKAGE });
  assert.equal(preflight.passed, true);
});

test("state changes, executor map changes and progressed journals stop completion before claim or upload", async t => {
  for (const mutate of [f => { f.state.mapChanged = true; }, f => { f.db.exec("UPDATE native_video_release_control SET updated_at=updated_at+1"); },
    f => f.event(failedOwner, "worker-verified", {}), f => { f.db.exec("DELETE FROM d1_migrations WHERE name=(SELECT max(name) FROM d1_migrations)"); },
    f => { f.db.exec("CREATE TABLE unexpected_schema(id TEXT)"); }]) {
    const f = await fixture(t), context = await f.execution(); mutate(f);
    await assert.rejects(f.execute(context));
    assert.equal(f.calls.includes("upload-api"), false);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='completion-attempt-one-claimed'").get().n, 0);
  }
});

test("fresh drain rejects every running or expired execution without changing jobs", async t => {
  for (const [table, status] of [["story_video_jobs", "rendering"], ["print_asset_jobs", "running"], ["product_image_jobs", "rendering"], ["artwork_preparation_jobs", "processing"]]) {
    const f = await fixture(t); f.db.exec("UPDATE native_video_release_control SET paused=0"); f.db.prepare(`INSERT INTO ${table}(id,status) VALUES ('active',?)`).run(status); f.db.exec("UPDATE native_video_release_control SET paused=1");
    await assert.rejects(verifyCompletionDrain(f.cf, f.control));
    assert.equal(f.db.prepare(`SELECT status FROM ${table}`).get().status, status);
  }
});

test("lost claim acknowledgement consumes the failed-owner attempt and a new dispatch cannot continue", async t => {
  const f = await fixture(t), context = await f.execution(); f.state.lostClaim = true;
  await assert.rejects(f.execute(context), /acknowledgement lost/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='completion-attempt-one-claimed'").get().n, 1);
  assert.deepEqual(await recoveryControl(f.cf), f.control); assert.equal(f.calls.includes("upload-api"), false);
  f.state.lostClaim = false;
  await assert.rejects(f.execute({ ...context, GITHUB_RUN_ID: "403" }), /boundary/);
});

test("claim races have one winner, preserve the entire pause tuple and cannot claim changed fences", async t => {
  const f = await fixture(t), reference = { key: "source/releases/native-401/completion-authority.json", version: "v1", sha256: "a".repeat(64) };
  const args = { cf: f.cf, authority: f.authority, reference, preparation: f.authority.failedPreparation, control: f.control, identity: { signatureVerified: true, sourceCommit: tool, runId: "402" } };
  const results = await Promise.allSettled([claimFailedRecoveryCompletion(args), claimFailedRecoveryCompletion({ ...args, identity: { ...args.identity, runId: "403" } })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.deepEqual(await recoveryControl(f.cf), f.control);
  const g = await fixture(t); g.db.exec("UPDATE native_video_release_control SET current_release_id='native-99'");
  await assert.rejects(claimFailedRecoveryCompletion({ ...args, cf: g.cf, control: g.control }));
});

test("staging approval never authorizes execution until the separate final hash is installed", async t => {
  const f = await fixture(t), staged = await f.stage();
  const context = { ...f.env, GITHUB_RUN_ID: "402", NATIVE_OPERATION: "complete-forward-release", NATIVE_COMPLETION_PACKAGE: "", NATIVE_COMPLETION_REFERENCE: JSON.stringify(staged.reference) };
  await assert.rejects(f.execute(context), /final authority approval/);
  assert.equal(f.calls.includes("upload-api"), false);
  assert.deepEqual(await recoveryControl(f.cf), f.control);
});

test("failed API acknowledgement or post-upload drift preserves the pause and consumes completion", async t => {
  for (const point of ["upload-ack", "post-upload-map", "status"]) {
    const f = await fixture(t), context = await f.execution();
    const dependencies = {
      cf: f.cf, client: f.client, staging: { read: async () => f.snapshot.stagingLifecycle },
      store: { ...f.store, save: async (name, bytes) => {
        const key = `source/releases/native-402/${name}`; assert.ok(!f.saved.has(key)); f.saved.set(key, bytes); return { key, version: "synthetic-version", sha256: hash(bytes) };
      } }, currentMain: async () => {}, identity: async () => ({ signatureVerified: true, sourceCommit: tool, runId: "402" }),
      runtimeRead: async () => f.snapshot.runtime, bindingsRead: async () => f.snapshot.bindings, runRead: async () => f.run,
      candidate: async () => ({ ...f.inputs.prepared.candidate, verifiedForCommit: tool }),
      verifyStatus: async () => { throw Error("status not verified"); },
      worker: async () => ({ deploy: async before => {
        await before(); f.state.apiDeployed = true;
        if (point === "upload-ack") throw Error("upload acknowledgement lost");
        const live = await inspectDevelopmentWorker(f.cf, undefined, f.inputs.uploads.api);
        if (point === "post-upload-map") f.state.mapChanged = true;
        return live;
      } }),
    };
    await assert.rejects(runFailedForwardCompletion(context, dependencies));
    assert.deepEqual(await recoveryControl(f.cf), f.control);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='completion-attempt-one-claimed'").get().n, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='verified'").get().n, 0);
    await assert.rejects(f.execute({ ...context, GITHUB_RUN_ID: "403" }), /boundary/);
  }
});

test("completion API preparation rehydrates only original bytes and detects local artifact drift before upload", async t => {
  for (const tamper of [false, true]) {
    const f = await fixture(t); let uploads = 0, dryRuns = 0, entrypoint;
    const worker = await prepareCompletionApi({ env: f.env, cf: f.cf, store: f.store, authority: f.authority, inputs: f.inputs, platform: "linux",
      executeCommand: async (_node, args) => {
        assert.equal(args.includes("--outdir"), false);
        assert.equal(args.includes("--no-bundle"), true);
        entrypoint = args[2];
        if (args.includes("--dry-run")) {
          dryRuns++;
          const form = new FormData(); form.append("metadata", JSON.stringify({ main_module: "index.js" }));
          form.append("index.js", new Blob([await readFile(entrypoint)]), "index.js");
          form.append("index.js.map", new Blob([await readFile(join(dirname(entrypoint), "index.js.map"))]), "index.js.map");
          await writeFile(args[args.indexOf("--outfile") + 1], Buffer.from(await new Response(form).arrayBuffer()));
        } else {
          uploads++;
          assert.equal(args[args.indexOf("--tag") + 1], failedOwner);
          assert.ok(args.includes(`STORY_VIDEO_RELEASE_COMMIT:${app}`));
          assert.equal(args.some(arg => arg.includes(tool)), false);
          const secrets = JSON.parse(await readFile(args[args.indexOf("--secrets-file") + 1]));
          assert.equal(Object.keys(secrets).length, 6);
          f.state.apiDeployed = true;
        }
        return { stdout: "", stderr: "" };
      } });
    assert.equal(dryRuns, 2);
    const beforeMutation = async () => {
      if (tamper) await writeFile(join(dirname(entrypoint), "index.js.map"), JSON.stringify(JSON.parse(await readFile(join(dirname(entrypoint), "index.js.map"))), null, 2));
    };
    if (tamper) { await assert.rejects(worker.deploy(beforeMutation), /complete content/); assert.equal(uploads, 0); }
    else { const live = await worker.deploy(beforeMutation); assert.equal(live.content.sourceMapData.algorithm, "complete-json-data-v1"); assert.equal(uploads, 1); }
    await assert.rejects(worker.deploy(async () => {}), /one-use/);
  }
});

test("completion requires unchanged executor settings, private endpoint, namespace, queue, schedules and image", async t => {
  for (const mutate of [
    f => { f.client.subdomain = async () => ({ enabled: true, previews_enabled: false }); },
    f => { const version = f.client.version; f.client.version = async id => { const value = structuredClone(await version(id)); value.resources.bindings.find(item => item.name === "PRINT_EXECUTIONS").namespace_id = "9".repeat(32); return value; }; },
    f => { const version = f.client.version; f.client.version = async id => { const value = structuredClone(await version(id)); value.resources.script_runtime.migration_tag = "changed"; return value; }; },
    f => { f.client.settings = async () => ({ changed: true }); },
    f => { f.cf.schedules = async () => ({ schedules: [] }); },
    f => { f.cf.consumers = async () => []; },
    f => { f.snapshot.runtime.renderer.imageDigest = `sha256:${"9".repeat(64)}`; },
    f => { const query = f.cf.query; f.cf.query = async (sql, params) => { const value = await query(sql, params); if (params?.[0] === oldOwner && sql.includes("ORDER BY stage")) value[0].results = []; return value; }; },
  ]) {
    const f = await fixture(t), context = await f.execution(); mutate(f);
    await assert.rejects(f.execute(context));
    assert.equal(f.calls.includes("upload-api"), false); assert.equal((await recoveryControl(f.cf)).paused, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='completion-attempt-one-claimed'").get().n, 0);
  }
});
