import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual as equal } from "node:util";
import test from "node:test";
import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { installPauseSchema, recordReleaseEvent } from "./native-release-pause.mjs";
import { claimForwardRecovery } from "./native-forward-recovery-claim.mjs";
import { inspectInterruptedDevelopmentRelease, loadForwardRecoveryAuthority, recoveryControl, recoveryHash } from "./native-forward-recovery-inspection.mjs";
import { executeForwardRecovery, forwardWorkerPlan, runDevelopmentForwardRecovery } from "./native-forward-recovery.mjs";
import { loadActivePrintExecutorBaseline } from "./native-print-executor.mjs";
import { versionResourcesDigest } from "./native-ci-worker.mjs";
import { workerContentManifest, workerContentResponse } from "./native-worker-content.mjs";
import { sealDispatchInputs, resolveDispatchInputs } from "./release-dispatch-inputs.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { forwardRecoveryReference } from "./native-forward-recovery-reference.mjs";

const source = "a".repeat(40), originalSource = "b".repeat(40), owner = "native-101", current = "native-100";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
  GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: source, GITHUB_RUN_ID: "303", GITHUB_RUN_ATTEMPT: "1",
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main",
  NATIVE_RELEASE_MODE: "full", NATIVE_OPERATION: "plan-forward-recovery" };
const object = (releaseId, filename, bytes) => ({ key: `source/releases/${releaseId}/${filename}`, version: "synthetic-version-1", sha256: recoveryHash(bytes) });

