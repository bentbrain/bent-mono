import { renderWranglerConfig, workerProtectedConfiguration, wranglerCli } from "./deployment-config.mjs";
import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, isDeepStrictEqual as equal } from "node:util";
import { inspectDevelopmentWorker as inspectWorker, versionResourcesDigest, workerContentManifest } from "./native-ci-worker.mjs";
import { productionCloudflare, inspectProductionConsumer, verifyProductionBindings } from "./native-production-cloudflare.mjs";
import { assertReleasePaused } from "./native-release-pause.mjs";
import { isReviewedAppliedMigrationPrefix, isReviewedMigrationInventory, } from "./native-migration-inventory.mjs";
import { validateProductionNativeSecrets, PRODUCTION_NATIVE_SECRET_NAMES } from "./native-production-invoker-bootstrap.mjs";
import { CURRENT_PRODUCTION_IMAGE_DIGEST, CURRENT_PRODUCTION_SOURCE_DIGEST, HISTORICAL_PRODUCTION_IMAGE_DIGEST, HISTORICAL_PRODUCTION_SOURCE_DIGEST, PREVIOUS_PRODUCTION_IMAGE_DIGEST, PREVIOUS_PRODUCTION_SOURCE_DIGEST, PRODUCTION_IMAGE_DIGEST, PRODUCTION_SOURCE_DIGEST } from "./native-production-runtime.mjs";
import { syntheticProductionCanaryArtwork } from "./native-production-canary-source.mjs";
import { verifyPrintQueue } from "./print-queue-policy.mjs";
import { printExecutorProtocol } from "./native-print-executor.mjs";
const execute = promisify(execFile), API = fileURLToPath(new URL("../workers/api/", import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => { if (!value)
    throw new Error(`Production Worker stopped: ${reason}`); };
export const NATIVE_PRODUCTION_QUEUE = { batch_size: 1, max_retries: 100, max_wait_time_ms: 1000, max_concurrency: 2, retry_delay: 10 };
export const FALLBACK_PRODUCTION_QUEUE = { ...NATIVE_PRODUCTION_QUEUE, max_retries: 2, max_concurrency: 1 };
const PRINTIFY_ASSET_DELIVERY_SECRET = "PRINTIFY_ASSET_DELIVERY_SECRET";
const PRINTIFY_WEBHOOK_SECRET = "PRINTIFY_WEBHOOK_SECRET";
const CART_LINE_CAPABILITY_SECRET = "CART_LINE_CAPABILITY_SECRET";
const OPENAI_API_KEY = "OPENAI_API_KEY";
const APPLICATION_SECRET_NAMES = ["SHOP_PROTECTED_CONFIG_JSON", CART_LINE_CAPABILITY_SECRET, OPENAI_API_KEY, PRINTIFY_ASSET_DELIVERY_SECRET, PRINTIFY_WEBHOOK_SECRET];
const printProtocol = printExecutorProtocol("production");
const PRODUCTION_EXECUTOR_CONFIG = fileURLToPath(new URL("../workers/print-executor/wrangler.production.jsonc", import.meta.url));
const PRODUCTION_ASSET_ORIGIN = "https://forever-tee-api.socialqueue.workers.dev";
export function productionReleaseConfig(source, releaseId, sourceCommit, assetOrigin, { printExecutor = false } = {}) {
    check(/^native-[1-9][0-9]+$/.test(releaseId) && /^[a-f0-9]{40}$/.test(sourceCommit) && assetOrigin === PRODUCTION_ASSET_ORIGIN, "pinned release identity and asset origin.");
    const input = JSON.parse(resolveProtectedTemplate(source).replace(/^\s*\/\/.*$/gm, "")), base = input.env?.production;
    check(base?.name === "forever-tee-api" && base.d1_databases?.length === 1 && base.d1_databases[0].database_id === protectedConfig("resource_1a1378f0d1dc") &&
        base.services?.length === 1 && base.services[0].service === "forever-tee-story-video" && base.r2_buckets?.length === 1 &&
        base.r2_buckets[0].bucket_name === "forever-tee-design-artwork-production" && base.queues?.consumers?.length === 2 &&
        base.queues.consumers[0].queue === "forever-tee-story-video-production" &&
        base.queues.consumers[1].queue === "forever-tee-print-assets-production" &&
        base.queues.consumers[1].max_concurrency === 5, "reviewed Production configuration, never Development.");
    const config = { ...structuredClone(base), main: join(API, "src/index.ts"), compatibility_date: input.compatibility_date,
        compatibility_flags: input.compatibility_flags };
    config.d1_databases[0].migrations_dir = join(API, "drizzle");
    config.r2_buckets.push({ binding: "STORY_VIDEOS", bucket_name: "forever-tee-story-videos-production", remote: true });
    config.durable_objects = { bindings: [{ name: "STORY_VIDEO_NOTIFICATIONS", class_name: "StoryVideoNotifications" }] };
    if (printExecutor)
        config.durable_objects.bindings.push({ name: "PRINT_EXECUTIONS", class_name: "PrintAssetExecution",
            script_name: "forever-tee-print-executor-production" });
    config.migrations = [{ tag: "notifications-v1", new_sqlite_classes: ["StoryVideoNotifications"] }];
    config.queues.consumers[0] = { queue: "forever-tee-story-video-production", max_batch_size: 1, max_batch_timeout: 1, max_retries: 100, max_concurrency: 2, retry_delay: 10 };
    config.triggers = { crons: ["* * * * *"] };
    config.vars = { ...config.vars, STORY_VIDEO_PROVIDER: "lambda", STORY_VIDEO_ENVIRONMENT: "production",
        STORY_VIDEO_LAMBDA_FUNCTION: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production",
        STORY_VIDEO_FAMILY_CONFIGURATION: "1", STORY_VIDEO_LANES: "2", STORY_VIDEO_NOTIFICATION_MODE: "push", STORY_VIDEO_TRANSPORT: "direct", STORY_VIDEO_WARM_ON_CONFIRM: "1",
        STORY_VIDEO_RELEASE_ID: releaseId, STORY_VIDEO_RELEASE_COMMIT: sourceCommit, STORY_VIDEO_IMAGE_DIGEST: PRODUCTION_IMAGE_DIGEST, STORY_VIDEO_SOURCE_DIGEST: PRODUCTION_SOURCE_DIGEST,
        PRINTIFY_ASSET_ORIGIN: assetOrigin, ...(printExecutor ? { PRINT_EXECUTION_MODE: "durable-object" } : {}) };
    return config;
}
export function verifyProductionReleaseSettings(settings, consumer, variables, previousSettings, queue = NATIVE_PRODUCTION_QUEUE, printExecutor, { requireProtectedConfig = false } = {}) {
    verifyProductionBindings(settings, { application: true, native: true });
    if (requireProtectedConfig) {
        const bindings = settings.bindings.filter(item => item.name === "SHOP_PROTECTED_CONFIG_JSON");
        check(bindings.length === 1 && bindings[0].type === "secret_text", "encrypted protected runtime configuration required for the new Worker.");
    }
    for (const [name, value] of Object.entries(variables)) {
        const matches = settings.bindings.filter(item => item.name === name);
        check(matches.length === 1 && matches[0].type === "plain_text" && matches[0].text === value, `live ${name} differs.`);
    }
    if (printExecutor)
        printProtocol.verifyApiPrintExecutorBinding(settings, printExecutor);
    // Preserve unrelated settings. These two exact, reviewed rate changes keep
    // their Production namespaces and one-minute windows. Never exempt a whole
    // binding category or accept arbitrary limits. Secret values stay unread.
    const reviewedRates = [
        { name: "OWNER_MUTATION_RATE_LIMIT", namespace: "3101", previous: 60, next: 600 },
        { name: "IMAGE_PROCESS_RATE_LIMIT", namespace: "3102", previous: 6, next: 30 },
    ];
    for (const item of previousSettings.bindings.filter(item => !item.name.startsWith("STORY_VIDEO"))) {
        if (printExecutor && item.name === "PRINT_EXECUTION_MODE" && item.type === "plain_text" && item.text === "queue")
            continue;
        const matches = settings.bindings.filter(current => current.name === item.name);
        const change = reviewedRates.find(rate => equal(item, { name: rate.name, type: "ratelimit",
            namespace_id: rate.namespace, simple: { limit: rate.previous, period: 60 } }));
        const reviewed = change && { ...item, simple: { limit: change.next, period: 60 } };
        check(matches.length === 1 && (equal(matches[0], item) || reviewed && equal(matches[0], reviewed)), `unrelated Production binding changed: ${item.name}.`);
    }
    check(equal(consumer.settings, queue), "reviewed provider queue settings.");
}
const singleActiveProductionVersion = deployments => {
    const versions = deployments.deployments?.[0]?.versions;
    check(versions?.length === 1 && versions[0].percentage === 100 && /^[a-f0-9-]{36}$/.test(versions[0].version_id), "single active Production Worker version.");
    return versions[0].version_id;
};
export async function loadRecordedProductionWorkerBaseline(cf, store, { pauseOwner } = {}) {
    const active = singleActiveProductionVersion(await cf.deployments());
    const latest = (await cf.versions()).items?.[0]?.id;
    check(typeof latest === "string" && /^[a-f0-9-]{36}$/.test(latest), "latest Production Worker version.");
    if (active === latest)
        return undefined;
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const controls = await query("SELECT paused,release_id,current_release_id FROM native_video_release_control WHERE singleton=1");
    const control = controls[0], unpaused = control?.paused === 0 && control.release_id === null;
    const ownedPause = /^native-[1-9][0-9]+$/.test(pauseOwner ?? "") && control?.paused === 1 && control.release_id === pauseOwner;
    check(controls.length === 1 && (unpaused || ownedPause) && /^native-[1-9][0-9]+$/.test(control.current_release_id), "historical active Worker requires an unpaused release or the exact current pause owner.");
    const releaseId = control.current_release_id;
    const terminalRows = await query(`SELECT stage,payload FROM native_video_release_events WHERE release_id=?
    AND stage IN ('verified','backlog-recovery-rolled-back')`, [releaseId]);
    check(terminalRows.length === 1 && ["verified", "backlog-recovery-rolled-back"].includes(terminalRows[0].stage), "single completed release record.");
    const terminal = JSON.parse(terminalRows[0].payload), recoveredBacklog = terminalRows[0].stage === "backlog-recovery-rolled-back";
    if (recoveredBacklog) {
        check(terminal.provider === "cloudflare" && Number.isSafeInteger(terminal.cohort?.families) && terminal.cohort.families > 0 &&
            terminal.cohort.families <= 52 && terminal.cohort.count === terminal.cohort.families * 4 &&
            /^[a-f0-9]{64}$/.test(terminal.cohort.sha256 ?? ""), "recorded fallback recovery completion.");
    }
    else {
        check(terminal.releaseId === releaseId && terminal.provider === "cloudflare" &&
            (terminal.rollbackVerified === true || terminal.rollbackRehearsed === true), "recorded compatible fallback admission.");
    }
    const sourceReleaseId = !recoveredBacklog && terminal.rollbackVerified === true ? terminal.fromReleaseId : releaseId;
    check(/^native-[1-9][0-9]+$/.test(sourceReleaseId ?? ""), "recorded fallback source release.");
    const rows = await query("SELECT stage,payload FROM native_video_release_events WHERE release_id=? AND stage IN ('prepared','fallback-verified') ORDER BY stage", [sourceReleaseId]);
    check(rows.length === 2 && rows[0].stage === "fallback-verified" && rows[1].stage === "prepared", "complete fallback preparation records.");
    const fallbackEvent = JSON.parse(rows[0].payload), preparedEvent = JSON.parse(rows[1].payload);
    const { preparation, ...prepared } = preparedEvent;
    check(prepared.environment === "production" && prepared.accountId === protectedConfig("awsAccountId") && prepared.region === "ap-southeast-2" &&
        prepared.releaseId === sourceReleaseId && /^[a-f0-9]{40}$/.test(prepared.sourceCommit) &&
        [[CURRENT_PRODUCTION_IMAGE_DIGEST, CURRENT_PRODUCTION_SOURCE_DIGEST], [PREVIOUS_PRODUCTION_IMAGE_DIGEST, PREVIOUS_PRODUCTION_SOURCE_DIGEST], [HISTORICAL_PRODUCTION_IMAGE_DIGEST, HISTORICAL_PRODUCTION_SOURCE_DIGEST], [PRODUCTION_IMAGE_DIGEST, PRODUCTION_SOURCE_DIGEST]]
            .some(([imageDigest, sourceDigest]) => prepared.candidate?.imageDigest === imageDigest && prepared.candidate?.sourceDigest === sourceDigest) &&
        equal(JSON.parse(await store.read(preparation)), prepared), "immutable fallback preparation.");
    const fallback = JSON.parse(await store.read(fallbackEvent.artifact));
    check(equal(fallback, fallbackEvent.fallback) && fallback.provider === "cloudflare" && fallback.workerVersion === active &&
        fallback.workerBytesVerified === true && /^[a-f0-9]{64}$/.test(fallback.versionResourcesSha256), "immutable active fallback record.");
    if (!recoveredBacklog && terminal.rollbackVerified === true) {
        check(terminal.fromReleaseId === sourceReleaseId && terminal.restored?.workerVersion === fallback.workerVersion &&
            terminal.restored.provider === "cloudflare", "completed rollback matches the recorded fallback.");
    }
    else if (!recoveredBacklog)
        check(equal(terminal.fallback, fallback), "completed fallback admission matches the recorded version.");
    const bytes = await store.read(prepared.artifacts.candidateArtifact);
    const content = await workerContentManifest(new Response(bytes));
    check(equal(content, fallback.content) && content.modules.length === 1 && content.modules[0].sha256 === prepared.worker.bundleSha256, "recorded fallback bytes match the prepared bundle.");
    const version = await cf.version(active);
    check(version.id === active && versionResourcesDigest(version) === fallback.versionResourcesSha256 && Array.isArray(version.resources?.bindings), "recorded fallback resources match the active immutable version.");
    const consumer = await inspectProductionConsumer(cf), schedules = await cf.schedules();
    check(equal(consumer, fallback.consumer) && schedules.schedules?.length === 1 && schedules.schedules[0].cron === fallback.cron, "recorded fallback queue and schedule are active.");
    const original = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    check(equal(original.before, prepared.previous.worker), "original Worker preservation matches the fallback preparation.");
    const activeSettings = { bindings: version.resources.bindings };
    verifyProductionReleaseSettings(activeSettings, consumer, { ...prepared.variables, STORY_VIDEO_PROVIDER: "cloudflare" }, original.settings, FALLBACK_PRODUCTION_QUEUE, fallback.printExecutor);
    check(singleActiveProductionVersion(await cf.deployments()) === active && (await cf.versions()).items?.[0]?.id === latest &&
        equal(await query("SELECT paused,release_id,current_release_id FROM native_video_release_control WHERE singleton=1"), controls), "Production fallback baseline changed during verification.");
    return { record: { releaseId, sourceReleaseId, terminalStage: terminalRows[0].stage, workerVersion: active, latestVersion: latest }, fallback,
        historicalArtifact: { before: fallback, body: bytes.toString("base64"), contentType: "application/javascript+module", entrypoint: content.entrypoint },
        settings: activeSettings };
}
export function classifyProductionBaseline(settings, consumer, before, recordedFallback) {
    const provider = settings.bindings.filter(item => item.name === "STORY_VIDEO_PROVIDER");
    const nativeSecrets = settings.bindings.filter(item => PRODUCTION_NATIVE_SECRET_NAMES.includes(item.name));
    const applicationSecrets = settings.bindings.filter(item => APPLICATION_SECRET_NAMES.includes(item.name));
    const cloudflare = provider.length === 0 || provider.length === 1 && provider[0].type === "plain_text" && provider[0].text === "cloudflare";
    if (recordedFallback) {
        check(recordedFallback.workerVersion === before.workerVersion && provider.length === 1 && provider[0].type === "plain_text" && provider[0].text === "cloudflare", "recorded fallback identity and provider.");
        verifyProductionBindings(settings, { native: true });
        check(nativeSecrets.length === PRODUCTION_NATIVE_SECRET_NAMES.length && nativeSecrets.every(item => item.type === "secret_text"), "recorded fallback native secrets retained.");
        check(applicationSecrets.length <= APPLICATION_SECRET_NAMES.length && applicationSecrets.every(item => item.type === "secret_text") &&
            APPLICATION_SECRET_NAMES.every(name => applicationSecrets.filter(item => item.name === name).length <= 1), "recorded fallback application secrets retained.");
        check(equal(consumer.settings, FALLBACK_PRODUCTION_QUEUE), "recorded fallback queue configuration.");
        check(/^[a-f0-9-]{36}$/.test(before.workerVersion) && before.content.modules.length === 1, "verified recorded fallback Worker.");
        return "fallback";
    }
    const initial = cloudflare;
    if (initial) {
        check(nativeSecrets.length === 0 && applicationSecrets.length <= 1 &&
            applicationSecrets.every(item => item.name === CART_LINE_CAPABILITY_SECRET && item.type === "secret_text"), "initial release secrets must be fresh apart from an existing cart capability secret.");
        check(equal(consumer.settings, FALLBACK_PRODUCTION_QUEUE), "existing Cloudflare queue configuration.");
        check(before.workerVersion === protectedConfig("resource_087c90849ed5") && before.content.modules.length === 1 &&
            before.content.modules[0].sha256 === protectedConfig("resource_420d60c753d3"), "reviewed initial Production Worker.");
        return "initial";
    }
    check(provider.length === 1 && provider[0].type === "plain_text" && provider[0].text === "lambda", "reviewed Production provider.");
    verifyProductionBindings(settings, { native: true });
    check(nativeSecrets.length === PRODUCTION_NATIVE_SECRET_NAMES.length && nativeSecrets.every(item => item.type === "secret_text"), "existing native secrets retained.");
    check(applicationSecrets.length <= APPLICATION_SECRET_NAMES.length && applicationSecrets.every(item => item.type === "secret_text") &&
        APPLICATION_SECRET_NAMES.every(name => applicationSecrets.filter(item => item.name === name).length <= 1), "existing application secret bindings.");
    check(equal(consumer.settings, NATIVE_PRODUCTION_QUEUE), "existing native queue configuration.");
    check(/^[a-f0-9-]{36}$/.test(before.workerVersion) && before.content.modules.length === 1, "verified current native Worker.");
    const variable = name => settings.bindings.filter(item => item.name === name);
    const expected = {
        STORY_VIDEO_PROVIDER: "lambda", STORY_VIDEO_ENVIRONMENT: "production",
        STORY_VIDEO_LAMBDA_FUNCTION: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production",
    };
    for (const [name, value] of Object.entries(expected)) {
        const matches = variable(name);
        check(matches.length === 1 && matches[0].type === "plain_text" && matches[0].text === value, `existing ${name} baseline.`);
    }
    const image = variable("STORY_VIDEO_IMAGE_DIGEST"), source = variable("STORY_VIDEO_SOURCE_DIGEST");
    check(image.length === 1 && source.length === 1 && image[0].type === "plain_text" && source[0].type === "plain_text" &&
        [[CURRENT_PRODUCTION_IMAGE_DIGEST, CURRENT_PRODUCTION_SOURCE_DIGEST], [PREVIOUS_PRODUCTION_IMAGE_DIGEST, PREVIOUS_PRODUCTION_SOURCE_DIGEST], [HISTORICAL_PRODUCTION_IMAGE_DIGEST, HISTORICAL_PRODUCTION_SOURCE_DIGEST], [PRODUCTION_IMAGE_DIGEST, PRODUCTION_SOURCE_DIGEST]]
            .some(([imageDigest, sourceDigest]) => image[0].text === imageDigest && source[0].text === sourceDigest), "recorded current native image/source pair.");
    const release = variable("STORY_VIDEO_RELEASE_ID"), commit = variable("STORY_VIDEO_RELEASE_COMMIT");
    check(release.length === 1 && release[0].type === "plain_text" && /^native-[1-9][0-9]+$/.test(release[0].text) &&
        commit.length === 1 && commit[0].type === "plain_text" && /^[a-f0-9]{40}$/.test(commit[0].text), "recorded current native release identity.");
    return "forward";
}
export async function prepareProductionWorker(env, store, qualifiedPrintExecutor) {
    const cf = productionCloudflare(env);
    check(process.platform === "linux" && env.RUNNER_TEMP?.startsWith("/"), "cloud-only bundle preparation.");
    const nativeSecrets = Object.fromEntries(PRODUCTION_NATIVE_SECRET_NAMES.map(name => [name, env[name]]));
    validateProductionNativeSecrets(nativeSecrets);
    const applicationSecrets = Object.fromEntries(APPLICATION_SECRET_NAMES.map(name => [name, name === "SHOP_PROTECTED_CONFIG_JSON" ? workerProtectedConfiguration() : env[name]]));
    check(Object.values(applicationSecrets).every(secret => typeof secret === "string" && secret.length >= 32), "application release secrets required.");
    const secrets = { ...nativeSecrets, ...applicationSecrets };
    const releaseId = `native-${env.GITHUB_RUN_ID}`;
    const database = await cf.database();
    check(database.uuid === protectedConfig("resource_1a1378f0d1dc") && database.name === "forever-tee-designs-production", "live database identity.");
    const latestSettings = await cf.settings();
    verifyProductionBindings(latestSettings);
    const { source: canarySeed } = syntheticProductionCanaryArtwork();
    await store.save("canary-seed.json", Buffer.from(JSON.stringify(canarySeed)));
    const consumer = await inspectProductionConsumer(cf);
    const recorded = await loadRecordedProductionWorkerBaseline(cf, store);
    const settings = recorded?.settings ?? latestSettings;
    verifyProductionBindings(settings);
    let raw = recorded && { contentType: recorded.historicalArtifact.contentType, entrypoint: recorded.historicalArtifact.entrypoint,
        body: recorded.historicalArtifact.body };
    const before = await inspectWorker({ ...cf, content: async () => {
            const response = await cf.content();
            raw = { contentType: response.headers.get("content-type"), entrypoint: response.headers.get("cf-entrypoint"),
                body: Buffer.from(await response.clone().arrayBuffer()).toString("base64") };
            return response;
        } }, recorded?.historicalArtifact);
    const baseline = classifyProductionBaseline(settings, consumer, before, recorded?.record);
    const previousArtifact = await store.save("previous-worker.json", Buffer.from(JSON.stringify({ ...raw, before, consumer, settings, schedules: await cf.schedules() })));
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "production-worker-"));
    const source = await readFile(join(API, "wrangler.jsonc"), "utf8"), config = productionReleaseConfig(source, releaseId, env.GITHUB_SHA, env.WORKER_URL, { printExecutor: Boolean(qualifiedPrintExecutor) });
    const executorConfig = await renderWranglerConfig(PRODUCTION_EXECUTOR_CONFIG, join(directory, "executor.json"));
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    const configHash = sha(await readFile(configPath));
    const fallbackConfig = structuredClone(config);
    fallbackConfig.vars.STORY_VIDEO_PROVIDER = "cloudflare";
    fallbackConfig.queues.consumers[0].max_concurrency = 1;
    fallbackConfig.queues.consumers[0].max_retries = 2;
    fallbackConfig.triggers.crons = ["*/15 * * * *"];
    const fallbackPath = join(directory, "fallback.json");
    await writeFile(fallbackPath, JSON.stringify(fallbackConfig), { flag: "wx", mode: 0o600 });
    const fallbackHash = sha(await readFile(fallbackPath));
    const child = { PATH: env.PATH, HOME: directory, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };
    let errorIndex = 0;
    const run = async (args, path = configPath) => {
        check([configPath, fallbackPath, executorConfig.path].includes(path), "prepared configuration path.");
        try {
            return await execute(process.execPath, [wranglerCli(), ...args, "--config", path], { cwd: API, env: child, timeout: 240000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
        }
        catch (error) {
            let output = [error.stdout, error.stderr].filter(value => typeof value === "string").join("\n");
            for (const secret of [...Object.values(secrets), env.CLOUDFLARE_API_TOKEN, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN])
                if (secret)
                    output = output.replaceAll(secret, "<REDACTED>");
            const reference = await store.save(`worker-error-${errorIndex++}.json`, Buffer.from(JSON.stringify({ operation: args[0], output })));
            console.error(JSON.stringify({ privateWorkerDiagnostic: reference }));
            throw new Error("Production Worker command failed or is uncertain; admissions remain in their current state.");
        }
    };
    const printExecutor = qualifiedPrintExecutor ? await printProtocol.preparePrintExecutorFoundation({ env, directory,
        run: args => run(args, executorConfig.path), api: cf, inspectWorker, baselineStore: store }) : null;
    if (printExecutor) {
        check(/^[a-f0-9]{40}$/.test(qualifiedPrintExecutor.sourceCommit ?? "") && qualifiedPrintExecutor.worker?.content?.modules?.length === 1 &&
            qualifiedPrintExecutor.worker.content.modules[0].sha256 === printExecutor.review.bundleSha256, "Production print executor bytes must equal the qualified Development artifact.");
    }
    let deployedPrintExecutor;
    const verifyPrintExecutor = async () => {
        if (!printExecutor)
            return null;
        const verified = await printExecutor.verifyDeployed();
        printProtocol.verifyApiPrintExecutorBinding(await cf.settings(), verified);
        check(deployedPrintExecutor, "sealed executor deployment is required.");
        const { evidence, ...saved } = deployedPrintExecutor;
        check(evidence && equal(verified, saved), "executor deployment changed after preservation.");
        return deployedPrintExecutor;
    };
    const out = join(directory, "bundle");
    await run(["deploy", "--dry-run", "--outdir", out]);
    const entrypoint = join(out, "index.js"), bytes = await readFile(entrypoint), checked = join(directory, "checked");
    await run(["deploy", entrypoint, "--no-bundle", "--dry-run", "--outdir", checked]);
    check(sha(await readFile(join(checked, "index.js"))) === sha(bytes), "prepared bundle changed under no-bundle.");
    const artifacts = { previousArtifact, candidateArtifact: await store.save("candidate-worker.js", bytes),
        configArtifact: await store.save("candidate-config.json", await readFile(configPath)),
        fallbackConfigArtifact: await store.save("fallback-config.json", await readFile(fallbackPath)),
        ...(printExecutor ? { printExecutor: await printExecutor.preserve(store) } : {}) };
    const secretNames = baseline === "initial" ? [...PRODUCTION_NATIVE_SECRET_NAMES, ...APPLICATION_SECRET_NAMES] : APPLICATION_SECRET_NAMES;
    const secretsPath = join(directory, "release-secrets.json");
    await writeFile(secretsPath, JSON.stringify(Object.fromEntries(secretNames.map(name => [name, secrets[name]]))), { flag: "wx", mode: 0o600 });
    const review = { sourceCommit: env.GITHUB_SHA, baseline, baselineReleaseId: recorded?.record.releaseId ?? null, secretNames,
        bundleSha256: sha(bytes), bundleBytes: bytes.length, configSha256: configHash, fallbackConfigSha256: fallbackHash, sourceConfigSha256: sha(source), ...(printExecutor ? { printExecutor: printExecutor.review } : {}) };
    const verifyPrevious = async () => {
        if (printExecutor)
            await printExecutor.verifyPrevious();
        const current = recorded ? await loadRecordedProductionWorkerBaseline(cf, store, { pauseOwner: releaseId }) : undefined;
        check(equal(await inspectWorker(cf, recorded?.historicalArtifact), before) &&
            equal(current?.record, recorded?.record) && equal(current?.settings ?? await cf.settings(), settings) &&
            equal(await inspectProductionConsumer(cf), consumer), "previous Worker/settings/queue changed.");
    };
    await verifyPrevious();
    return { cf, before, consumer, settings, artifacts, review, variables: config.vars, secretNames, verifyPrevious, verifyPrintExecutor,
        deployPrintExecutor: async () => {
            if (!printExecutor)
                return null;
            deployedPrintExecutor = await printExecutor.deploy(releaseId);
            return deployedPrintExecutor;
        },
        migrate: async () => {
            check(env.NATIVE_OPERATION === "release", "migration requires explicit paired operation.");
            await assertReleasePaused(cf, releaseId);
            const expected = (await readdir(join(API, "drizzle"))).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
            const applied = (await cf.query("SELECT name FROM d1_migrations ORDER BY name"))[0].results.map(row => row.name);
            check(isReviewedMigrationInventory(expected) &&
                isReviewedAppliedMigrationPrefix(expected, applied), "exact reviewed migration state.");
            await run(["d1", "migrations", "apply", "DB", "--remote"]);
            check(equal((await cf.query("SELECT name FROM d1_migrations ORDER BY name"))[0].results.map(row => row.name), expected), "migration history.");
            check((await cf.query("SELECT name FROM pragma_table_info('story_video_jobs') WHERE name = 'execution_id'"))[0].results.length === 1, "execution fence column.");
            check((await cf.query("SELECT name FROM pragma_table_info('paid_order_lines') WHERE name = 'retail_price_minor_units'"))[0].results.length === 1, "paid-order retail price column.");
            check((await cf.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('printify_media_copies', 'printify_production_products')"))[0].results.length === 2, "Printify production tables.");
            check((await cf.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('print_asset_objects', 'storage_test_fixtures', 'storage_gc_cursors')"))[0].results.length === 3, "storage maintenance tables.");
            check((await cf.query("SELECT name FROM pragma_table_info('print_assets') WHERE name = 'object_sha256'"))[0].results.length === 1, "shared print object reference column.");
            await assertReleasePaused(cf, releaseId);
        },
        deploy: async (provider = "lambda") => {
            check(env.NATIVE_OPERATION === "release", "deployment requires explicit paired operation.");
            check(["lambda", "cloudflare"].includes(provider), "reviewed provider.");
            if (printExecutor) {
                check(deployedPrintExecutor, "executor must be deployed before the API binding.");
                await printExecutor.verifyDeployed();
            }
            const chosen = provider === "lambda" ? config : fallbackConfig;
            const path = provider === "lambda" ? configPath : fallbackPath;
            await assertReleasePaused(cf, releaseId);
            check(sha(await readFile(entrypoint)) === review.bundleSha256 && sha(await readFile(path)) === (provider === "lambda" ? configHash : fallbackHash), "immutable prepared bytes/configuration.");
            await run(["deploy", entrypoint, "--no-bundle", "--keep-vars", "--tag", releaseId, "--message", `Native Production pair ${env.GITHUB_SHA}`,
                "--secrets-file", secretsPath,
                ...Object.entries(chosen.vars).flatMap(([key, value]) => ["--var", `${key}:${value}`])], path);
            const live = await inspectWorker(cf);
            check(live.content.modules.length === 1 && live.content.modules[0].sha256 === review.bundleSha256, "live candidate bytes.");
            verifyProductionReleaseSettings(await cf.settings(), await inspectProductionConsumer(cf), chosen.vars, settings, provider === "lambda" ? NATIVE_PRODUCTION_QUEUE : FALLBACK_PRODUCTION_QUEUE, deployedPrintExecutor, { requireProtectedConfig: true });
            await verifyPrintExecutor();
            await verifyPrintQueue(cf, "production");
            const schedules = await cf.schedules();
            check(schedules.schedules?.length === 1 && schedules.schedules[0].cron === chosen.triggers.crons[0], "reviewed recovery schedule.");
            return { ...live, provider, consumer: await inspectProductionConsumer(cf), cron: chosen.triggers.crons[0], ...(deployedPrintExecutor ? { printExecutor: deployedPrintExecutor } : {}) };
        },
    };
}
