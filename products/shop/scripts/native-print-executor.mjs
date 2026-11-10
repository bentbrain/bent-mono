import { readWorkerUpload, verifyWorkerContentEquivalent, verifyWorkerUpload, verifyWorkerUploadEvidence, preserveWorkerUpload, readSealedWorkerUpload, historicalWorkerUpload, prepareWorkerUpload } from "./native-worker-content.mjs";
import { resolveProtectedTemplate } from "./protected-config.mjs";
import { activeWorkerSettings } from "./native-ci-worker.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CLOUDFLARE_ACCOUNT, DEVELOPMENT_DATABASE, developmentCloudflare } from "./native-ci-cloudflare.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { assertReleasePaused, recordReleaseEvent } from "./native-release-pause.mjs";
import { printStagingLifecycleProtocol } from "./native-print-staging-lifecycle.mjs";
import { productionCloudflare, PRODUCTION_DB } from "./native-production-cloudflare.mjs";

export const PRINT_EXECUTOR = "forever-tee-print-executor-development";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (condition, reason) => { if (!condition) throw new Error(`Print executor foundation stopped: ${reason}`); };
const migration = [{ tag: "print-execution-v1", new_sqlite_classes: ["PrintAssetExecution"] }];

export function printExecutorProtocol(environment) {
  check(["development", "production"].includes(environment), "exact executor environment required.");
  const workerName = `forever-tee-print-executor-${environment}`;
  const database = environment === "production" ? PRODUCTION_DB : DEVELOPMENT_DATABASE;
  const artworkBucket = `forever-tee-design-artwork-${environment}`;
  const CONFIG = new URL(environment === "production"
    ? "../workers/print-executor/wrangler.production.jsonc"
    : "../workers/print-executor/wrangler.jsonc", import.meta.url);
  const { client: stagingClient, planPrintStagingLifecycle, verifyPrintStagingLifecycle,
    verifyPrintStagingLifecyclePlan } = printStagingLifecycleProtocol(environment);
  const operation = env => {
    if (environment === "development") return developmentOperation(env);
    productionCloudflare(env);
    return env.NATIVE_OPERATION;
  };

function verifyPrintExecutorConfig(config) {
  const selected = config.env?.[environment];
  check(config.account_id === CLOUDFLARE_ACCOUNT && config.main === "src/index.ts" &&
    config.workers_dev === false && config.preview_urls === false &&
    config.compatibility_date === "2026-08-12" && isDeepStrictEqual(config.compatibility_flags, ["nodejs_compat"]) &&
    config.env && Object.keys(config.env).length === 1 && selected?.name === workerName &&
    isDeepStrictEqual(selected.migrations, migration) && isDeepStrictEqual(config.migrations, migration) &&
    isDeepStrictEqual(selected.durable_objects, { bindings: [{ name: "PRINT_EXECUTIONS", class_name: "PrintAssetExecution" }] }) &&
    isDeepStrictEqual(selected.d1_databases, [{ binding: "DB", database_name: `forever-tee-designs-${environment}`, database_id: database }]) &&
    isDeepStrictEqual(selected.r2_buckets, [{ binding: "DESIGN_ARTWORK", bucket_name: artworkBucket }]) &&
    isDeepStrictEqual(selected.images, { binding: "IMAGES" }), "exact environment resources and creation-only migration required.");
  const allowedRoot = new Set(["$schema", "name", "main", "account_id", "compatibility_date", "compatibility_flags",
    "workers_dev", "preview_urls", "observability", "durable_objects", "migrations", "d1_databases", "r2_buckets", "images", "env"]);
  const allowedDev = new Set(["name", "durable_objects", "migrations", "d1_databases", "r2_buckets", "images"]);
  check(Object.keys(config).every(key => allowedRoot.has(key)) && Object.keys(selected).every(key => allowedDev.has(key)),
    "unreviewed executor configuration field.");
  return true;
}

function printExecutorClient(env, request = fetch) {
  if (environment === "production") productionCloudflare(env, request);
  else developmentCloudflare(env, request);
  const root = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/workers/scripts/${workerName}`;
  const send = async (suffix, body) => {
    let response;
    try { response = await request(`${root}${suffix}`, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new Error("Print executor inspection was not confirmed; no absence was inferred."); }
    return response;
  };
  const read = async (suffix, allowAbsent = false) => {
    const response = await send(suffix);
    let value;
    try { value = await response.json(); }
    catch { throw new Error("Print executor inspection returned invalid JSON; no absence was inferred."); }
    if (allowAbsent && response.status === 404 && value.success === false &&
      Array.isArray(value.errors) && value.errors.length === 1 && value.errors[0].code === 10007)
      return null;
    check(response.ok && value.success === true && value.result, `inspection failed with HTTP ${response.status}.`);
    return value.result;
  };
  return { settings: () => read("/settings"), absentSettings: () => read("/settings", true),
    deployments: () => read("/deployments"), versions: () => read("/versions"),
    version: id => { check(/^[a-f0-9-]{36}$/.test(id), "exact version identifier."); return read(`/versions/${id}`); },
    content: async () => { const response = await send("/content/v2"); check(response.ok, "executor content read."); return response; },
    subdomain: () => read("/subdomain"),
    restoreVersion: async id => {
      check(environment === "development" && operation(env) === "rollback" && /^[a-f0-9-]{36}$/.test(id), "guarded exact-version executor rollback required.");
      const response = await send("/deployments", { strategy: "percentage", versions: [{ version_id: id, percentage: 100 }] });
      let value; try { value = await response.json(); } catch { throw new Error("Executor rollback response was not confirmed."); }
      check(response.ok && value.success === true, "executor rollback was not confirmed; do not repeat the mutation.");
      return value.result;
    } };
}

function verifyPrintExecutorSettings(settings, expected) {
  check(settings.compatibility_date === "2026-08-12" && isDeepStrictEqual(settings.compatibility_flags, ["nodejs_compat"]),
    "executor runtime differs from the prepared configuration.");
  const bindings = settings.bindings;
  check(Array.isArray(bindings) && bindings.length === 8 && new Set(bindings.map(binding => binding.name)).size === 8,
    "exact executor bindings required.");
  const binding = name => bindings.find(item => item.name === name);
  check(binding("DB")?.type === "d1" && binding("DB").id === database &&
    binding("DESIGN_ARTWORK")?.type === "r2_bucket" && binding("DESIGN_ARTWORK").bucket_name === artworkBucket &&
    binding("IMAGES")?.type === "images", "executor data/image resources differ.");
  const namespace = binding("PRINT_EXECUTIONS");
  check(namespace?.type === "durable_object_namespace" && namespace.class_name === "PrintAssetExecution" &&
    /^[a-f0-9]{32}$/.test(namespace.namespace_id) && (!namespace.script_name || namespace.script_name === workerName),
    "executor class and namespace identity required.");
  const values = { PRINT_EXECUTOR_SOURCE_COMMIT: expected.sourceCommit, PRINT_EXECUTOR_CONFIG_SHA256: expected.configSha256,
    PRINT_EXECUTOR_BUNDLE_SHA256: expected.bundleSha256, PRINT_EXECUTION_RELEASE_ID: expected.releaseId };
  for (const [name, text] of Object.entries(values)) check(binding(name)?.type === "plain_text" && binding(name).text === text,
    "executor immutable source/configuration/generation binding differs.");
  return { namespaceId: namespace.namespace_id };
}

function verifyPrintExecutorLifecycle(version, expectedVersionId) {
  // /settings omits the lifecycle tag. The immutable version endpoint exposes
  // it at resources.script_runtime.migration_tag, alongside its runtime config.
  check(version.id === expectedVersionId && version.resources?.script_runtime?.migration_tag === "print-execution-v1",
    "executor version lifecycle differs from the creation-only migration.");
  return { migrationTag: version.resources.script_runtime.migration_tag };
}

function verifyApiPrintExecutorBinding(settings, expected) {
  check(/^[a-f0-9]{32}$/.test(expected.namespaceId), "recorded executor namespace required for API binding.");
  const modes = settings.bindings?.filter(binding => binding.name === "PRINT_EXECUTION_MODE");
  const executors = settings.bindings?.filter(binding => binding.name === "PRINT_EXECUTIONS");
  check(modes?.length === 1 && modes[0].type === "plain_text" && modes[0].text === "durable-object",
    "API print execution mode differs from the prepared executor.");
  check(executors?.length === 1 && executors[0].type === "durable_object_namespace" &&
    executors[0].class_name === "PrintAssetExecution" && executors[0].script_name === workerName &&
    executors[0].namespace_id === expected.namespaceId && !executors[0].environment,
  "API print binding differs from the recorded executor namespace, script or class.");
  return true;
}

async function preparePrintExecutorFoundation({ env, directory, run, api, inspectWorker, baselineStore: existingStore, client = printExecutorClient(env),
  platform = process.platform, staging = stagingClient(env), interrupted, sealedUpload }) {
  check(env.RUNNER_TEMP?.startsWith("/") && platform === "linux", "cloud-only preparation.");
  const selectedOperation = operation(env);
  check((environment === "production" ? ["release", "prepare-worker"] : ["release", "build-candidate", "plan", "plan-forward-recovery", "recover-forward-release"]).includes(selectedOperation) &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA), "guarded environment preparation only.");
  const configBytes = await readFile(CONFIG), config = JSON.parse(resolveProtectedTemplate(configBytes));
  verifyPrintExecutorConfig(config);
  const out = join(directory, "executor-bundle");
  const upload = await prepareWorkerUpload({ run, directory: out, environment, sealed: sealedUpload }), bundle = upload.code;
  const settings = await client.absentSettings();
  let before, baselineStore = existingStore;
  if (settings === null) before = { exists: false, worker: workerName, accountId: CLOUDFLARE_ACCOUNT, absence: "HTTP404/error10007" };
  else if (interrupted) {
    check(environment === "development" && ["plan-forward-recovery", "recover-forward-release"].includes(selectedOperation), "dedicated interrupted-state preparation required.");
    const observed = await interrupted.verifyPrevious();
    check(isDeepStrictEqual(observed, interrupted.review) && observed.kind === "interrupted-development-release", "interrupted-state evidence changed.");
    before = { exists: true, worker: workerName, accountId: CLOUDFLARE_ACCOUNT, apiMode: "durable-object",
      namespaceId: observed.namespaceId, interrupted: observed };
  }
  else {
    const store = existingStore ?? (environment === "development" ? await createDevelopmentReleaseStore(env) : undefined);
    check(store, "Production preparation requires its scoped evidence store.");
    baselineStore = store;
    const recorded = await loadActivePrintExecutorBaseline({ api, client, store, inspectWorker,
      staging });
    before = { exists: true, worker: workerName, accountId: CLOUDFLARE_ACCOUNT, recorded,
      apiMode: (await activeWorkerSettings(api)).bindings?.find(binding => binding.name === "PRINT_EXECUTION_MODE")?.text === "durable-object" ? "durable-object" : "queue" };
  }
  // Image reuse still advances the executor's release generation under the
  // existing pause/drain. It cannot create a foundation or change its inputs.
  check(env.NATIVE_RELEASE_MODE !== "api" || before.exists &&
    before.recorded.configSha256 === hash(configBytes) &&
    before.recorded.worker.content.modules[0].sha256 === hash(bundle),
  "API image reuse requires an existing unchanged executor; use the full lane.");
  check(!interrupted || before.exists && before.interrupted, "recovery requires an existing owned namespace.");
  const stagingLifecycle = planPrintStagingLifecycle(await staging.read());
  check(!interrupted || !stagingLifecycle.mutationRequired, "recovery requires the verified existing staging lifecycle.");
  const review = { schemaVersion: sealedUpload?.review.schemaVersion ?? 3, content: upload.content, worker: workerName, accountId: CLOUDFLARE_ACCOUNT,
    sourceCommit: env.GITHUB_SHA, releaseId: `native-${env.GITHUB_RUN_ID}`, bundleSha256: hash(bundle), bundleBytes: bundle.length,
    configSha256: hash(configBytes), config, migrations: migration, before, stagingLifecycle,
    rollback: "same-namespace-exact-version; retain-foundation-for-queue-rollback" };
  return createPrintExecutorFoundationRelease({ env, review, bundle, entrypoint: join(out, "index.js"), run, api, client, inspectWorker, staging, baselineStore, interrupted });
}

function createPrintExecutorFoundationRelease({ env, review, bundle, entrypoint, run, api, client, inspectWorker, staging, baselineStore, interrupted }) {
  const selectedOperation = operation(env), before = review.before;
  check(review.sourceCommit === env.GITHUB_SHA && review.releaseId === `native-${env.GITHUB_RUN_ID}` &&
    review.worker === workerName && review.accountId === CLOUDFLARE_ACCOUNT && typeof before.exists === "boolean" &&
    hash(bundle) === review.bundleSha256, "source-bound executor release required.");
  check(!before.exists || ["queue", "durable-object"].includes(before.apiMode), "recorded previous API execution mode required.");
  check(!before.interrupted || environment === "development" && interrupted &&
    ["plan-forward-recovery", "recover-forward-release"].includes(selectedOperation) && isDeepStrictEqual(before.interrupted, interrupted.review), "dedicated interrupted release context required.");
  verifyPrintStagingLifecyclePlan(review.stagingLifecycle);
  let artifacts, store = baselineStore, deployed, deploymentStarted = false;
  const verifyAbsent = async () => {
    if (before.exists) {
      if (before.interrupted) {
        check(isDeepStrictEqual(await interrupted.verifyPrevious(), before.interrupted), "interrupted executor changed.");
      } else {
        check(store, "prior executor evidence store required.");
        await verifyPrintExecutorRecord({ recorded: before.recorded, store, client, inspectWorker, staging });
      }
      check(isDeepStrictEqual(review.migrations, migration), "executor namespace migrations cannot change during update.");
    } else {
      check(await client.absentSettings() === null, "executor appeared after absence was recorded; creation stopped.");
      const intents = (await api.query("SELECT release_id FROM native_video_release_events WHERE stage = 'print-executor-deploy-started' LIMIT 1"))[0].results;
      check(intents.length === 0, "a prior executor creation intent exists; inspect its durable evidence instead of replaying creation.");
    }
    verifyWorkerUpload((await readWorkerUpload(join(entrypoint, ".."), review)).content, review);
    check(hash(await readFile(CONFIG)) === review.configSha256 && hash(await readFile(entrypoint)) === review.bundleSha256,
      "prepared executor files changed.");
  };
  const verifyDeployed = async () => {
    check(deployed, "executor has not been provisioned by this guarded release.");
    const current = await inspectWorker(client, undefined, review);
    check(isDeepStrictEqual(current, deployed.worker), "executor active version/resources changed before API binding.");
    check(isDeepStrictEqual(verifyPrintExecutorLifecycle(await client.version(current.workerVersion), current.workerVersion), deployed.lifecycle),
      "executor lifecycle changed before API binding.");
    check(isDeepStrictEqual(verifyPrintExecutorSettings(await activeWorkerSettings(client, current), review), { namespaceId: deployed.namespaceId }),
      "executor namespace changed before API binding.");
    const subdomain = await client.subdomain();
    check(subdomain.enabled === false && subdomain.previews_enabled === false, "executor must have no workers.dev or Preview URLs.");
    verifyPrintStagingLifecycle(await staging.read(), review.stagingLifecycle);
    return deployed;
  };
  return { review, before,
    preserve: async targetStore => {
      check(!artifacts, "executor evidence was already preserved.");
      store = targetStore; await verifyAbsent();
      check(isDeepStrictEqual(await staging.read(), review.stagingLifecycle.before), "staging lifecycle changed before preservation.");
      const upload = await readWorkerUpload(join(entrypoint, ".."), review);
      verifyWorkerUpload(upload.content, review);
      const candidate = await preserveWorkerUpload(store, upload, "candidate-print-executor");
      const foundationArtifact = await store.save("print-executor-foundation.json", Buffer.from(JSON.stringify(review)));
      artifacts = { ...candidate, foundationArtifact };
      return artifacts;
    },
    verifyPrevious: verifyAbsent,
    deploy: async releaseId => {
      check((selectedOperation === "release" || environment === "development" && selectedOperation === "recover-forward-release" && interrupted) && releaseId === review.releaseId && artifacts && store && !deployed && !deploymentStarted,
        "preserved first-attempt executor foundation required.");
      await assertReleasePaused(api, releaseId);
      await verifyAbsent();
      check(isDeepStrictEqual(JSON.parse(await store.read(artifacts.foundationArtifact)), review) &&
        hash(await store.read(artifacts.candidateArtifact)) === review.bundleSha256, "immutable executor artifact readback differs.");
      await readSealedWorkerUpload(store, artifacts, review);
      deploymentStarted = true;
      await recordReleaseEvent(api, releaseId, "print-staging-lifecycle-started", { review: review.stagingLifecycle, artifacts });
      if (interrupted) await interrupted.beforeMutation("staging-lifecycle");
      await assertReleasePaused(api, releaseId);
      const stagingAfter = await staging.append(review.stagingLifecycle);
      const stagingEvidence = await store.save("print-staging-lifecycle.json", Buffer.from(JSON.stringify({ sourceCommit: review.sourceCommit,
        releaseId, before: review.stagingLifecycle.before, reviewed: review.stagingLifecycle.after, after: stagingAfter })));
      await recordReleaseEvent(api, releaseId, "print-staging-lifecycle-verified", { evidence: stagingEvidence });
      // A durable intent prevents a replacement run from interpreting an
      // interrupted creation as permission to overwrite an existing executor.
      await recordReleaseEvent(api, releaseId, "print-executor-deploy-started", { review, artifacts });
      const vars = { PRINT_EXECUTOR_SOURCE_COMMIT: review.sourceCommit, PRINT_EXECUTOR_CONFIG_SHA256: review.configSha256,
        PRINT_EXECUTOR_BUNDLE_SHA256: review.bundleSha256, PRINT_EXECUTION_RELEASE_ID: releaseId };
      if (interrupted) await interrupted.beforeMutation("executor-deploy");
      await assertReleasePaused(api, releaseId);
      await run(["deploy", entrypoint, "--no-bundle", "--upload-source-maps", "--env", environment, "--tag", releaseId,
        "--message", `Print foundation ${review.sourceCommit}`, ...Object.entries(vars).flatMap(([name, text]) => ["--var", `${name}:${text}`])]);
      const worker = await inspectWorker(client, undefined, review);
      await verifyWorkerUploadEvidence(worker.content, review, { store, env, filename: "print-executor-content-diagnostic.json" });
      const { namespaceId } = verifyPrintExecutorSettings(await activeWorkerSettings(client, worker), review);
      check(!before.exists || namespaceId === (before.interrupted ? before.namespaceId : before.recorded.namespaceId), "executor update changed the existing namespace.");
      const lifecycle = verifyPrintExecutorLifecycle(await client.version(worker.workerVersion), worker.workerVersion);
      deployed = { worker, namespaceId, lifecycle, stagingEvidence, sourceCommit: review.sourceCommit, configSha256: review.configSha256, releaseId, artifacts };
      await verifyDeployed();
      const evidence = await store.save("deployed-print-executor.json", Buffer.from(JSON.stringify(deployed)));
      await recordReleaseEvent(api, releaseId, "print-executor-verified", { ...deployed, evidence });
      await assertReleasePaused(api, releaseId);
      return { ...deployed, evidence };
    },
    verifyDeployed,
  };
}

function verifyQueuePrintMode(settings) {
  const modes = settings.bindings?.filter(binding => binding.name === "PRINT_EXECUTION_MODE") ?? [];
  check(modes.length === 0 || modes.length === 1 && modes[0].type === "plain_text" && modes[0].text === "queue",
    "active executor lacks immutable release evidence.");
  check(!settings.bindings?.some(binding => binding.name === "PRINT_EXECUTIONS"), "queue API retains an unrecorded executor binding.");
}

async function readExecutorPreparation(store, artifacts) {
  check(artifacts?.foundationArtifact && artifacts.candidateArtifact, "executor immutable artifact references required.");
  const review = JSON.parse(await store.read(artifacts.foundationArtifact));
  check(review.worker === workerName && review.accountId === CLOUDFLARE_ACCOUNT &&
    /^[a-f0-9]{40}$/.test(review.sourceCommit) && /^native-\d+$/.test(review.releaseId), "executor preparation identity.");
  verifyPrintExecutorConfig(review.config);
  check(isDeepStrictEqual(review.migrations, migration), "executor lifecycle cannot change.");
  const upload = await readSealedWorkerUpload(store, artifacts, review);
  return { review, bytes: upload.code, upload };
}

async function verifyPrintExecutorRecord({ recorded, store, client, inspectWorker, staging }) {
  check(recorded?.evidence, "executor version evidence required.");
  const { evidence, ...saved } = recorded;
  check(isDeepStrictEqual(JSON.parse(await store.read(evidence)), saved), "executor deployment evidence differs.");
  const { review, upload } = await readExecutorPreparation(store, recorded.artifacts);
  check(recorded.releaseId === review.releaseId && recorded.sourceCommit === review.sourceCommit &&
    recorded.configSha256 === review.configSha256, "executor immutable source/generation differs.");
  const historical = await historicalWorkerUpload(recorded.worker, upload);
  const current = await inspectWorker(client, historical, review);
  verifyWorkerUpload(current.content, review);
  verifyWorkerContentEquivalent(current.content, recorded.worker.content);
  const { content: _content, ...currentIdentity } = current, { content: _recordedContent, ...recordedIdentity } = recorded.worker;
  check(isDeepStrictEqual(currentIdentity, recordedIdentity), "executor version or immutable resources changed.");
  check(isDeepStrictEqual(verifyPrintExecutorLifecycle(await client.version(current.workerVersion), current.workerVersion), recorded.lifecycle),
    "executor lifecycle changed.");
  check(isDeepStrictEqual(verifyPrintExecutorSettings(await activeWorkerSettings(client, recorded.worker), review), { namespaceId: recorded.namespaceId }),
    "executor namespace changed.");
  const subdomain = await client.subdomain();
  check(subdomain.enabled === false && subdomain.previews_enabled === false, "executor acquired a public endpoint.");
  const stagingEvidence = JSON.parse(await store.read(recorded.stagingEvidence));
  check(isDeepStrictEqual(stagingEvidence, { sourceCommit: review.sourceCommit, releaseId: review.releaseId,
    before: review.stagingLifecycle.before, reviewed: review.stagingLifecycle.after, after: review.stagingLifecycle.after }),
    "staging lifecycle evidence differs from the reviewed append.");
  verifyPrintStagingLifecycle(await staging.read(), review.stagingLifecycle);
  return recorded;
}

async function loadActivePrintExecutorBaseline({ api, client, store, inspectWorker, staging }) {
  const readControl = async () => (await api.query("SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1"))[0].results;
  const control = await readControl();
  check(control.length === 1 && control[0].paused === 0 && control[0].release_id === null &&
    /^native-\d+$/.test(control[0].current_release_id), "executor baseline requires a verified unpaused release.");
  const rows = (await api.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'verified'",
    [control[0].current_release_id]))[0].results;
  check(rows.length === 1, "current executor ownership evidence missing.");
  const verified = JSON.parse(rows[0].payload);
  const recorded = verified.worker?.printExecutor ?? verified.retainedPrintExecutor;
  check(recorded && (!verified.retainedPrintExecutor || verified.rollbackVerified === true), "existing executor has no owned active or retained baseline.");
  await verifyPrintExecutorRecord({ recorded, store, client, inspectWorker, staging });
  if (verified.worker?.printExecutor) verifyApiPrintExecutorBinding(await activeWorkerSettings(api), recorded);
  else verifyQueuePrintMode(await activeWorkerSettings(api));
  check(isDeepStrictEqual(await readControl(), control), "executor release ownership changed during inspection.");
  return recorded;
}

async function verifyRecordedPrintExecutor({ env, api, prepared, store, inspectWorker,
  client = printExecutorClient(env), staging = stagingClient(env) }) {
  const review = prepared.worker?.printExecutor;
  if (!review) { verifyQueuePrintMode(await activeWorkerSettings(api)); return null; }
  check(review.worker === workerName && review.sourceCommit === prepared.sourceCommit && review.releaseId === prepared.releaseId,
    "executor preparation does not match the active release.");
  const artifacts = prepared.artifacts?.printExecutor;
  const sealed = await readExecutorPreparation(store, artifacts);
  check(isDeepStrictEqual(sealed.review, review), "immutable executor foundation differs.");
  const rows = prepared.completion
    ? (await api.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'verified'", [prepared.releaseId]))[0].results.map(row => ({ payload: JSON.stringify(JSON.parse(row.payload).worker?.printExecutor) }))
    : (await api.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'print-executor-verified'", [prepared.releaseId]))[0].results;
  check(rows.length === 1, "exact recorded executor deployment required.");
  const recorded = JSON.parse(rows[0].payload);
  check(recorded.releaseId === prepared.releaseId && isDeepStrictEqual(recorded.artifacts, artifacts), "executor deployment evidence differs.");
  await verifyPrintExecutorRecord({ recorded, store, client, inspectWorker, staging });
  verifyApiPrintExecutorBinding(await activeWorkerSettings(api), recorded);
  return recorded;
}

// Called only after the existing print/video pause and drain. A failed upload
// acknowledgement can be reconciled against its sealed intended bytes; it is
// never permission to upload again or select a different namespace.
async function restoreDevelopmentPrintExecutor({ env, api, store, prepared, releaseId, inspectWorker,
  client = printExecutorClient(env), staging = stagingClient(env) }) {
  check(environment === "development" && operation(env) === "rollback" && releaseId === `native-${env.GITHUB_RUN_ID}` &&
    env.NATIVE_ROLLBACK_RELEASE === prepared.releaseId, "exact guarded rollback context required.");
  await assertReleasePaused(api, releaseId);
  const review = prepared.worker?.printExecutor;
  check(!review?.before?.interrupted, "interrupted predecessor requires separate secure paired rollback qualification.");
  const previous = review?.before?.exists ? review.before.recorded : null;
  const settings = await client.absentSettings();
  if (!settings) {
    check(!previous, "previous executor disappeared before rollback.");
    if (review) {
      const created = (await api.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'print-executor-verified'",
        [prepared.releaseId]))[0].results;
      check(created.length === 0, "recorded executor disappeared; absence cannot erase its namespace history.");
    }
    return { restored: null, retained: null, verify: async () => {
      check(await client.absentSettings() === null, "executor appeared during rollback."); verifyQueuePrintMode(await activeWorkerSettings(api));
    } };
  }
  check(review, "rollback encountered an unowned executor.");
  let current;
  const generation = (await activeWorkerSettings(client)).bindings?.find(binding => binding.name === "PRINT_EXECUTION_RELEASE_ID")?.text;
  if (previous && generation === previous.releaseId) {
    current = await verifyPrintExecutorRecord({ recorded: previous, store, client, inspectWorker, staging });
  } else {
    check(generation === prepared.releaseId, "unrecorded executor generation is active.");
    const sealed = await readExecutorPreparation(store, prepared.artifacts.printExecutor);
    check(isDeepStrictEqual(sealed.review, review), "rollback candidate differs from sealed preparation.");
    const intents = (await api.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'print-executor-deploy-started'",
      [prepared.releaseId]))[0].results;
    check(intents.length === 1, "executor creation/update has no durable intent.");
    const intent = JSON.parse(intents[0].payload);
    check(isDeepStrictEqual(intent.review, review) && isDeepStrictEqual(intent.artifacts, prepared.artifacts.printExecutor), "executor mutation intent differs.");
    const rows = (await api.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'print-executor-verified'",
      [prepared.releaseId]))[0].results;
    if (rows.length === 1) current = await verifyPrintExecutorRecord({ recorded: JSON.parse(rows[0].payload), store, client, inspectWorker, staging });
    else {
      check(rows.length === 0, "ambiguous executor deployment evidence.");
      const lifecycleRows = (await api.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'print-staging-lifecycle-verified'",
        [prepared.releaseId]))[0].results;
      check(lifecycleRows.length === 1, "staging fallback was not verified before executor deployment.");
      const worker = await inspectWorker(client, undefined, review);
      await verifyWorkerUploadEvidence(worker.content, review, { store, env, filename: "print-executor-content-diagnostic.json" });
      const { namespaceId } = verifyPrintExecutorSettings(await activeWorkerSettings(client, worker), review);
      check(!previous || previous.namespaceId === namespaceId, "uncertain update changed namespace.");
      const record = { worker, namespaceId, lifecycle: verifyPrintExecutorLifecycle(await client.version(worker.workerVersion), worker.workerVersion),
        stagingEvidence: JSON.parse(lifecycleRows[0].payload).evidence, sourceCommit: review.sourceCommit,
        configSha256: review.configSha256, releaseId: review.releaseId, artifacts: prepared.artifacts.printExecutor };
      const evidence = await store.save("recovered-print-executor.json", Buffer.from(JSON.stringify(record)));
      current = await verifyPrintExecutorRecord({ recorded: { ...record, evidence }, store, client, inspectWorker, staging });
      await recordReleaseEvent(api, releaseId, "print-executor-recovered", current);
    }
  }
  check(!previous || previous.namespaceId === current.namespaceId, "rollback cannot cross executor namespaces.");
  if (previous && previous.worker.workerVersion !== current.worker.workerVersion) {
    // Verify the preserved predecessor bytes and immutable version before write.
    const predecessor = await readExecutorPreparation(store, previous.artifacts);
    check(predecessor.review.releaseId === previous.releaseId, "previous executor generation differs.");
    const version = await client.version(previous.worker.workerVersion);
    const { versionResourcesDigest } = await import("./native-ci-worker.mjs");
    check(versionResourcesDigest(version) === previous.worker.versionResourcesSha256, "previous executor version resources changed.");
    verifyPrintExecutorLifecycle(version, previous.worker.workerVersion);
    await assertReleasePaused(api, releaseId);
    await recordReleaseEvent(api, releaseId, "print-executor-rollback-started", { from: current, to: previous });
    await client.restoreVersion(previous.worker.workerVersion);
  }
  check(!previous || ["queue", "durable-object"].includes(review.before.apiMode), "previous API execution mode is missing.");
  const restored = previous && review.before.apiMode === "durable-object" ? previous : null;
  const retained = restored ? null : previous ?? current;
  const verify = async () => {
    await verifyPrintExecutorRecord({ recorded: restored ?? retained, store, client, inspectWorker, staging });
    if (restored) verifyApiPrintExecutorBinding(await activeWorkerSettings(api, prepared.previous?.worker), restored);
    else verifyQueuePrintMode(await activeWorkerSettings(api, prepared.previous?.worker));
  };
  // API restoration follows; only executor identity can be checked here.
  await verifyPrintExecutorRecord({ recorded: restored ?? retained, store, client, inspectWorker, staging });
  await recordReleaseEvent(api, releaseId, "print-executor-rollback-verified", { restored, retained });
  return { restored, retained, verify };
}

// Resume only a completed provider restoration. This never deploys a version,
// creates a namespace, or repeats an uncertain restoration request.
async function verifyRestoredPrintExecutor({ api, store, prepared, releaseId, inspectWorker, client, staging }) {
  const rows = (await api.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'print-executor-rollback-verified'",
    [releaseId]))[0].results;
  check(rows.length === 1, "completed executor restoration journal required.");
  const result = JSON.parse(rows[0].payload);
  const review = prepared.worker?.printExecutor;
  check(!review?.before?.interrupted, "interrupted predecessor requires separate secure paired rollback qualification.");
  const previous = review?.before?.exists ? review.before.recorded : null;
  if (result.restored) {
    check(previous && review.before.apiMode === "durable-object" && !result.retained && isDeepStrictEqual(result.restored, previous),
      "restored executor is not the sealed predecessor.");
  } else if (result.retained) {
    if (previous) check(review.before.apiMode === "queue" && isDeepStrictEqual(result.retained, previous), "retained predecessor differs.");
    else {
      check(review && result.retained.releaseId === prepared.releaseId && isDeepStrictEqual(result.retained.artifacts, prepared.artifacts.printExecutor),
        "retained foundation differs from original preparation.");
      const sealed = await readExecutorPreparation(store, result.retained.artifacts);
      check(isDeepStrictEqual(sealed.review, review), "retained foundation preparation differs.");
    }
  } else check(!review && !previous && await client.absentSettings() === null, "missing recorded executor restoration.");
  if (result.restored || result.retained) await verifyPrintExecutorRecord({ recorded: result.restored ?? result.retained,
    store, client, inspectWorker, staging });
  const settings = await activeWorkerSettings(api, prepared.previous?.worker);
  if (result.restored) verifyApiPrintExecutorBinding(settings, result.restored);
  else verifyQueuePrintMode(settings);
  return result;
}

  return { printExecutorClient, verifyPrintExecutorConfig, verifyPrintExecutorSettings, verifyPrintExecutorLifecycle,
    verifyApiPrintExecutorBinding, preparePrintExecutorFoundation, createPrintExecutorFoundationRelease,
    loadActivePrintExecutorBaseline, verifyRecordedPrintExecutor, restoreDevelopmentPrintExecutor, verifyRestoredPrintExecutor };
}

export const { printExecutorClient: developmentPrintExecutorClient, verifyPrintExecutorConfig,
  verifyPrintExecutorSettings, verifyPrintExecutorLifecycle, verifyApiPrintExecutorBinding,
  preparePrintExecutorFoundation, createPrintExecutorFoundationRelease, loadActivePrintExecutorBaseline,
  verifyRecordedPrintExecutor, restoreDevelopmentPrintExecutor, verifyRestoredPrintExecutor } = printExecutorProtocol("development");
