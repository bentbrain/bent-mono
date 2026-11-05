import { resolveProtectedTemplate } from "./protected-config.mjs";
import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPrintExecutorFoundationRelease, developmentPrintExecutorClient, PRINT_EXECUTOR, printExecutorProtocol, verifyApiPrintExecutorBinding, verifyPrintExecutorConfig, verifyPrintExecutorLifecycle, verifyPrintExecutorSettings, verifyRecordedPrintExecutor, verifyRestoredPrintExecutor, restoreDevelopmentPrintExecutor, loadActivePrintExecutorBaseline } from "./native-print-executor.mjs";
import { printExecutorCommandArguments, versionResourcesDigest } from "./native-ci-worker.mjs";
import { planPrintStagingLifecycle, printStagingLifecycleProtocol } from "./native-print-staging-lifecycle.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
const configBytes = await readFile(new URL("../workers/print-executor/wrangler.jsonc", import.meta.url));
const config = JSON.parse(resolveProtectedTemplate(configBytes));
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40),
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", NATIVE_OPERATION: "release",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main",
    CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"), CLOUDFLARE_API_TOKEN: "fixture-secret",
    WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev" };
test("executor config and command cannot select another account, environment or lifecycle", () => {
    assert.equal(verifyPrintExecutorConfig(config), true);
    for (const delta of [{ account_id: "work" }, { workers_dev: true }, { preview_urls: true }, { routes: ["public.example/*"] },
        { migrations: [{ tag: "next", deleted_classes: ["PrintAssetExecution"] }] },
        { env: { ...config.env, production: config.env.development } }])
        assert.throws(() => verifyPrintExecutorConfig({ ...config, ...delta }));
    const args = printExecutorCommandArguments(["deploy", "/tmp/index.js", "--no-bundle", "--env", "development"]);
    assert.equal(args.at(-1), new URL("../workers/print-executor/wrangler.jsonc", import.meta.url).pathname);
    assert.equal(args.filter(value => value === "--config").length, 1);
});
test("only exact Worker-not-found response establishes an absent executor", async () => {
    const client = developmentPrintExecutorClient(env, async (url, options) => {
        assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PRINT_EXECUTOR}/settings`);
        assert.equal(options.method, "GET");
        return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    });
    assert.equal(await client.absentSettings(), null);
    for (const response of [Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 403 }),
        Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 404 }), new Response("fixture-secret", { status: 404 })]) {
        await assert.rejects(developmentPrintExecutorClient(env, async () => response).absentSettings(), error => !error.message.includes("fixture-secret"));
    }
    assert.throws(() => developmentPrintExecutorClient({ ...env, CLOUDFLARE_ACCOUNT_ID: "work" }, () => assert.fail()));
});
async function foundation(t, environment = "development") {
    const protocol = printExecutorProtocol(environment);
    const context = environment === "development" ? env : { ...env,
        GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production.yml@refs/heads/main",
        WORKER_URL: "https://forever-tee-api.socialqueue.workers.dev" };
    const configBytes = await readFile(new URL(environment === "development"
        ? "../workers/print-executor/wrangler.jsonc" : "../workers/print-executor/wrangler.production.jsonc", import.meta.url));
    const config = JSON.parse(resolveProtectedTemplate(configBytes)), PRINT_EXECUTOR = `forever-tee-print-executor-${environment}`;
    const planPrintStagingLifecycle = printStagingLifecycleProtocol(environment).planPrintStagingLifecycle;
    const directory = await mkdtemp(join(tmpdir(), "print-executor-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const entrypoint = join(directory, "index.js"), bundle = Buffer.from("approved executor");
    await writeFile(entrypoint, bundle);
    const review = { schemaVersion: 1, worker: PRINT_EXECUTOR, accountId: context.CLOUDFLARE_ACCOUNT_ID,
        sourceCommit: context.GITHUB_SHA, releaseId: "native-123", configSha256: hash(configBytes), bundleSha256: hash(bundle),
        bundleBytes: bundle.length, config, migrations: config.migrations,
        before: { exists: false, worker: PRINT_EXECUTOR, accountId: context.CLOUDFLARE_ACCOUNT_ID, absence: "HTTP404/error10007" },
        stagingLifecycle: planPrintStagingLifecycle({ rules: [{ id: "Default Multipart Abort Rule", enabled: true, conditions: {},
                    abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } }] }) };
    const settings = { compatibility_date: "2026-08-12", compatibility_flags: ["nodejs_compat"],
        bindings: [{ name: "DB", type: "d1", id: environment === "development" ? protectedConfig("resource_fb377032d2f5") : protectedConfig("resource_1a1378f0d1dc") },
            { name: "DESIGN_ARTWORK", type: "r2_bucket", bucket_name: `forever-tee-design-artwork-${environment}` },
            { name: "IMAGES", type: "images" }, { name: "PRINT_EXECUTIONS", type: "durable_object_namespace",
                class_name: "PrintAssetExecution", namespace_id: "b".repeat(32) },
            ...Object.entries({ PRINT_EXECUTOR_SOURCE_COMMIT: review.sourceCommit, PRINT_EXECUTOR_CONFIG_SHA256: review.configSha256,
                PRINT_EXECUTOR_BUNDLE_SHA256: review.bundleSha256, PRINT_EXECUTION_RELEASE_ID: review.releaseId })
                .map(([name, text]) => ({ name, text, type: "plain_text" }))] };
    const resources = () => ({ script_runtime: { migration_tag: "print-execution-v1", compatibility_date: settings.compatibility_date, compatibility_flags: settings.compatibility_flags }, bindings: structuredClone(settings.bindings) });
    const worker = { workerVersion: "11111111-1111-4111-8111-111111111111", versionResourcesSha256: versionResourcesDigest({ resources: resources() }),
        content: { entrypoint: "index.js", modules: [{ name: "index.js", bytes: bundle.length, sha256: hash(bundle) }] } };
    const state = { exists: false, calls: [], events: new Map(), worker, paused: true, releaseId: "native-123", currentReleaseId: "native-123", failDeploy: false,
        lifecycle: review.stagingLifecycle.before };
    const staging = { read: async () => state.lifecycle, append: async (plan) => {
            assert.ok(state.events.has("print-staging-lifecycle-started"));
            assert.deepEqual(state.lifecycle, plan.before);
            state.lifecycle = plan.after;
            return state.lifecycle;
        } };
    const client = { absentSettings: async () => state.exists ? settings : null, settings: async () => settings,
        version: async (id) => ({ id, resources: resources() }),
        deployments: async () => ({ deployments: [{ versions: [{ version_id: state.worker.workerVersion, percentage: 100 }] }] }),
        subdomain: async () => ({ enabled: false, previews_enabled: false }) };
    const apiSettings = { bindings: [{ name: "PRINT_EXECUTION_MODE", type: "plain_text", text: "durable-object" },
            { name: "PRINT_EXECUTIONS", type: "durable_object_namespace", class_name: "PrintAssetExecution",
                script_name: PRINT_EXECUTOR, namespace_id: "b".repeat(32) }] };
    const api = { settings: async () => apiSettings,
        deployments: async () => ({ deployments: [{ versions: [{ version_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", percentage: 100 }] }] }),
        version: async (id) => ({ id, resources: { bindings: apiSettings.bindings, script_runtime: {} } }), query: async (sql, params) => {
            if (sql.includes("native_video_release_control"))
                return [{ results: [{ paused: state.paused ? 1 : 0, release_id: state.paused ? state.releaseId : null, current_release_id: state.currentReleaseId, paused_at: 1000 }] }];
            if (sql.startsWith("SELECT release_id"))
                return [{ results: state.events.has("print-executor-deploy-started") ? [{ release_id: "native-123" }] : [] }];
            if (sql.startsWith("INSERT"))
                state.events.set(params[1], params[2]);
            const stage = /stage = '([^']+)'/.exec(sql)?.[1] ?? params[1];
            return [{ results: state.events.has(stage) ? [{ payload: state.events.get(stage) }] : [] }];
        } };
    const saved = new Map();
    const store = { save: async (name, bytes) => { assert.ok(!saved.has(name)); saved.set(name, bytes); return { key: name }; },
        read: async (ref) => { assert.ok(saved.has(ref.key)); return saved.get(ref.key); } };
    const inspectWorker = async () => state.worker;
    const run = async (args) => {
        assert.ok(state.events.has("print-executor-deploy-started"));
        state.calls.push(args);
        state.exists = true;
        if (state.failDeploy)
            throw new Error("uncertain creation");
    };
    const release = protocol.createPrintExecutorFoundationRelease({ env: context, review, bundle, entrypoint, run, api, client, inspectWorker, staging });
    return { release, protocol, context, state, store, review, api, client, inspectWorker, settings, apiSettings, staging, entrypoint, bundle, run, resources };
}
test("foundation saves immutable intent before creation and verifies exact namespace/version before API activation", async (t) => {
    const f = await foundation(t);
    await assert.rejects(f.release.deploy("native-123"), /preserved/u);
    const artifacts = await f.release.preserve(f.store);
    const deployed = await f.release.deploy("native-123");
    assert.equal(f.state.calls.length, 1);
    assert.equal(deployed.namespaceId, "b".repeat(32));
    assert.ok(f.state.events.has("print-executor-verified"));
    assert.ok(f.state.calls[0].includes("PRINT_EXECUTION_RELEASE_ID:native-123"));
    await f.release.verifyDeployed();
    const prepared = { releaseId: "native-123", sourceCommit: env.GITHUB_SHA, worker: { printExecutor: f.review }, artifacts: { printExecutor: artifacts } };
    assert.equal((await verifyRecordedPrintExecutor({ env, api: f.api, prepared, store: f.store,
        inspectWorker: f.inspectWorker, client: f.client, staging: f.staging })).namespaceId, deployed.namespaceId);
    f.state.worker = { ...f.state.worker, workerVersion: "22222222-2222-4222-8222-222222222222" };
    await assert.rejects(f.release.verifyDeployed(), /changed/u);
    await assert.rejects(verifyRecordedPrintExecutor({ env, api: f.api, prepared, store: f.store,
        inspectWorker: f.inspectWorker, client: f.client, staging: f.staging }), /changed/u);
});
test("executor presence drift and uncertain creation cannot be overwritten or replayed", async (t) => {
    const f = await foundation(t);
    await f.release.preserve(f.store);
    f.state.exists = true;
    await assert.rejects(f.release.deploy("native-123"), /appeared/u);
    assert.equal(f.state.calls.length, 0);
    f.state.exists = false;
    f.state.failDeploy = true;
    await assert.rejects(f.release.deploy("native-123"), /uncertain/u);
    await assert.rejects(f.release.deploy("native-123"), /first-attempt/u);
    assert.equal(f.state.calls.length, 1);
});
test("executor lifecycle refuses unowned pause, wrong release, and mutable resource changes", async (t) => {
    const f = await foundation(t);
    await f.release.preserve(f.store);
    await assert.rejects(f.release.deploy("native-124"), /first-attempt/u);
    f.state.paused = false;
    await assert.rejects(f.release.deploy("native-123"), /pause ownership/u);
    assert.equal(f.state.calls.length, 0);
    const wrong = structuredClone(f.settings);
    wrong.bindings.find(binding => binding.name === "PRINT_EXECUTION_RELEASE_ID").text = "native-124";
    assert.throws(() => verifyPrintExecutorSettings(wrong, f.review), /generation/u);
    wrong.bindings.push({ name: "FOREIGN", type: "service", service: "foreign" });
    assert.throws(() => verifyPrintExecutorSettings(wrong, f.review), /exact/u);
});
test("absent executor with a previous creation intent requires recovery rather than another creation", async (t) => {
    const f = await foundation(t);
    f.state.events.set("print-executor-deploy-started", JSON.stringify({ releaseId: "native-122" }));
    await assert.rejects(f.release.preserve(f.store), /prior executor creation intent/u);
    assert.equal(f.state.calls.length, 0);
});
test("API activation requires the exact external executor and cannot silently fall back to queue", async (t) => {
    const f = await foundation(t);
    assert.equal(verifyApiPrintExecutorBinding(f.apiSettings, { namespaceId: "b".repeat(32) }), true);
    for (const delta of [{ namespace_id: "c".repeat(32) }, { script_name: "another-worker" }, { class_name: "AnotherClass" },
        { type: "service" }, { environment: "production" }]) {
        const changed = structuredClone(f.apiSettings);
        Object.assign(changed.bindings[1], delta);
        assert.throws(() => verifyApiPrintExecutorBinding(changed, { namespaceId: "b".repeat(32) }), /API print binding/u);
    }
    for (const mode of ["queue", "", "unknown"]) {
        const changed = structuredClone(f.apiSettings);
        changed.bindings[0].text = mode;
        assert.throws(() => verifyApiPrintExecutorBinding(changed, { namespaceId: "b".repeat(32) }), /mode/u);
    }
    assert.throws(() => verifyApiPrintExecutorBinding({ bindings: [f.apiSettings.bindings[1]] }, { namespaceId: "b".repeat(32) }), /mode/u);
    assert.throws(() => verifyApiPrintExecutorBinding({ bindings: [...f.apiSettings.bindings, f.apiSettings.bindings[1]] }, { namespaceId: "b".repeat(32) }), /binding/u);
});
test("qualification rejects a changed API namespace even when executor artifact and version still match", async (t) => {
    const f = await foundation(t);
    const artifacts = await f.release.preserve(f.store);
    await f.release.deploy("native-123");
    const prepared = { releaseId: "native-123", sourceCommit: env.GITHUB_SHA,
        worker: { printExecutor: f.review }, artifacts: { printExecutor: artifacts } };
    f.apiSettings.bindings[1].namespace_id = "c".repeat(32);
    await assert.rejects(verifyRecordedPrintExecutor({ env, api: f.api, prepared, store: f.store,
        inspectWorker: f.inspectWorker, client: f.client, staging: f.staging }), /API print binding/u);
});
test("executor migration verification reads immutable version runtime metadata, not script settings", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.deepEqual(verifyPrintExecutorLifecycle({ id, resources: { script_runtime: { migration_tag: "print-execution-v1" } } }, id), { migrationTag: "print-execution-v1" });
    for (const version of [{ id, migration_tag: "print-execution-v1" },
        { id, resources: { script_runtime: { migration_tag: "changed" } } },
        { id: "other", resources: { script_runtime: { migration_tag: "print-execution-v1" } } }])
        assert.throws(() => verifyPrintExecutorLifecycle(version, id), /lifecycle/u);
});
test("qualification requires the live staging cleanup fallback and preserved original rules", async (t) => {
    const f = await foundation(t);
    const artifacts = await f.release.preserve(f.store);
    await f.release.deploy("native-123");
    const prepared = { releaseId: "native-123", sourceCommit: env.GITHUB_SHA,
        worker: { printExecutor: f.review }, artifacts: { printExecutor: artifacts } };
    f.state.lifecycle = f.review.stagingLifecycle.before;
    await assert.rejects(verifyRecordedPrintExecutor({ env, api: f.api, prepared, store: f.store,
        inspectWorker: f.inspectWorker, client: f.client, staging: f.staging }), /lifecycle readback/u);
});
async function deployedFoundation(t) {
    const f = await foundation(t);
    const artifacts = await f.release.preserve(f.store);
    const recorded = await f.release.deploy("native-123");
    const prepared = { releaseId: "native-123", sourceCommit: env.GITHUB_SHA,
        worker: { printExecutor: f.review }, artifacts: { printExecutor: artifacts } };
    return { ...f, artifacts, recorded, prepared };
}
test("API image reuse prepares the verified existing print executor without allowing foundation creation or changed inputs", async (t) => {
    const f = await deployedFoundation(t);
    f.state.paused = false;
    f.state.events.set("verified", JSON.stringify({ worker: { printExecutor: f.recorded } }));
    const directory = await mkdtemp(join(tmpdir(), "api-executor-preparation-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const input = { env: { ...env, NATIVE_RELEASE_MODE: "api", RUNNER_TEMP: directory }, directory,
        platform: "linux", api: f.api, client: f.client, staging: f.staging,
        baselineStore: f.store, inspectWorker: f.inspectWorker,
        run: async (args) => {
            const out = args[args.indexOf("--outdir") + 1];
            await mkdir(out, { recursive: true });
            await writeFile(join(out, "index.js"), f.bundle);
        } };
    const prepared = await f.protocol.preparePrintExecutorFoundation(input);
    assert.equal(prepared.review.before.recorded.namespaceId, f.recorded.namespaceId);
    assert.equal(prepared.review.bundleSha256, hash(f.bundle));
    await assert.rejects(f.protocol.preparePrintExecutorFoundation({ ...input,
        client: { ...f.client, absentSettings: async () => null } }), /existing unchanged executor/u);
    await assert.rejects(f.protocol.preparePrintExecutorFoundation({ ...input,
        run: async (args) => {
            const out = args[args.indexOf("--outdir") + 1];
            await mkdir(out, { recursive: true });
            await writeFile(join(out, "index.js"), "changed executor");
        } }), /existing unchanged executor/u);
    await assert.rejects(f.protocol.preparePrintExecutorFoundation({ ...input, platform: "darwin" }), /cloud-only/u);
});
function queueApi(f) { f.apiSettings.bindings = []; }
function executorApi(f) {
    f.apiSettings.bindings = [
        { name: "PRINT_EXECUTION_MODE", type: "plain_text", text: "durable-object" },
        { name: "PRINT_EXECUTIONS", type: "durable_object_namespace", class_name: "PrintAssetExecution",
            script_name: PRINT_EXECUTOR, namespace_id: "b".repeat(32) },
    ];
}
async function nextExecutor(f, { previousMode = "durable-object", uncertain = false } = {}) {
    const previous = f.recorded;
    const nextEnv = { ...env, GITHUB_RUN_ID: "124" };
    const review = { ...f.review, releaseId: "native-124", before: { exists: true, worker: PRINT_EXECUTOR,
            accountId: env.CLOUDFLARE_ACCOUNT_ID, apiMode: previousMode, recorded: previous },
        stagingLifecycle: planPrintStagingLifecycle(f.state.lifecycle) };
    const store = { save: (name, bytes) => f.store.save(`next-${name}`, bytes), read: f.store.read };
    const run = async (args) => {
        f.state.calls.push(args);
        f.state.worker = { ...f.state.worker, workerVersion: "22222222-2222-4222-8222-222222222222" };
        f.settings.bindings.find(binding => binding.name === "PRINT_EXECUTION_RELEASE_ID").text = "native-124";
        f.state.worker.versionResourcesSha256 = versionResourcesDigest({ resources: f.resources() });
        if (uncertain)
            throw new Error("lost deployment acknowledgement");
    };
    const release = createPrintExecutorFoundationRelease({ env: nextEnv, review, bundle: f.bundle,
        entrypoint: f.entrypoint, run, api: f.api, client: f.client, inspectWorker: f.inspectWorker,
        staging: f.staging, baselineStore: f.store });
    const artifacts = await release.preserve(store);
    f.state.releaseId = "native-124";
    const prepared = { releaseId: "native-124", sourceCommit: env.GITHUB_SHA,
        worker: { printExecutor: review }, artifacts: { printExecutor: artifacts } };
    return { release, prepared, previous, store };
}
function rollbackContext(f, prepared, store = f.store) {
    f.state.releaseId = "native-125";
    const calls = [];
    const client = { ...f.client, version: async (id) => {
            const value = await f.client.version(id);
            const previous = prepared.worker.printExecutor.before.recorded;
            if (previous && id === previous.worker.workerVersion)
                value.resources.bindings.find(binding => binding.name === "PRINT_EXECUTION_RELEASE_ID").text = previous.releaseId;
            return value;
        }, restoreVersion: async (id) => {
            calls.push(id);
            const previous = prepared.worker.printExecutor.before.recorded;
            assert.equal(id, previous.worker.workerVersion);
            f.state.worker = previous.worker;
            f.settings.bindings.find(binding => binding.name === "PRINT_EXECUTION_RELEASE_ID").text = previous.releaseId;
        } };
    return { calls, input: { env: { ...env, NATIVE_OPERATION: "rollback", GITHUB_RUN_ID: "125", NATIVE_ROLLBACK_RELEASE: prepared.releaseId },
            api: f.api, store, prepared, releaseId: "native-125", client, inspectWorker: f.inspectWorker, staging: f.staging } };
}
test("later release preserves and updates only its verified namespace, then restores exact predecessor generation", async (t) => {
    const f = await deployedFoundation(t);
    const next = await nextExecutor(f);
    const deployed = await next.release.deploy("native-124");
    assert.equal(deployed.namespaceId, f.recorded.namespaceId);
    assert.equal(deployed.releaseId, "native-124");
    const recovery = rollbackContext(f, next.prepared, next.store);
    const result = await restoreDevelopmentPrintExecutor(recovery.input);
    assert.deepEqual(recovery.calls, [f.recorded.worker.workerVersion]);
    assert.deepEqual(result.restored, f.recorded);
    assert.equal(result.retained, null);
    await result.verify();
    f.state.paused = false;
    f.state.currentReleaseId = "native-125";
    f.state.events.set("verified", JSON.stringify({ rollbackVerified: true, worker: { printExecutor: result.restored } }));
    assert.deepEqual(await loadActivePrintExecutorBaseline({ ...recovery.input, client: recovery.input.client }), f.recorded);
});
test("queue rollback retains ownership without authorizing alarms and permits a later safe update", async (t) => {
    const f = await deployedFoundation(t);
    const recovery = rollbackContext(f, f.prepared);
    const result = await restoreDevelopmentPrintExecutor(recovery.input);
    assert.equal(result.restored, null);
    assert.deepEqual(result.retained, f.recorded);
    assert.deepEqual(recovery.calls, []);
    queueApi(f);
    await result.verify();
    f.state.paused = false;
    f.state.currentReleaseId = "native-125";
    f.state.events.set("verified", JSON.stringify({ rollbackVerified: true, retainedPrintExecutor: result.retained }));
    assert.deepEqual(await loadActivePrintExecutorBaseline(recovery.input), f.recorded);
    f.state.paused = true;
    const next = await nextExecutor(f, { previousMode: "queue" });
    await next.release.deploy("native-124");
    executorApi(f);
    const secondRecovery = rollbackContext(f, next.prepared, next.store);
    const second = await restoreDevelopmentPrintExecutor(secondRecovery.input);
    assert.equal(second.restored, null);
    assert.deepEqual(second.retained, f.recorded);
    queueApi(f);
    await second.verify();
    assert.deepEqual(secondRecovery.calls, [f.recorded.worker.workerVersion]);
});
test("lost executor update acknowledgement is reconciled from sealed intent before exact rollback", async (t) => {
    const f = await deployedFoundation(t);
    const next = await nextExecutor(f, { uncertain: true });
    // The fixture models events per stage; an uncertain new release has no
    // verified event of its own, even though its predecessor was verified.
    f.state.events.delete("print-executor-verified");
    await assert.rejects(next.release.deploy("native-124"), /lost deployment/u);
    const recovery = rollbackContext(f, next.prepared, next.store);
    const result = await restoreDevelopmentPrintExecutor(recovery.input);
    assert.deepEqual(result.restored, f.recorded);
    assert.ok(f.state.events.has("print-executor-recovered"));
    assert.equal(f.state.calls.length, 2); // first creation plus one uncertain update, no retry
    await result.verify();
});
test("existing executor drift and unowned or wrong-mode baselines fail before an update", async (t) => {
    const f = await deployedFoundation(t);
    const next = await nextExecutor(f);
    f.state.worker = { ...f.state.worker, versionResourcesSha256: "f".repeat(64) };
    await assert.rejects(next.release.deploy("native-124"), /resources changed/u);
    assert.equal(f.state.calls.length, 1);
    f.state.worker = f.recorded.worker;
    f.state.paused = false;
    f.state.events.set("verified", JSON.stringify({ retainedPrintExecutor: f.recorded }));
    await assert.rejects(loadActivePrintExecutorBaseline({ ...f }), /owned active or retained/u);
    f.state.events.set("verified", JSON.stringify({ rollbackVerified: true, retainedPrintExecutor: f.recorded }));
    await assert.rejects(loadActivePrintExecutorBaseline({ ...f }), /lacks immutable release/u);
});
test("a recorded foundation disappearing cannot be treated as an absent rollback target", async (t) => {
    const f = await deployedFoundation(t);
    f.state.exists = false;
    const recovery = rollbackContext(f, f.prepared);
    await assert.rejects(restoreDevelopmentPrintExecutor(recovery.input), /recorded executor disappeared/u);
    assert.deepEqual(recovery.calls, []);
});
test('completed executor rollback verifies active historical API settings and rejects forged retention or version drift', async (t) => {
    const f = await deployedFoundation(t);
    const recovery = rollbackContext(f, f.prepared);
    await restoreDevelopmentPrintExecutor(recovery.input);
    queueApi(f);
    const version = await f.api.version("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    f.prepared.previous = { worker: { workerVersion: version.id, versionResourcesSha256: versionResourcesDigest(version) } };
    f.api.settings = () => assert.fail('latest uploaded settings are not the historical active API');
    const result = await verifyRestoredPrintExecutor(recovery.input);
    assert.equal(result.restored, null);
    assert.deepEqual(result.retained, f.recorded);
    executorApi(f);
    await assert.rejects(verifyRestoredPrintExecutor(recovery.input), /immutable recorded resources/u);
    queueApi(f);
    f.state.events.set('print-executor-rollback-verified', JSON.stringify({ restored: f.recorded, retained: null }));
    await assert.rejects(verifyRestoredPrintExecutor(recovery.input), /sealed predecessor/u);
});
test("Production foundation uses only its separate worker, database, bucket and same namespace on verification", async (t) => {
    const f = await foundation(t, "production");
    const artifacts = await f.release.preserve(f.store);
    const deployed = await f.release.deploy("native-123");
    assert.equal(f.review.worker, "forever-tee-print-executor-production");
    assert.equal(f.review.stagingLifecycle.bucket, "forever-tee-design-artwork-production");
    assert.equal(f.state.calls[0][f.state.calls[0].indexOf("--env") + 1], "production");
    assert.equal(f.protocol.verifyApiPrintExecutorBinding(f.apiSettings, deployed), true);
    assert.throws(() => verifyApiPrintExecutorBinding(f.apiSettings, deployed), /script or class/);
    assert.throws(() => verifyPrintExecutorConfig(f.review.config), /environment resources/);
    const prepared = { releaseId: "native-123", sourceCommit: f.context.GITHUB_SHA,
        worker: { printExecutor: f.review }, artifacts: { printExecutor: artifacts } };
    assert.deepEqual(await f.protocol.verifyRecordedPrintExecutor({ env: f.context, api: f.api, prepared,
        store: f.store, inspectWorker: f.inspectWorker, client: f.client, staging: f.staging }), deployed);
    f.settings.bindings.find(binding => binding.name === "DB").id = protectedConfig("resource_fb377032d2f5");
    await assert.rejects(f.release.verifyDeployed(), /resources|data\/image/);
});
test("Production uncertain creation retains its durable intent and cannot be dispatched again", async (t) => {
    const f = await foundation(t, "production");
    await f.release.preserve(f.store);
    f.state.failDeploy = true;
    await assert.rejects(f.release.deploy("native-123"), /uncertain creation/);
    assert.ok(f.state.events.has("print-executor-deploy-started"));
    await assert.rejects(f.release.deploy("native-123"), /first-attempt/);
    assert.equal(f.state.calls.length, 1);
});
test("Production inspection rejects Development context before network access and only accepts exact absence", async () => {
    const protocol = printExecutorProtocol("production");
    assert.throws(() => protocol.printExecutorClient(env, () => assert.fail()), /Production/);
    assert.throws(() => printExecutorProtocol("work"), /exact executor environment/);
    const context = { ...env, GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production.yml@refs/heads/main",
        WORKER_URL: "https://forever-tee-api.socialqueue.workers.dev" };
    const client = protocol.printExecutorClient(context, async (url, options) => {
        assert.ok(url.endsWith("/workers/scripts/forever-tee-print-executor-production/settings"));
        assert.equal(options.method, "GET");
        return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    });
    assert.equal(await client.absentSettings(), null);
});
