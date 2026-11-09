import { assertArtworkMediaBundle } from "./artwork-media-compatibility.mjs";
import { workerContentManifest, readWorkerUpload, verifyWorkerUpload, preserveWorkerUpload, prepareWorkerUpload, readSealedWorkerUpload } from "./native-worker-content.mjs";
export { workerContentManifest } from "./native-worker-content.mjs";
import { renderWranglerConfig, workerProtectedConfiguration, wranglerCli } from "./deployment-config.mjs";
import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { developmentCloudflare } from "./native-ci-cloudflare.mjs";
import { assertReleasePaused } from "./native-release-pause.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { verifyPrintQueue } from "./print-queue-policy.mjs";
import { preparePrintExecutorFoundation, verifyApiPrintExecutorBinding } from "./native-print-executor.mjs";
import { isReviewedAppliedMigrationPrefix, isReviewedMigrationInventory, } from "./native-migration-inventory.mjs";
const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const API = join(ROOT, "workers/api");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const versionResourcesDigest = version => {
    check(version.resources && typeof version.resources === "object", "version resources missing.");
    return hash(JSON.stringify(canonical(version.resources)));
};
export async function inspectDevelopmentConsumer(cf) {
    const consumers = await cf.consumers();
    check(Array.isArray(consumers) && consumers.length === 1, "single queue consumer.");
    const consumer = consumers[0];
    check(consumer.type === "worker" && /^[a-f0-9]{32}$/.test(consumer.consumer_id) &&
        (consumer.script === "forever-tee-api-development" || consumer.service === "forever-tee-api-development") &&
        Number.isInteger(consumer.settings?.max_concurrency) && consumer.settings.max_concurrency >= 1 && consumer.settings.max_concurrency <= 2, "exact bounded Development queue consumer.");
    return { consumerId: consumer.consumer_id, settings: consumer.settings };
}
const check = (value, reason) => { if (!value)
    throw new Error(`Native Worker verification failed: ${reason}`); };
