import { resolveProtectedTemplate } from "./protected-config.mjs";
import { verifyEditorialSource } from "./editorial-source.mjs";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual as equal } from "node:util";
import { readFile, writeFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { BACKUP_ACCOUNT, backupContext, backupHash, assertInactiveBackup, assertBackupReceipt, backupRecoverySource, assertBackupRecovery } from "./backup-renderer-policy.mjs";
import { backupFixture, compareBackupVideo } from "../workers/video-renderer/qualification/backup-fixture.mjs";
import { workerContentManifest } from "./native-ci-worker.mjs";
import { prepareBackupContext, standaloneBackupConfig } from "./backup-renderer-context.mjs";
import { waitForEditorialWorker, readRenderEvents, renderEditorialProbe } from "./editorial-worker-probe.mjs";
import { readBackupContainer, waitForBackupPair } from "./backup-renderer-rollout.mjs";
const env = process.env, context = backupContext(env), execute = promisify(execFile);
if (process.platform !== "linux")
    throw Error("Backup releases run only on protected Actions runners.");
const root = resolve("workers/video-renderer"), directory = await mkdtemp(join(env.RUNNER_TEMP, "backup-renderer-"));
const output = resolve("backup-renderer-output");
await mkdir(output, { recursive: true });
const child = { PATH: env.PATH, HOME: directory, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_ACCOUNT_ID: BACKUP_ACCOUNT, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };
const check = (value, reason) => {
    if (!value)
        throw Error(`Backup renderer stopped: ${reason}`);
};
async function run(command, args, cwd = root) {
    try {
        return (await execute(command, args, { cwd, env: child, encoding: "utf8", timeout: 900000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    }
    catch (error) {
        const diagnostic = [error.stdout, error.stderr].filter(value => typeof value === "string").join("\n").replaceAll(env.CLOUDFLARE_API_TOKEN, "<REDACTED>");
        await writeFile(join(output, "failure.txt"), diagnostic, { mode: 0o600 });
        throw Error("Backup command failed or its response is uncertain. Intent is retained; do not repeat the deployment.");
    }
}
const wrangler = args => run(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args]);
const cfRoot = `https://api.cloudflare.com/client/v4/accounts/${BACKUP_ACCOUNT}`;
async function send(path, options = {}) {
    return fetch(cfRoot + path, { ...options, redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...options.headers } });
}
async function api(path, body, method) {
    const response = await send(path, { ...(method ? { method } : body ? { method: "POST" } : {}),
        ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
    check(response.ok, `Cloudflare HTTP ${response.status}.`);
    const value = await response.json();
    check(value.success === true, "Cloudflare success not confirmed.");
    return value.result;
}
const query = async (sql) => (await api(`/d1/database/${context.database}/query`, { sql, params: [] }))[0].results;
const objectPath = (bucket, key) => `/r2/buckets/${bucket}/objects/${key}`;
async function readObject(bucket, key, absent = false) {
    const response = await send(objectPath(bucket, key));
    if (absent && response.status === 404) {
        await response.body?.cancel();
        return null;
    }
    check(response.ok, "evidence object unavailable.");
    return Buffer.from(await response.arrayBuffer());
}
async function preserve(key, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    check(await readObject(context.bucket, key, true) === null, "existing durable intent/evidence requires same-operation recovery, not another deployment.");
    const response = await send(objectPath(context.bucket, key), { method: "PUT", body: bytes,
        headers: { "Content-Type": "application/json", "If-None-Match": "*" } });
    check(response.ok, "durable evidence write unconfirmed.");
    await response.body?.cancel();
    check(equal(await readObject(context.bucket, key), bytes), "durable evidence readback differs.");
}
const workerRoot = `/workers/scripts/${context.worker}`;
async function baseline() {
    const settings = (await api(`/workers/scripts/${context.api}/settings`));
    const controls = await query("SELECT paused,release_id,current_release_id FROM native_video_release_control WHERE singleton=1");
    const compositions = await query("SELECT count(*) AS count FROM products WHERE video_recursive_revision_id IS NOT NULL");
    assertInactiveBackup(settings, controls, compositions);
    const apiDeployment = await api(`/workers/scripts/${context.api}/deployments`);
    const versions = apiDeployment.deployments?.[0]?.versions;
    check(versions?.length === 1 && versions[0].percentage === 100, "one active native API required.");
    return { controls, apiVersion: versions[0].version_id };
}
async function inspect({ requireReady = true } = {}) {
    const deployments = await api(`${workerRoot}/deployments`), versions = deployments.deployments?.[0]?.versions;
    check(versions?.length === 1 && versions[0].percentage === 100, "one active backup Worker required.");
    const container = await readBackupContainer(wrangler, context.containerId, BACKUP_ACCOUNT);
    check(container && (!requireReady || container.state === "ready") && typeof container.image === "string", "existing ready backup container required.");
    return { workerVersion: versions[0].version_id, container: {
            id: container.id, name: container.name, image: container.image, version: container.version, state: container.state
        } };
}
const sourceReview = await verifyEditorialSource(context.sourceCommit, context.toolingCommit);
const nativeBefore = await baseline(), before = await inspect();
const recoverySource = backupRecoverySource(env, context);
let recovery;
if (recoverySource) {
    const key = `editorial/backup/${recoverySource}/${context.environment}-intent.json`;
    const bytes = await readObject(context.bucket, key);
    recovery = assertBackupRecovery(JSON.parse(bytes), context, recoverySource, before, nativeBefore);
    check(await readObject(context.bucket, recovery.receiptKey, true) === null, "original deployment is already qualified.");
    await verifyEditorialSource(recoverySource, context.toolingCommit);
    // Recovery changes only qualification tooling. Both runtime inputs and dependency
    // resolution must still be byte-identical to the original deployment source.
    await run("git", ["merge-base", "--is-ancestor", recoverySource, context.toolingCommit], resolve("."));
    await run("git", ["diff", "--exit-code", recoverySource, context.toolingCommit, "--",
        "workers/video-renderer", "packages/contracts", "bun.lock", "package.json", "package.json",
        "scripts/backup-renderer-context.mjs"], resolve("."));
    check((await send(`/workers/scripts/featured-backup-probe-${recovery.runId}/settings`)).status === 404 &&
        await readObject(context.videoBucket, `benchmarks/featured-backup-${recovery.runId}/white.mp4`, true) === null, "original qualification probe or output remains; inspect before recovery.");
    await writeFile(join(output, "original-intent.json"), bytes);
}
check(await readObject(context.bucket, context.intentKey, true) === null, "existing intent requires inspection, never replay.");
let promoted;
if (context.environment === "production") {
    promoted = assertBackupReceipt(JSON.parse(await readObject("forever-tee-design-artwork-development", `editorial/backup/${context.sourceCommit}/development.json`)), context.sourceCommit);
}
const sourceConfig = standaloneBackupConfig(JSON.parse(resolveProtectedTemplate(await readFile(join(root, "wrangler.jsonc"), "utf8"))), root);
const selected = sourceConfig.env[context.environment];
check(selected.name === context.worker && selected.containers.length === 1 && selected.containers[0].class_name === "StoryVideoContainer", "exact existing backup configuration required.");
let image = recovery?.image ?? promoted?.image;
if (!image) {
    const tag = `featured-backup:${context.sourceCommit}-${context.runId}`;
    const buildContext = await prepareBackupContext(join(directory, "image-context"));
    await wrangler(["containers", "build", buildContext, "--tag", tag, "--push"]);
    const tagged = `registry.cloudflare.com/${BACKUP_ACCOUNT}/${tag}`;
    const metadata = JSON.parse(await run("docker", ["image", "inspect", tagged]));
    const digests = metadata[0]?.RepoDigests?.filter(value => new RegExp(`^registry\\.cloudflare\\.com/${BACKUP_ACCOUNT}/featured-backup@sha256:[a-f0-9]{64}$`).test(value));
    check(digests?.length === 1, "pushed immutable backup image required.");
    image = digests[0];
}
selected.containers[0].image = image;
const config = join(directory, "wrangler.json");
await writeFile(config, JSON.stringify(sourceConfig), { flag: "wx" });
const bundle = join(directory, "bundle");
await wrangler(["deploy", "--dry-run", "--env", context.environment, "--containers-rollout=none", "--config", config, "--outdir", bundle]);
const entries = (await readdir(bundle)).filter(name => name === "worker.js");
check(entries.length === 1, "prepared Worker entrypoint required.");
const entrypoint = join(bundle, entries[0]), bundleSha256 = backupHash(await readFile(entrypoint));
check(!promoted || bundleSha256 === promoted.bundleSha256, "Production Worker must match the qualified Preview bundle.");
check(!recovery || bundleSha256 === recovery.bundleSha256, "recovery bundle differs from original deployment.");
const intent = { schemaVersion: 1, ...context, sourceReview, nativeBefore, before, image, bundleSha256, configSha256: backupHash(await readFile(config)),
    ...(recovery ? { recovery: { sourceCommit: recovery.sourceCommit, runId: recovery.runId,
            intentKey: recovery.intentKey, intentSha256: backupHash(await readObject(context.bucket, recovery.intentKey)) } } : {}) };
await preserve(context.intentKey, intent);
await writeFile(join(output, "intent.json"), JSON.stringify(intent, null, 2));
check(equal(await baseline(), nativeBefore) && equal(await inspect(), before), "baseline changed after preparation.");
if (!recovery)
    await wrangler(["deploy", entrypoint, "--no-bundle", "--env", context.environment, "--config", config, "--keep-vars",
        "--tag", `backup-${context.runId}`, "--message", `Compatible backup ${context.sourceCommit}`]);
const deployed = recovery ? before : await waitForBackupPair(() => inspect({ requireReady: false }), before, image);
const liveContent = await workerContentManifest(await send(`${workerRoot}/content/v2`));
check(liveContent.modules.some(module => module.name === liveContent.entrypoint && module.sha256 === bundleSha256), "deployed backup bytes differ from the prepared bundle.");
const version = await api(`${workerRoot}/versions/${deployed.workerVersion}`);
const deploymentIntent = recovery ?? intent;
check(version.annotations?.["workers/tag"] === `backup-${deploymentIntent.runId}` &&
    version.annotations?.["workers/message"] === `Compatible backup ${deploymentIntent.sourceCommit}`, "deployed Worker is not from the recorded operation.");
check(Array.isArray(version.resources?.bindings) && version.resources.bindings.some(binding => binding.name === "DESIGN_ARTWORK" && binding.bucket_name === context.bucket) &&
    version.resources.bindings.some(binding => binding.name === "STORY_VIDEOS" && binding.bucket_name === context.videoBucket), "backup storage bindings differ.");
// A short-lived authenticated service-binding client can render only the fixed
// synthetic composition embedded below. It cannot accept arbitrary render jobs.
const probeName = `featured-backup-probe-${context.runId}`, token = randomBytes(32).toString("hex");
const storyKey = `benchmarks/featured-backup-${context.runId}/white.mp4`;
const payload = { batchId: `backup-${context.runId}`, shared: backupFixture(),
    jobs: [{ baseProductSlug: "staple-tee", color: "White", storyKey }], concurrency: 1 };
const probePath = join(directory, "probe.mjs");
await writeFile(probePath, `const payload=${JSON.stringify(payload)};\nexport default {async fetch(request,env){
 if(typeof env.TOKEN!=='string'||env.TOKEN.length!==64||request.headers.get('authorization')!=='Bearer '+env.TOKEN)return new Response(null,{status:401});
 if(request.method==='GET'&&new URL(request.url).pathname==='/health')return Response.json({ready:true,runId:${JSON.stringify(context.runId)}});
 if(request.method==='POST'){
 const result=await env.RENDERER.fetch(new Request('https://renderer.internal/render-batch',{method:'POST',headers:{'content-type':'application/json','accept':'application/x-ndjson'},body:JSON.stringify(payload)}));
 const response=new Response(result.body,result);response.headers.set('x-editorial-operation',${JSON.stringify(context.runId)});return response;
 }
 if(request.method==='GET')return env.RENDERER.fetch(new Request('https://renderer.internal/video',{headers:{'x-story-video-key':${JSON.stringify(storyKey)}}}));
 return new Response(null,{status:405});}};`);
const probeConfig = join(directory, "probe.json"), secretPath = join(directory, "probe-secret.json");
await writeFile(probeConfig, JSON.stringify({ name: probeName, main: probePath, account_id: BACKUP_ACCOUNT,
    compatibility_date: "2026-08-12", workers_dev: true, preview_urls: false,
    services: [{ binding: "RENDERER", service: context.worker, entrypoint: "StoryVideoService" }] }));
await writeFile(secretPath, JSON.stringify({ TOKEN: token }), { mode: 0o600, flag: "wx" });
check((await send(`/workers/scripts/${probeName}/settings`)).status === 404, "probe name already exists.");
await wrangler(["deploy", "--config", probeConfig, "--secrets-file", secretPath]);
let frames;
try {
    const probeUrl = `https://${probeName}.socialqueue.workers.dev`;
    await waitForEditorialWorker(probeUrl, token, context.runId);
    const rendered = await renderEditorialProbe(probeUrl, token, context.runId);
    const events = await readRenderEvents(rendered, token);
    await writeFile(join(output, "render-events.json"), JSON.stringify(events, null, 2));
    check(events.some(event => event.type === "ready" && event.key === storyKey && event.cache === "miss") &&
        events.some(event => event.type === "complete" && event.count === 1) && !events.some(event => event.type === "error"), "fresh synthetic backup render did not complete.");
    const video = await fetch(probeUrl, { redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}` } });
    check(video.ok && video.headers.get("content-type") === "video/mp4", "backup video unavailable.");
    const bytes = Buffer.from(await video.arrayBuffer());
    check(bytes.length > 0 && bytes.length < 32000000, "bounded synthetic MP4.");
    await writeFile(join(output, "cloud.mp4"), bytes);
    frames = await compareBackupVideo(output);
}
finally {
    await api(`/workers/scripts/${probeName}`, undefined, "DELETE");
    const removed = await send(objectPath(context.videoBucket, storyKey), { method: "DELETE" });
    check(removed.ok || removed.status === 404, "synthetic video cleanup unconfirmed.");
    await removed.body?.cancel();
    check((await send(`/workers/scripts/${probeName}/settings`)).status === 404 && await readObject(context.videoBucket, storyKey, true) === null, "synthetic cleanup verification failed.");
}
check(equal(await baseline(), nativeBefore) && equal(await inspect(), deployed), "native or backup deployment changed during qualification.");
const receipt = { schemaVersion: 1, environment: context.environment, sourceCommit: context.sourceCommit, toolingCommit: context.toolingCommit, sourceReview, runId: context.runId,
    qualified: true, cleaned: true, contract: "two-source-v2", image, bundleSha256, workerVersion: deployed.workerVersion,
    container: deployed.container, frames, nativeBefore, ...(intent.recovery ? { recovery: intent.recovery } : {}) };
await preserve(context.receiptKey, receipt);
await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.info(JSON.stringify(receipt));