async function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE story_video_jobs (id TEXT PRIMARY KEY NOT NULL, status TEXT, attempt_count INTEGER, renderer_version TEXT, updated_at INTEGER, last_error TEXT);
    CREATE TABLE print_asset_jobs (id TEXT, status TEXT, attempt_count INTEGER, lease_id TEXT, next_attempt_at INTEGER, updated_at INTEGER);
    CREATE TABLE product_image_jobs (id TEXT, status TEXT, attempt_count INTEGER, updated_at INTEGER);
    CREATE TABLE artwork_preparation_jobs (id TEXT, status TEXT, attempts INTEGER, lease_token TEXT, next_attempt_at INTEGER, updated_at INTEGER);
    INSERT INTO story_video_jobs VALUES ('video', 'rendering', 1, 'story-video-renderer-v7', 100, NULL);
    INSERT INTO print_asset_jobs VALUES ('print', 'running', 1, 'active-print-lease', 400000, 100);
    INSERT INTO product_image_jobs VALUES ('image', 'rendering', 1, 100);
    INSERT INTO artwork_preparation_jobs VALUES ('artwork', 'processing', 1, 'expired-lease', 100, 100);`);
  const state = { lostClaim: false, lostCas: false, time: 10000, maps: true, extra: false, activeExecutor: "11111111-1111-4111-8111-111111111111" };
  const query = async (sql, params = []) => {
    const statement = db.prepare(sql), result = statement.columns().length
      ? { results: statement.all(...params).map(row => ({ ...row })), meta: { changes: 0 } }
      : { results: [], meta: statement.run(...params) };
    if (state.lostClaim && sql.startsWith("INSERT INTO native_video_release_events") && params[1] === "forward-recovery-claimed") throw Error("lost claim acknowledgement");
    if (state.lostCas && sql.startsWith("UPDATE native_video_release_control SET release_id")) throw Error("lost CAS acknowledgement");
    return [result];
  };
  const cf = { query };
  await installPauseSchema(cf);
  db.prepare("UPDATE native_video_release_control SET paused=1,release_id=?,current_release_id=?,paused_at=1000,updated_at=1000").run(owner, current);
  const control = await recoveryControl(cf), saved = new Map();
  const save = async (releaseId, name, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const reference = object(releaseId, name, bytes); saved.set(reference.key, bytes); return reference;
  };
  const store = { read: async ref => { const bytes = saved.get(ref.key); assert.ok(bytes); assert.equal(recoveryHash(bytes), ref.sha256); return bytes; },
    save: (name, value) => { assert.ok(!saved.has(`source/releases/native-303/${name}`)); return save("native-303", name, value); } };
  const code = Buffer.from('export default {};\n//# sourceMappingURL=index.js.map'), map = Buffer.from(JSON.stringify({ version: 3, file: "index.js", sources: ["src.ts"], sourcesContent: ["export default {}"], names: [], mappings: "" }));
  const config = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../workers/print-executor/wrangler.jsonc", import.meta.url))));
  const review = { schemaVersion: 1, worker: "forever-tee-print-executor-development", accountId: protectedConfig("cloudflareAccountId"), sourceCommit: originalSource,
    releaseId: owner, bundleSha256: recoveryHash(code), bundleBytes: code.length, configSha256: "c".repeat(64), config, migrations: config.migrations };
  const artifacts = { candidateArtifact: await save(owner, "candidate-print-executor.js", code), foundationArtifact: await save(owner, "print-executor-foundation.json", review) };
  const namespaceId = "e".repeat(32), executorSettings = { compatibility_date: "2026-08-12", compatibility_flags: ["nodejs_compat"], bindings: [
    { name: "DB", type: "d1", id: protectedConfig("resource_fb377032d2f5") },
    { name: "DESIGN_ARTWORK", type: "r2_bucket", bucket_name: "forever-tee-design-artwork-development" },
    { name: "IMAGES", type: "images" }, { name: "PRINT_EXECUTIONS", type: "durable_object_namespace", class_name: "PrintAssetExecution", namespace_id: namespaceId },
    ...Object.entries({ PRINT_EXECUTOR_SOURCE_COMMIT: originalSource, PRINT_EXECUTOR_CONFIG_SHA256: review.configSha256,
      PRINT_EXECUTOR_BUNDLE_SHA256: review.bundleSha256, PRINT_EXECUTION_RELEASE_ID: owner }).map(([name, text]) => ({ name, type: "plain_text", text })) ] };
  const apiSettings = { bindings: [{ name: "PRINT_EXECUTION_MODE", type: "plain_text", text: "durable-object" },
    { name: "PRINT_EXECUTIONS", type: "durable_object_namespace", class_name: "PrintAssetExecution", script_name: review.worker, namespace_id: namespaceId }] };
  const apiCode = Buffer.from("export default {fetch(){return new Response('synthetic predecessor')}}");
  const response = () => {
    const form = new FormData(); form.append("index.js", new Blob([code]), "index.js");
    if (state.maps) form.append("index.js.map", new Blob([map]), "index.js.map");
    if (state.extra) form.append("foreign.js", new Blob(["export default {}"]), "foreign.js");
    return new Response(form, { headers: { "cf-entrypoint": "index.js" } });
  };
  const executorResources = () => ({ bindings: executorSettings.bindings, script_runtime: { compatibility_date: executorSettings.compatibility_date,
    compatibility_flags: executorSettings.compatibility_flags, migration_tag: "print-execution-v1" } });
  const apiResources = () => ({ bindings: apiSettings.bindings, script_runtime: {} });
  const provider = (versionId, resources, content) => ({
    deployments: async () => ({ deployments: [{ versions: [{ version_id: versionId(), percentage: 100 }] }] }),
    versions: async () => ({ items: [{ id: versionId() }] }), version: async id => ({ id, resources: resources() }), content,
  });
  const apiId = "22222222-2222-4222-8222-222222222222";
  Object.assign(cf, provider(() => apiId, apiResources, async () => new Response(apiCode)));
  const client = { ...provider(() => state.activeExecutor, executorResources, async () => response()), subdomain: async () => ({ enabled: false, previews_enabled: false }) };
  const inspection = async (id, resources, content) => ({ workerVersion: id, versionResourcesSha256: versionResourcesDigest({ resources }),
    content: await workerContentManifest(content), annotations: {}, workerBytesVerified: true });
  const api = await inspection(apiId, apiResources(), new Response(apiCode)), executor = await inspection(state.activeExecutor, executorResources(), response());
  const consumer = { consumerId: "f".repeat(32), settings: { max_concurrency: 2 } };
  cf.consumers = async () => [{ type: "worker", script: "forever-tee-api-development", consumer_id: consumer.consumerId, settings: consumer.settings }];
  const stagingState = { rules: [] }, schedules = { schedules: [{ cron: "* * * * *" }] };
  const staging = { read: async () => stagingState };
  cf.schedules = async () => schedules;
  const previousArtifact = await save(owner, "previous-worker.json", { body: apiCode.toString("base64"), contentType: "application/javascript", entrypoint: "index.js", before: api, consumer });
  const prepared = { releaseId: owner, sourceCommit: originalSource, environment: "development", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2",
    worker: { printExecutor: review }, artifacts: { printExecutor: artifacts, previousArtifact }, previous: { worker: api, consumer } };
  const preparation = await save(owner, "prepared.json", prepared), preparedEvent = { ...prepared, preparation }, intent = { review, artifacts };
  await recordReleaseEvent(cf, owner, "prepared", preparedEvent, 1000);
  await recordReleaseEvent(cf, owner, "print-executor-deploy-started", intent, 2000);
  const original = { repository: "fixtures/retired-release", repositoryId: 70001, ownerId: Number(protectedConfig("githubOwnerId")), sourceCommit: originalSource, runId: 101 };
  const snapshot = { schemaVersion: 1, authentication: { method: "personal-github-api", repository: original.repository, repositoryId: original.repositoryId },
    run: { id: original.runId, run_attempt: 1, status: "completed", conclusion: "failure", event: "workflow_dispatch", head_branch: "main", head_sha: originalSource,
      path: ".github/workflows/native-development.yml", repository: { full_name: original.repository, id: original.repositoryId, owner: { id: original.ownerId } },
      head_repository: { id: original.repositoryId }, display_title: `Native development · release · full · - · - · main · ${originalSource} · synthetic` },
    operation: "release", releaseMode: "full", prepared: preparedEvent, executorIntent: intent };
  const authority = { schemaVersion: 1, kind: "development-interrupted-forward-release-v1", sourceCommit: source, control, original, environment: "development",
    accountId: protectedConfig("awsAccountId"), cloudflareAccountId: protectedConfig("cloudflareAccountId"), region: "ap-southeast-2", preparation,
    executorIntentSha256: recoveryHash(JSON.stringify(intent)), observed: { api, executor }, namespaceId, stagingLifecycle: stagingState, schedules,
    legacySidecar: { name: "index.js.map", originallySealed: false, authentication: "independent-review", bytes: map.length, sha256: recoveryHash(map),
      justification: "Synthetic independent review authenticated this exact non-executable sidecar against the approved interrupted upload.", nonExecutableImportReviewed: true },
    snapshot: await save("native-202", "forward-recovery-snapshot.json", snapshot) };
  const authorityRef = await save("native-202", "forward-recovery-authority.json", authority);
  const planRef = object("native-302", "forward-recovery-plan.json", Buffer.from("synthetic approved plan"));
  const settings = { developmentForwardRecoveryAuthoritySha256: authorityRef.sha256, developmentForwardRecoverySourceCommit: source,
    developmentForwardRecoverySnapshotSha256: authority.snapshot.sha256, developmentForwardRecoveryOriginalRepository: original.repository,
    developmentForwardRecoveryOriginalRepositoryId: String(original.repositoryId) };
  const configLookup = name => settings[name] ?? protectedConfig(name);
  const context = { ...env, NATIVE_FORWARD_RECOVERY_REFERENCE: JSON.stringify({ schemaVersion: 1, authority: authorityRef }) };
  return { db, cf, client, staging, state, store, save, saved, authority, authorityRef, planRef, configLookup, context, settings, snapshot,
    executorSettings, apiSettings, control, inspect: expectedControl => inspectInterruptedDevelopmentRelease({ cf, client, staging, store, authority, snapshot, expectedControl }) };
}

test("only dedicated first-attempt main full operations accept bounded recovery references", async t => {
  const f = await fixture(t);
  assert.equal(developmentOperation(f.context), "plan-forward-recovery");
  const execution = { ...f.context, NATIVE_OPERATION: "recover-forward-release", NATIVE_FORWARD_RECOVERY_REFERENCE: JSON.stringify({ schemaVersion: 1, authority: f.authorityRef, plan: f.planRef }) };
  assert.equal(developmentOperation(execution), "recover-forward-release");
  for (const delta of [{ NATIVE_RELEASE_MODE: "api" }, { NATIVE_OPERATION: "release" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REPOSITORY: f.authority.original.repository }, { GITHUB_REPOSITORY_ID: "70001" }, { GITHUB_REF: "refs/heads/feature" },
    { NATIVE_VERIFY_RELEASE: current }, { NATIVE_ROLLBACK_RELEASE: owner }, { NATIVE_FORWARD_RECOVERY_REFERENCE: "" },
    { GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production.yml@refs/heads/main" }])
    assert.throws(() => developmentOperation({ ...execution, ...delta }));
  assert.throws(() => forwardRecoveryReference(JSON.stringify({ schemaVersion: 1, authority: f.authorityRef, snapshot: f.snapshot }), false));
});

test("authority requires protected independent hashes and separately authenticated historical identity", async t => {
  const f = await fixture(t), args = { env: f.context, store: f.store, reference: f.authorityRef, config: f.configLookup };
  await loadForwardRecoveryAuthority(args);
  for (const field of Object.keys(f.settings)) {
    const changed = { ...f.settings, [field]: "unapproved" };
    await assert.rejects(loadForwardRecoveryAuthority({ ...args, config: name => changed[name] ?? protectedConfig(name) }));
  }
  await assert.rejects(loadForwardRecoveryAuthority({ ...args, config: protectedConfig }), /protected configuration/);
  for (const delta of [{ run_attempt: 2 }, { head_sha: source }, { id: 102 }, { conclusion: "success" }, { repository: { id: 70002 } }, { head_repository: { id: 70002 } }]) {
    const snapshot = { ...f.snapshot, run: { ...f.snapshot.run, ...delta } }, snapshotRef = await f.save("native-202", "forward-recovery-snapshot.json", snapshot);
    const authority = { ...f.authority, snapshot: snapshotRef }, reference = await f.save("native-202", "forward-recovery-authority.json", authority);
    const config = name => ({ ...f.settings, developmentForwardRecoveryAuthoritySha256: reference.sha256, developmentForwardRecoverySnapshotSha256: snapshotRef.sha256 }[name] ?? protectedConfig(name));
    await assert.rejects(loadForwardRecoveryAuthority({ ...args, reference, config }), /authenticated original/);
  }
});

test("interrupted inspector verifies exact mixed state while ordinary baseline still rejects the pause", async t => {
  const f = await fixture(t), inspected = await f.inspect();
  assert.equal(inspected.kind, "interrupted-development-release");
  assert.equal(inspected.sidecar.originallySealed, false);
  assert.equal(inspected.sidecar.observed, true);
  await assert.rejects(loadActivePrintExecutorBaseline({ api: f.cf, client: f.client, store: f.store, staging: f.staging,
    inspectWorker: () => assert.fail("ordinary baseline cannot read downstream providers") }), /verified unpaused/);
  for (const field of ["release_id", "current_release_id", "paused_at", "updated_at"]) {
    const original = f.control[field], changed = typeof original === "string" ? "native-999" : original + 1;
    f.db.prepare(`UPDATE native_video_release_control SET ${field}=?`).run(changed);
    await assert.rejects(f.inspect(), /control tuple/);
    f.db.prepare(`UPDATE native_video_release_control SET ${field}=?`).run(original);
  }
  f.state.extra = true; await assert.rejects(f.inspect(), /provider bytes/); f.state.extra = false;
  f.state.maps = false; await assert.rejects(f.inspect(), /provider bytes/); f.state.maps = true;
  for (const name of ["DB", "PRINT_EXECUTIONS", "PRINT_EXECUTION_RELEASE_ID", "PRINT_EXECUTOR_SOURCE_COMMIT"]) {
    const binding = f.executorSettings.bindings.find(item => item.name === name), prior = structuredClone(binding);
    Object.assign(binding, { id: "foreign", namespace_id: "f".repeat(32), text: "foreign" });
    await assert.rejects(f.inspect(), /provider bytes/);
    Object.keys(binding).forEach(key => delete binding[key]); Object.assign(binding, prior);
  }
  const privateEndpoint = f.client.subdomain;
  f.client.subdomain = async () => ({ enabled: true, previews_enabled: false });
  await assert.rejects(f.inspect(), /remain private/); f.client.subdomain = privateEndpoint;
  const read = f.client.deployments; let reads = 0;
  f.client.deployments = async () => { if (++reads > 1) f.state.activeExecutor = "33333333-3333-4333-8333-333333333333"; return read(); };
  await assert.rejects(f.inspect(), /changed during inspection/);
});

test("D1 journal gives two claimants one winner and preserves the old immutable history", async t => {
  const f = await fixture(t), preparation = object("native-303", "prepared.json", Buffer.from("new preparation"));
  const claim = id => claimForwardRecovery({ cf: f.cf, control: f.control, releaseId: id, sourceCommit: source, authority: f.authorityRef, plan: f.planRef, preparation, now: 10000 });
  const before = f.db.prepare("SELECT * FROM native_video_release_events").all();
  const results = await Promise.allSettled([claim("native-303"), claim("native-304")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = results.find(result => result.status === "fulfilled").value.release_id;
  assert.ok(["native-303", "native-304"].includes(winner));
  assert.deepEqual(await recoveryControl(f.cf), { ...f.control, release_id: winner, paused_at: 10000, updated_at: 10000 });
  for (const row of before) assert.deepEqual(f.db.prepare("SELECT * FROM native_video_release_events WHERE release_id=? AND stage=?").get(row.release_id, row.stage), row);
  await assert.rejects(claim(winner), /control changed|one-use/);
  assert.throws(() => f.db.exec("DELETE FROM native_video_release_events"), /immutable/);
});

test("lost claim or CAS acknowledgement leaves a consumed journal and admits inspection only", async t => {
  for (const lost of ["lostClaim", "lostCas"]) {
    const f = await fixture(t); f.state[lost] = true;
    const input = { cf: f.cf, control: f.control, releaseId: "native-303", sourceCommit: source, authority: f.authorityRef, plan: f.planRef,
      preparation: object("native-303", "prepared.json", Buffer.from("new preparation")), now: 10000 };
    await assert.rejects(claimForwardRecovery(input), /lost/);
    f.state[lost] = false;
    await assert.rejects(claimForwardRecovery(input), /one-use|control changed/);
    assert.equal((await recoveryControl(f.cf)).paused, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='forward-recovery-claimed'").get().n, 1);
  }
});

async function executionFixture(t, failure) {
  const f = await fixture(t), calls = [];
  let time = 10000, imageApplied = false, transferred;
  const candidate = { imageDigest: `sha256:${"d".repeat(64)}`, sourceDigest: "e".repeat(64) }, runtime = { renderer: candidate, failure: candidate };
  const step = name => {
    assert.equal(f.db.prepare("SELECT paused FROM native_video_release_control").get().paused, 1);
    calls.push(name); if (failure === name) throw Error(`injected ${name}`);
  };
  const release = { releaseId: "native-303", sourceCommit: source, candidate, authority: f.authorityRef, reviewedPlan: f.planRef, interrupted: await f.inspect() };
  const image = { review: { planSha256: "f".repeat(64) }, apply: async () => {
    step("image"); assert.ok(f.db.prepare("SELECT 1 FROM native_video_release_events WHERE stage='image-apply-started'").get());
  } };
  const worker = { review: {}, migrate: async () => { step("migration"); assert.ok(f.db.prepare("SELECT 1 FROM native_video_release_events WHERE stage='forward-migration-started'").get()); },
    deploy: async (_id, _candidate, executorApplied) => {
      await recordReleaseEvent(f.cf, release.releaseId, "print-staging-lifecycle-started", { synthetic: true }); step("lifecycle");
      await recordReleaseEvent(f.cf, release.releaseId, "print-executor-deploy-started", { synthetic: true }); step("executor"); executorApplied();
      step("api"); return { workerVersion: "new-secure-version" };
    }, verifyDeployed: async () => step("final-worker") };
  const input = { cf: f.cf, store: f.store, release, image, worker, now: () => time, wait: async ms => { assert.ok(ms <= 15000); time += ms; },
    verifyBefore: async () => { assert.ok(equal(await recoveryControl(f.cf), transferred ?? f.control)); },
    transfer: async saved => { transferred = await claimForwardRecovery({ cf: f.cf, control: f.control, releaseId: release.releaseId, sourceCommit: source,
      authority: f.authorityRef, plan: f.planRef, preparation: saved, now: time }); return transferred; },
    beforeMutation: async () => { assert.ok(time - transferred.paused_at >= 300000); assert.ok(equal(await recoveryControl(f.cf), transferred)); },
    imageApplied: () => { imageApplied = true; }, executorApplied: () => {}, inspectRuntime: async () => imageApplied ? runtime : {},
    probeRuntime: async () => { step("startup"); return { startupVerified: true }; }, verifyStatus: async () => { step("status"); return { protocolVerified: true }; } };
  return { ...f, input, calls };
}

test("full recovery holds the fresh all-family drain and resumes only the complete new generation", async t => {
  const f = await executionFixture(t);
  const result = await executeForwardRecovery(f.input);
  assert.equal(result.forwardRecovery.rollbackQualified, false);
  assert.equal((await recoveryControl(f.cf)).current_release_id, "native-303");
  assert.equal((await recoveryControl(f.cf)).paused, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE release_id=? AND stage='verified'").get(owner).n, 0);
  assert.equal(f.db.prepare("SELECT status FROM print_asset_jobs").get().status, "pending");
  assert.equal(f.db.prepare("SELECT status FROM artwork_preparation_jobs").get().status, "pending");
  assert.equal(f.db.prepare("SELECT status FROM product_image_jobs").get().status, "queued");
  assert.deepEqual(f.calls, ["migration", "image", "startup", "lifecycle", "executor", "api", "final-worker", "status", "final-worker"]);
});

test("failures after each durable mutation intent keep the exact new pause owner and never replay writes", async t => {
  for (const failure of ["migration", "image", "startup", "lifecycle", "executor", "api", "final-worker", "status"]) {
    const f = await executionFixture(t, failure);
    await assert.rejects(executeForwardRecovery(f.input), /injected/);
    assert.equal((await recoveryControl(f.cf)).paused, 1);
    assert.equal((await recoveryControl(f.cf)).release_id, "native-303");
    await assert.rejects(executeForwardRecovery(f.input));
    for (const name of ["migration", "image", "lifecycle", "executor", "api"]) assert.ok(f.calls.filter(call => call === name).length <= 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='verified'").get().n, 0);
  }
});

test("approved Worker comparison changes only the distinct execution generation", () => {
  const plan = { schemaVersion: 2, content: { sha256: "a".repeat(64) }, printExecutor: { schemaVersion: 2, releaseId: "native-302", before: { interrupted: { kind: "interrupted-development-release" } } } };
  const execution = structuredClone(plan); execution.printExecutor.releaseId = "native-303";
  assert.deepEqual(forwardWorkerPlan(plan, "native-302"), forwardWorkerPlan(execution, "native-303"));
  execution.content.sha256 = "b".repeat(64);
  assert.notDeepEqual(forwardWorkerPlan(plan, "native-302"), forwardWorkerPlan(execution, "native-303"));
  assert.throws(() => forwardWorkerPlan(plan, "native-303"));
});

test("dispatch sealing authenticates recovery references to current source and the private authority run", async t => {
    const f = await fixture(t), input = f.context.NATIVE_FORWARD_RECOVERY_REFERENCE;
    const sealed = sealDispatchInputs({ forward_recovery_reference: input }, source);
    assert.ok(!sealed.forward_recovery_reference.includes(f.authorityRef.sha256));
    const context = { ...process.env, GITHUB_SHA: source, NATIVE_FORWARD_RECOVERY_REFERENCE: sealed.forward_recovery_reference };
    resolveDispatchInputs(context);
    assert.equal(context.NATIVE_FORWARD_RECOVERY_REFERENCE, input);
    assert.throws(() => resolveDispatchInputs({ ...context, GITHUB_SHA: originalSource, NATIVE_FORWARD_RECOVERY_REFERENCE: sealed.forward_recovery_reference }));
    const changed = JSON.parse(sealed.forward_recovery_reference); changed.runId = "999";
    assert.throws(() => resolveDispatchInputs({ GITHUB_SHA: source, NATIVE_FORWARD_RECOVERY_REFERENCE: JSON.stringify(changed) }));
});
test("exact CAS rejects changed control fields after the immutable claim was recorded", async t => {
    for (const [field, changed] of [["release_id", "native-999"], ["current_release_id", "native-999"], ["paused_at", 1001], ["updated_at", 1001]]) {
        const f = await fixture(t), baseQuery = f.cf.query;
        f.cf.query = async (sql, params) => {
            const result = await baseQuery(sql, params);
            if (sql.startsWith("INSERT INTO native_video_release_events") && params[1] === "forward-recovery-claimed")
                f.db.prepare(`UPDATE native_video_release_control SET ${field}=?`).run(changed);
            return result;
        };
        await assert.rejects(claimForwardRecovery({ cf: f.cf, control: f.control, releaseId: "native-303", sourceCommit: source,
            authority: f.authorityRef, plan: f.planRef, preparation: object("native-303", "prepared.json", Buffer.from("new")), now: 10000 }), /pause transfer/);
        assert.equal((await recoveryControl(f.cf)).paused, 1);
        assert.notEqual((await recoveryControl(f.cf)).release_id, "native-303");
    }
});

test("plan and execution wiring require protected plan approval and reuse its exact candidate and module artifacts", async t => {
    const f = await fixture(t), originalConfig = process.env.SHOP_PROTECTED_CONFIG_JSON;
    t.after(() => { process.env.SHOP_PROTECTED_CONFIG_JSON = originalConfig; });
    const config = { ...JSON.parse(originalConfig), ...f.settings };
    process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(config);
    f.db.exec("CREATE TABLE d1_migrations(name TEXT)");
    for (const name of (await readdir(new URL("../workers/api/drizzle/", import.meta.url))).filter(name => /^\d{4}_.+\.sql$/.test(name)))
        f.db.prepare("INSERT INTO d1_migrations VALUES (?)").run(name);
    let time = 10000, runtime = { runtimeVerified: true, environment: "development", renderer: { imageDigest: "old" }, failure: { imageDigest: "old" } }, mainReads = 0;
    const candidate = { environment: "development", imageDigest: `sha256:${"d".repeat(64)}`, sourceDigest: "e".repeat(64), candidateVerified: true, reused: true, verifiedForCommit: source };
    const planBytes = Buffer.from("synthetic saved Terraform plan"), imageReview = { planSha256: recoveryHash(planBytes), sourceCommit: source,
        imageDigest: candidate.imageDigest, sourceDigest: candidate.sourceDigest };
    const code = Buffer.from("export default {}"), map = Buffer.from(JSON.stringify({ version: 3, file: "index.js", sources: [], names: [], mappings: "" }));
    const content = await workerContentManifest(workerContentResponse({ code, map }));
    const uploadReview = { schemaVersion: 2, content, sourceCommit: source, bundleSha256: content.modules[0].sha256, bundleBytes: code.length };
    const stores = id => ({ read: f.store.read, save: async (name, bytes) => {
        assert.ok(!f.saved.has(`source/releases/native-${id}/${name}`)); return f.save(`native-${id}`, name, bytes);
    } });
    const calls = [], dependencies = id => ({ cf: f.cf, client: f.client, staging: f.staging, store: stores(id), currentMain: async () => { mainReads++; },
        identity: async context => ({ signatureVerified: true, runId: context.GITHUB_RUN_ID, sourceCommit: source }),
        bindings: async () => ({ cloudflareVerified: true }), inspectRuntime: async () => runtime, candidate: async () => candidate,
        now: () => time, wait: async ms => { time += ms; }, probeRuntime: async () => ({ startupVerified: true }), verifyStatus: async () => ({ protocolVerified: true }),
        image: async (_candidate, _env, options) => {
            calls.push(options.sealedPlan ? "reuse-plan" : "prepare-plan");
            if (options.sealedPlan) assert.deepEqual(await f.store.read(options.sealedPlan.reference), planBytes);
            return { review: imageReview, preserve: store => store.save("candidate.tfplan", planBytes), apply: async () => {
                runtime = { runtimeVerified: true, environment: "development", renderer: candidate, failure: candidate };
            } };
        },
        worker: async (context, { recovery }) => {
            calls.push(recovery.sealedWorker ? "reuse-upload" : "prepare-upload");
            if (recovery.sealedWorker) {
                assert.equal(recovery.sealedWorker.artifacts.candidateArtifact.key, "source/releases/native-303/candidate-worker.js");
                assert.equal(recovery.sealedExecutor.artifacts.candidateMapArtifact.key, "source/releases/native-303/candidate-print-executor-map.json");
            }
            const interrupted = await recovery.verifyPrevious(), review = { ...uploadReview, printExecutor: { ...uploadReview,
                releaseId: `native-${context.GITHUB_RUN_ID}`, before: { interrupted }, stagingLifecycle: { mutationRequired: false } } };
            return { review, before: interrupted.api, consumer: {}, verifyPrintExecutor: async () => {}, verifyDeployed: async () => {}, migrate: async () => {},
                preserve: async store => ({ candidateArtifact: await store.save("candidate-worker.js", code), candidateMapArtifact: await store.save("candidate-worker-map.json", map),
                    printExecutor: { candidateArtifact: await store.save("candidate-print-executor.js", code), candidateMapArtifact: await store.save("candidate-print-executor-map.json", map) } }),
                deploy: async (_releaseId, _candidate, executorApplied) => {
                    await recovery.beforeMutation("executor-deploy"); executorApplied(); await recovery.beforeMutation("api-deploy");
                    return { workerVersion: "synthetic-new-worker" };
                } };
        } });
    const planning = { ...f.context, NATIVE_CANDIDATE_RECEIPT: "{}" };
    const plan = await runDevelopmentForwardRecovery(planning, dependencies("303"));
    assert.equal(plan.deploymentPerformed, false);
    assert.deepEqual(await recoveryControl(f.cf), f.control);
    const execution = { ...planning, GITHUB_RUN_ID: "304", NATIVE_OPERATION: "recover-forward-release",
        NATIVE_FORWARD_RECOVERY_REFERENCE: JSON.stringify({ schemaVersion: 1, authority: f.authorityRef, plan: plan.plan }) };
    await assert.rejects(runDevelopmentForwardRecovery(execution, dependencies("304")), /protected configuration.*PlanSha256/);
    assert.deepEqual(await recoveryControl(f.cf), f.control);
    config.developmentForwardRecoveryPlanSha256 = plan.plan.sha256;
    process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(config);
    const result = await runDevelopmentForwardRecovery(execution, dependencies("304"));
    assert.equal(result.releaseId, "native-304");
    assert.equal((await recoveryControl(f.cf)).paused, 0);
    assert.deepEqual(calls, ["prepare-plan", "prepare-upload", "reuse-plan", "reuse-upload"]);
    assert.equal(mainReads, 4);
});

test("the final resume refuses changed current generation or timestamps even after provider verification", async t => {
    for (const field of ["current_release_id", "paused_at", "updated_at"]) {
        const f = await executionFixture(t), verify = f.input.verifyStatus;
        f.input.verifyStatus = async () => {
            const result = await verify();
            f.db.prepare(`UPDATE native_video_release_control SET ${field}=?`).run(field === "current_release_id" ? "native-999" : 2000);
            return result;
        };
        await assert.rejects(executeForwardRecovery(f.input), /exact control changed/);
        assert.equal((await recoveryControl(f.cf)).paused, 1);
        assert.equal(f.db.prepare("SELECT count(*) AS n FROM native_video_release_events WHERE stage='verified'").get().n, 0);
    }
});

test("fresh drain deadline leaves a still-live print lease and the new pause owner intact", async t => {
    const f = await executionFixture(t);
    f.db.exec("UPDATE print_asset_jobs SET next_attempt_at=5000000");
    await assert.rejects(executeForwardRecovery(f.input), /twenty minutes/);
    assert.deepEqual(f.calls, []);
    assert.equal((await recoveryControl(f.cf)).paused, 1);
    assert.equal((await recoveryControl(f.cf)).release_id, "native-303");
    assert.equal(f.db.prepare("SELECT status FROM print_asset_jobs").get().status, "running");
});