const RELEASE_SECRET_NAMES = ["SHOP_PROTECTED_CONFIG_JSON", "CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET", "PRODUCT_IMAGE_RENDERER_BYPASS_SECRET"];
export const workerCommandArguments = (args, config = join(API, "wrangler.jsonc")) => [wranglerCli(), ...args, "--config", config];
export const printExecutorCommandArguments = (args, config = join(ROOT, "workers/print-executor/wrangler.jsonc")) => [wranglerCli(), ...args, "--config", config];
const singleVersion = deployments => {
    const versions = deployments.deployments?.[0]?.versions;
    check(versions?.length === 1 && versions[0].percentage === 100 && /^[a-f0-9-]{36}$/.test(versions[0].version_id), "single active version.");
    return versions[0].version_id;
};
// /settings describes the latest uploaded script, even when traffic has been
// rolled back. Versioned bindings/runtime must come from the active version.
export async function activeWorkerSettings(cf, expected) {
    const id = singleVersion(await cf.deployments());
    const version = await cf.version(id);
    check(version.id === id && Array.isArray(version.resources?.bindings) &&
        version.resources.script_runtime && typeof version.resources.script_runtime === "object", "active version bindings/runtime missing.");
    if (expected)
        check(id === expected.workerVersion && versionResourcesDigest(version) === expected.versionResourcesSha256, "active version differs from the immutable recorded resources.");
    check(singleVersion(await cf.deployments()) === id, "active version changed during settings inspection.");
    return { ...version.resources.script_runtime, bindings: version.resources.bindings };
}
export async function inspectDevelopmentWorker(cf, historicalArtifact) {
    const before = singleVersion(await cf.deployments());
    const latest = (await cf.versions()).items?.[0]?.id;
    // content/v2 is the script's latest content, not an arbitrary historical
    // version. Only associate it with live traffic when latest and active match.
    check(typeof latest === "string", "latest Worker version missing.");
    let content;
    if (latest === before)
        content = await workerContentManifest(await cf.content());
    else {
        // A completed rollback can make a historical version active. Its bytes
        // must come from the immutable D1/S3 preparation, never content/v2.
        check(historicalArtifact?.before?.workerVersion === before, "latest content is not the single active version; recorded rollback artifact required.");
        content = await workerContentManifest(new Response(Buffer.from(historicalArtifact.body, "base64"), {
            headers: { "content-type": historicalArtifact.contentType, "cf-entrypoint": historicalArtifact.entrypoint },
        }));
        check(isDeepStrictEqual(content, historicalArtifact.before.content), "historical Worker bytes differ from the recorded manifest.");
    }
    const version = await cf.version(before);
    if (latest !== before)
        check(versionResourcesDigest(version) === historicalArtifact.before.versionResourcesSha256, "historical immutable Worker resources differ from the recorded version.");
    check(version.id === before && singleVersion(await cf.deployments()) === before &&
        (await cf.versions()).items?.[0]?.id === latest, "Worker changed during inspection.");
    return { workerVersion: before, content, versionResourcesSha256: versionResourcesDigest(version),
        annotations: version.annotations ?? {}, workerBytesVerified: true };
}
export async function prepareDevelopmentWorker(env = process.env, { recovery } = {}) {
    const cf = developmentCloudflare(env);
    check(env.RUNNER_TEMP?.startsWith("/") && process.platform === "linux", "cloud-only build.");
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-worker-"));
    const releaseSecrets = Object.fromEntries(RELEASE_SECRET_NAMES.map(name => [name, name === "SHOP_PROTECTED_CONFIG_JSON" ? workerProtectedConfiguration() : env[name]]));
    check(Object.values(releaseSecrets).every(value => typeof value === "string" && value.length >= 32), "application release secrets.");
    const secretsPath = join(directory, "release-secrets.json");
    await writeFile(secretsPath, JSON.stringify(releaseSecrets), { flag: "wx", mode: 0o600 });
    const apiConfig = await renderWranglerConfig(join(API, "wrangler.jsonc"), join(directory, "api.json"));
    const executorConfig = await renderWranglerConfig(join(ROOT, "workers/print-executor/wrangler.jsonc"), join(directory, "executor.json"));
    const childEnv = { PATH: env.PATH, HOME: directory, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };
    const run = async (args, executor = false) => {
        try {
            return await execute(process.execPath, executor ? printExecutorCommandArguments(args, executorConfig.path) : workerCommandArguments(args, apiConfig.path), { cwd: API, env: childEnv, encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
        }
        catch (error) {
            let output = [error.stdout, error.stderr].filter(value => typeof value === "string").join("\n");
            for (const secret of [env.CLOUDFLARE_API_TOKEN, env.BENT_SHIRT_OPERATIONS_SECRET, env.CART_LINE_CAPABILITY_SECRET,
                env.PRINTIFY_ASSET_DELIVERY_SECRET, env.PRINTIFY_WEBHOOK_SECRET, env.PRODUCT_IMAGE_RENDERER_BYPASS_SECRET, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN]) {
                if (secret)
                    output = output.replaceAll(secret, "<REDACTED>");
            }
            const store = await createDevelopmentReleaseStore(env);
            const reference = await store.save(executor ? "print-executor-diagnostic.json" : "worker-diagnostic.json", Buffer.from(JSON.stringify({ operation: args[0], output,
                exitCode: typeof error.code === "number" ? error.code : null, timedOut: error.killed === true })));
            console.error(JSON.stringify({ privateWorkerDiagnostic: reference }));
            throw new Error("Native Worker command was not confirmed. Private output was not logged; admissions remain in their current state.");
        }
    };
    const out = join(directory, "bundle"), entrypoint = join(out, "index.js");
    const upload = await prepareWorkerUpload({ run, directory: out, environment: "development", sealed: recovery?.sealedWorker }), bytes = upload.code;
    assertArtworkMediaBundle(bytes);
    const printExecutor = await preparePrintExecutorFoundation({ env, directory, api: cf,
        run: args => run(args, true), inspectWorker: inspectDevelopmentWorker, interrupted: recovery, sealedUpload: recovery?.sealedExecutor });
    const review = { schemaVersion: 2, content: upload.content, configuration: { api: apiConfig.resolvedSha256, executor: executorConfig.resolvedSha256 }, bundleSha256: hash(bytes), bundleBytes: bytes.length, sourceCommit: env.GITHUB_SHA,
        printExecutor: printExecutor.review };
    let historicalArtifact;
    if ((await cf.versions()).items?.[0]?.id !== singleVersion(await cf.deployments())) {
        const { loadActiveDevelopmentRollbackArtifact } = await import("./native-ci-rollback.mjs");
        historicalArtifact = await loadActiveDevelopmentRollbackArtifact(cf, await createDevelopmentReleaseStore(env));
    }
    let previousContent = historicalArtifact && { contentType: historicalArtifact.contentType,
        entrypoint: historicalArtifact.entrypoint, body: historicalArtifact.body };
    const capture = { ...cf, content: async () => {
            const response = await cf.content();
            previousContent = { contentType: response.headers.get("content-type"), entrypoint: response.headers.get("cf-entrypoint"),
                body: Buffer.from(await response.clone().arrayBuffer()).toString("base64") };
            return response;
        } };
    const before = await inspectDevelopmentWorker(capture, historicalArtifact);
    const consumer = await inspectDevelopmentConsumer(cf);
    const verifyPrintExecutor = async (verifyApi = true) => {
        const recorded = await printExecutor.verifyDeployed();
        if (verifyApi) verifyApiPrintExecutorBinding(await activeWorkerSettings(cf), recorded);
        return recorded;
    };
    let deployedVariables, artifacts, preservedStore;
    const verifyDeployed = async expected => {
        const { printExecutor: _executor, ...apiExpected } = expected;
        check(deployedVariables && isDeepStrictEqual(await inspectDevelopmentWorker(cf), apiExpected), "deployed API bytes/version/resources changed.");
        verifyDevelopmentReleaseConfiguration(await activeWorkerSettings(cf, expected), await inspectDevelopmentConsumer(cf), deployedVariables);
        await verifyPrintExecutor();
        await verifyPrintQueue(cf, "development");
        if (recovery) check(isDeepStrictEqual(await cf.schedules(), recovery.schedules), "API schedule changed.");
    };
    return { review, before, verifyDeployed,
        consumer,
        verifyPrintExecutor,
        preserve: async (store) => {
            check(!artifacts && previousContent && hash(await readFile(entrypoint)) === review.bundleSha256, "artifact changed before preservation.");
            const prior = await store.save("previous-worker.json", Buffer.from(JSON.stringify({ ...previousContent, before, consumer, settings: await activeWorkerSettings(cf, before) })));
            verifyWorkerUpload((await readWorkerUpload(out)).content, review);
            const bundle = await preserveWorkerUpload(store, upload, "candidate-worker");
            artifacts = { previousArtifact: prior, ...bundle, printExecutor: await printExecutor.preserve(store) };
            preservedStore = store;
            return artifacts;
        },
        verifyPrevious: async () => {
            check(isDeepStrictEqual(await inspectDevelopmentWorker(cf, historicalArtifact), before), "Worker changed after preparation.");
            check(isDeepStrictEqual(await inspectDevelopmentConsumer(cf), consumer), "queue changed after preparation.");
            await printExecutor.verifyPrevious();
        },
        migrate: async (releaseId) => {
            await assertReleasePaused(cf, releaseId);
            if (recovery) await recovery.beforeMutation("migration");
            const expected = (await readdir(join(API, "drizzle"))).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
            check(isReviewedMigrationInventory(expected), "reviewed migration inventory.");
            const applied = (await cf.query("SELECT name FROM d1_migrations ORDER BY name"))[0].results.map(row => row.name);
            check(isReviewedAppliedMigrationPrefix(expected, applied), "unreviewed migration state.");
            await run(["d1", "migrations", "apply", "DB", "--env", "development", "--remote"]);
            check(isDeepStrictEqual((await cf.query("SELECT name FROM d1_migrations ORDER BY name"))[0].results.map(row => row.name), expected), "migration history.");
            check((await cf.query("SELECT name FROM pragma_table_info('story_video_jobs') WHERE name = 'execution_id'"))[0].results.length === 1, "execution fence column.");
            check((await cf.query("SELECT name FROM pragma_table_info('paid_order_lines') WHERE name = 'retail_price_minor_units'"))[0].results.length === 1, "paid-order retail price column.");
            check((await cf.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('printify_media_copies', 'printify_production_products')"))[0].results.length === 2, "Printify production tables.");
            check((await cf.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('print_asset_objects', 'storage_test_fixtures', 'storage_gc_cursors')"))[0].results.length === 3, "storage maintenance tables.");
            check((await cf.query("SELECT name FROM pragma_table_info('print_assets') WHERE name = 'object_sha256'"))[0].results.length === 1, "shared print object reference column.");
            await assertReleasePaused(cf, releaseId);
        },
        deploy: async (releaseId, candidate, executorApplied = () => {}) => {
            await assertReleasePaused(cf, releaseId);
            check(hash(await readFile(entrypoint)) === review.bundleSha256 && candidate.environment === "development" &&
                /^[a-f0-9]{64}$/.test(candidate.sourceDigest) && /^sha256:[a-f0-9]{64}$/.test(candidate.imageDigest), "reviewed bytes and candidate.");
            verifyWorkerUpload((await readWorkerUpload(out)).content, review);
            check(artifacts && preservedStore, "preserved complete Worker upload required.");
            await readSealedWorkerUpload(preservedStore, artifacts, review);
            const executor = await printExecutor.deploy(releaseId);
            await printExecutor.verifyDeployed();
            executorApplied();
            const variables = { PRINTIFY_ASSET_ORIGIN: env.WORKER_URL, PRINT_EXECUTION_MODE: "durable-object",
                STORY_VIDEO_PROVIDER: "lambda", STORY_VIDEO_ENVIRONMENT: "development",
                STORY_VIDEO_LAMBDA_FUNCTION: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development",
                STORY_VIDEO_FAMILY_CONFIGURATION: "1", STORY_VIDEO_LANES: "2", STORY_VIDEO_NOTIFICATION_MODE: "push",
                STORY_VIDEO_TRANSPORT: "direct", STORY_VIDEO_WARM_ON_CONFIRM: "1",
                STORY_VIDEO_RELEASE_ID: releaseId, STORY_VIDEO_RELEASE_COMMIT: env.GITHUB_SHA,
                STORY_VIDEO_IMAGE_DIGEST: candidate.imageDigest, STORY_VIDEO_SOURCE_DIGEST: candidate.sourceDigest };
            if (recovery) await recovery.beforeMutation("api-deploy");
            await assertReleasePaused(cf, releaseId);
            await run(["deploy", entrypoint, "--no-bundle", "--upload-source-maps", "--env", "development", "--keep-vars", "--tag", releaseId,
                "--message", `Native pair ${env.GITHUB_SHA}`, "--secrets-file", secretsPath,
                ...Object.entries(variables).flatMap(([key, value]) => ["--var", `${key}:${value}`])]);
            const live = await inspectDevelopmentWorker(cf);
            await printExecutor.verifyDeployed();
            verifyWorkerUpload(live.content, review);
            verifyDevelopmentReleaseConfiguration(await activeWorkerSettings(cf, live), await inspectDevelopmentConsumer(cf), variables);
            await verifyPrintExecutor();
            await verifyPrintQueue(cf, "development");
            await writeFile(join(directory, "deployed.json"), JSON.stringify(live), { flag: "wx", mode: 0o600 });
            deployedVariables = variables;
            const result = { ...live, printExecutor: executor };
            await verifyDeployed(live);
            return result;
        },
    };
}
export function verifyDevelopmentReleaseConfiguration(settings, consumer, variables) {
    for (const [name, value] of Object.entries(variables)) {
        const matches = settings.bindings?.filter(binding => binding.name === name);
        check(matches?.length === 1 && matches[0].type === "plain_text" && matches[0].text === value, "live release binding differs.");
    }
    for (const name of RELEASE_SECRET_NAMES) {
        const secrets = settings.bindings?.filter(binding => binding.name === name);
        check(secrets?.length === 1 && secrets[0].type === "secret_text", `application ${name} binding.`);
    }
    check(isDeepStrictEqual(consumer.settings, { batch_size: 1, max_retries: 100, max_wait_time_ms: 1000, max_concurrency: 2, retry_delay: 10 }), "live queue settings differ from the reviewed native watchdog configuration.");
}
export async function verifyDevelopmentPairStatus(env, candidate, releaseId, request = fetch, { paused = true, sourceCommit = env.GITHUB_SHA } = {}) {
    developmentCloudflare(env);
    check(typeof env.BENT_SHIRT_OPERATIONS_SECRET === "string" && env.BENT_SHIRT_OPERATIONS_SECRET.length > 0, "operations credential missing.");
    const response = await request(`${env.WORKER_URL}/v2/internal/operations/native-video-release`, {
        redirect: "error", signal: AbortSignal.timeout(30000), headers: { "x-bent-shirt-operations-secret": env.BENT_SHIRT_OPERATIONS_SECRET },
    });
    check(response.ok, "live protocol status unavailable.");
    const value = await response.json();
    check(value.executionProtocol === "claim-v1" && value.rendererVersion === "story-video-renderer-v7" && value.releaseId === releaseId &&
        value.sourceCommit === sourceCommit && value.imageDigest === candidate.imageDigest && value.sourceDigest === candidate.sourceDigest &&
        value.environment === "development" && value.functionArn === "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development" &&
        value.paused === paused && value.pauseOwner === (paused ? releaseId : null), "live protocol/configuration/pause mismatch.");
    return { protocolVerified: true, executionProtocol: value.executionProtocol, releaseId, sourceCommit: value.sourceCommit };
}
