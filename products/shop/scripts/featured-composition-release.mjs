import { wranglerCli } from "./deployment-config.mjs";
import { resolveProtectedTemplate } from "./protected-config.mjs";
import { verifyEditorialSource } from "./editorial-source.mjs";
import { readBackupContainer } from "./backup-renderer-rollout.mjs";
import { waitForEditorialWorker } from "./editorial-worker-probe.mjs";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual as equal } from "node:util";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { BACKUP_ACCOUNT, backupHash } from "./backup-renderer-policy.mjs";
import { compositionContext, verifyCompositionBaseline, verifyCompositionMedia, verifyCompositionPrintResolution, verifyCompositionCleanupIntent, compositionPrintFilename } from "./featured-composition-policy.mjs";
import { compositionRecords } from "./featured-composition-records.mjs";
import { releaseAssetUrl } from "./release-asset-url.mjs";
import { syntheticCompositionManifest, syntheticCompositionSource, compareCompositionVideo } from "../workers/video-renderer/qualification/composition-fixture.mjs";
const env = process.env, context = compositionContext(env), execute = promisify(execFile);
if (process.platform !== "linux")
    throw Error("Content writes run only in protected Actions.");
const check = (value, reason) => { if (!value)
    throw Error(`Featured composition stopped: ${reason}`); };
const output = resolve("featured-composition-output");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(env.RUNNER_TEMP, "featured-composition-"));
const child = { PATH: env.PATH, HOME: directory, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false", CLOUDFLARE_ACCOUNT_ID: BACKUP_ACCOUNT, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN };
const cfRoot = `https://api.cloudflare.com/client/v4/accounts/${BACKUP_ACCOUNT}`;
const send = (path, options = {}) => fetch(cfRoot + path, { ...options, redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...options.headers } });
async function api(path, body, method) {
    const response = await send(path, { ...(method ? { method } : body ? { method: "POST" } : {}), ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
    check(response.ok, `Cloudflare HTTP ${response.status}.`);
    const value = await response.json();
    check(value.success === true, "Cloudflare response not confirmed.");
    return value.result;
}
const query = async (sql, params = []) => (await api(`/d1/database/${context.database}/query`, { sql, params }))[0].results;
const objectPath = (bucket, key) => `/r2/buckets/${bucket}/objects/${key}`;
async function readObject(bucket, key, absent = false) {
    const response = await send(objectPath(bucket, key));
    if (absent && response.status === 404) {
        await response.body?.cancel();
        return null;
    }
    check(response.ok, "required object unavailable.");
    return Buffer.from(await response.arrayBuffer());
}
async function putOnce(key, bytes, type) {
    const existing = await readObject(context.bucket, key, true);
    if (existing) {
        check(equal(existing, bytes), "immutable object conflict.");
        return;
    }
    const response = await send(objectPath(context.bucket, key), { method: "PUT", body: bytes, headers: { "Content-Type": type, "If-None-Match": "*" } });
    check(response.ok, "write response unconfirmed; recover using the same manifest.");
    await response.body?.cancel();
    check(equal(await readObject(context.bucket, key), bytes), "immutable object readback differs.");
}
const activeVersion = async (worker) => {
    const versions = (await api(`/workers/scripts/${worker}/deployments`)).deployments?.[0]?.versions;
    check(versions?.length === 1 && versions[0].percentage === 100, "one active Worker version required.");
    return versions[0].version_id;
};
async function baseline() {
    const control = (await query("SELECT paused,release_id,current_release_id FROM native_video_release_control WHERE singleton=1"))[0];
    const version = await api(`/workers/scripts/${context.worker}/versions/${await activeVersion(context.worker)}`);
    const backup = JSON.parse(await readObject(context.bucket, `editorial/backup/${baselineContext.sourceCommit}/${context.environment}.json`));
    const backupVersion = await activeVersion(context.backup);
    const container = await readBackupContainer(async (args) => (await execute(process.execPath, [wranglerCli(), ...args], { env: child, encoding: "utf8", timeout: 60000 })).stdout, backup.container?.id, BACKUP_ACCOUNT);
    check(container?.image === backup.image && container.version === backup.container.version && container.state === "ready", "qualified backup container changed.");
    let verified, fallback;
    if (context.environment === "production") {
        const rows = await query("SELECT stage,payload FROM native_video_release_events WHERE release_id=? AND stage IN ('verified','fallback-verified')", [context.releaseId]);
        check(rows.length === 2, "sealed rehearsal evidence missing.");
        verified = JSON.parse(rows.find(row => row.stage === "verified").payload);
        fallback = JSON.parse(rows.find(row => row.stage === "fallback-verified").payload).fallback;
        const fallbackVersion = await api(`/workers/scripts/${context.worker}/versions/${fallback.workerVersion}`);
        check(fallbackVersion.resources?.bindings?.some(b => b.name === "STORY_VIDEO_RELEASE_COMMIT" && b.text === context.sourceCommit), "fallback source differs.");
    }
    verifyCompositionBaseline(baselineContext, control, version, backup, backupVersion, verified, fallback);
    check((await query("SELECT name FROM d1_migrations WHERE name='0040_recursive_video_placement.sql'")).length === 1, "independent placement migration missing.");
    return { nativeVersion: version.id, backupVersion, releaseId: context.releaseId };
}
const cleanupOnly = context.operation === "cleanup";
const baselineContext = cleanupOnly ? { ...context, sourceCommit: context.cleanupSource } : context;
if (cleanupOnly)
    await execute("git", ["merge-base", "--is-ancestor", context.cleanupSource, context.sourceCommit]);
const sourceReview = await verifyEditorialSource(context.sourceCommit, context.toolingCommit);
const before = await baseline();
if (context.environment === "production") {
    const preview = JSON.parse(await readObject("forever-tee-design-artwork-development", `editorial/compositions/${context.sourceCommit}/development.json`));
    check(preview.qualified === true && preview.cleaned === true && preview.sourceCommit === context.sourceCommit && preview.contract === "two-source-v2" && preview.frames?.length === 3, "completed synthetic native composition qualification required.");
}
const approved = JSON.parse(resolveProtectedTemplate(await readFile("scripts/fixtures/content/featured-398-approved.json", "utf8")));
const prefix = `editorial/compositions/${context.environment === "production" ? approved.commandId : (cleanupOnly ? context.cleanupSource : context.sourceCommit)}`;
const intentKey = `${prefix}/${context.environment}-intent.json`, receiptKey = `${prefix}/${context.environment}.json`;
const previousIntent = await readObject(context.bucket, intentKey, true);
check(context.operation !== "create" ? !!previousIntent : !previousIntent, "use create only once, or recover the exact saved intent.");
const manifest = previousIntent ? JSON.parse(previousIntent).manifest : context.environment === "production" ? approved : syntheticCompositionManifest(approved);
check(context.environment !== "production" || equal(manifest, approved), "reviewed Production manifest changed.");
compositionRecords(manifest);
if (cleanupOnly) {
    verifyCompositionCleanupIntent(context, JSON.parse(previousIntent), before);
    for (const source of manifest.sources) {
        const bytes = syntheticCompositionSource(source);
        check(backupHash(bytes) === source.sha256 && bytes.length === source.size, "cleanup source is not the original synthetic fixture.");
    }
}
const geometries = [];
if (!cleanupOnly)
    for (const product of manifest.products) {
        const rows = await query(`SELECT DISTINCT lower(v.decoration_method)||':'||v.print_width||'x'||v.print_height AS geometry_key,v.print_width,v.print_height
 FROM printify_catalogue_variants v WHERE v.snapshot_id=(SELECT catalogue_snapshot_id FROM shopify_variant_mapping_snapshots
 WHERE base_product_id=? AND shopify_product_handle=? ORDER BY retrieved_at DESC,id DESC LIMIT 1) ORDER BY geometry_key`, [product.baseProductId, product.handle]);
        check(rows.length > 0 && rows.length <= 12, "bounded current print geometries required.");
        geometries.push({ productId: product.id, rows });
    }
const intent = previousIntent ? JSON.parse(previousIntent) : { schemaVersion: 1, ...context, sourceReview, before, manifest, geometries };
if (!cleanupOnly) {
    check(equal(intent.geometries, geometries), "print catalogue changed from the saved intent.");
    const resolution = verifyCompositionPrintResolution(manifest, geometries);
    await writeFile(join(output, "print-resolution.json"), JSON.stringify(resolution, null, 2));
    await putOnce(intentKey, Buffer.from(JSON.stringify(intent)), "application/json");
}
await writeFile(join(output, "intent.json"), JSON.stringify(intent, null, 2));
if (!cleanupOnly)
    for (const source of manifest.sources) {
        let bytes;
        if (context.environment === "development")
            bytes = syntheticCompositionSource(source);
        else {
            const asset = approved.transfer.assets.find(asset => asset.file === source.file);
            check(asset && asset.sha256 === source.sha256, "exact draft transfer asset required.");
            let response = await fetch(releaseAssetUrl(asset.apiUrl), { redirect: "manual", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" } });
            if (response.status === 302) {
                const url = new URL(response.headers.get("location"));
                check(url.protocol === "https:" && url.hostname === "release-assets.githubusercontent.com", "unexpected asset redirect.");
                await response.body?.cancel();
                response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
            }
            check(response.ok, "reviewed source transfer failed.");
            bytes = Buffer.from(await response.arrayBuffer());
        }
        check(bytes.length === source.size && backupHash(bytes) === source.sha256 && bytes.readUInt32BE(16) === source.width && bytes.readUInt32BE(20) === source.height, "approved source bytes or dimensions differ.");
        await putOnce(`designs/${manifest.designId}/artwork/${source.sha256}`, bytes, "image/png");
    }
const name = `featured-composition-${context.runId}`, token = randomBytes(32).toString("hex"), entry = join(directory, "worker.mjs");
await writeFile(entry, `import {compositionOperation} from ${JSON.stringify(resolve("scripts/featured-composition-worker.mjs"))};\nexport default compositionOperation(${JSON.stringify(manifest)},${JSON.stringify(context.releaseId)},${JSON.stringify(context.environment)},${JSON.stringify(intentKey)},${JSON.stringify(context.runId)});`);
const config = join(directory, "wrangler.json"), secrets = join(directory, "secrets.json");
await writeFile(config, JSON.stringify({ name, main: entry, account_id: BACKUP_ACCOUNT, compatibility_date: "2026-08-12", compatibility_flags: ["nodejs_compat"], workers_dev: true, preview_urls: false,
    d1_databases: [{ binding: "DB", database_id: context.database, database_name: `forever-tee-designs-${context.environment}` }],
    r2_buckets: [{ binding: "DESIGN_ARTWORK", bucket_name: context.bucket }, { binding: "STORY_VIDEOS", bucket_name: context.videoBucket }] }));
await writeFile(secrets, JSON.stringify({ OPERATION_SECRET: token }), { flag: "wx", mode: 0o600 });
check((await send(`/workers/scripts/${name}/settings`)).status === 404, "temporary operation identity exists.");
try {
    await execute(process.execPath, [wranglerCli(), "deploy", "--config", config, "--secrets-file", secrets], { env: child, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
}
catch (error) {
    const diagnostic = [error.stdout, error.stderr].filter(v => typeof v === "string").join("\n").replaceAll(env.CLOUDFLARE_API_TOKEN, "<REDACTED>").replaceAll(token, "<REDACTED>");
    await writeFile(join(output, "deployment-error.txt"), diagnostic);
    throw Error("Temporary operation deployment unconfirmed. Preserve this run's intent and inspect before recovery.");
}
const operate = async (method) => {
    const response = await fetch(`https://${name}.socialqueue.workers.dev`, { method, redirect: "error", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${token}` } });
    const value = await response.json();
    check(response.ok, `operation ${method} returned ${response.status}: ${JSON.stringify(value)}`);
    return value;
};
let snapshot, frames, cleaned = false;
try {
    await waitForEditorialWorker(`https://${name}.socialqueue.workers.dev`, token, context.runId);
    check(equal(await baseline(), before), "release changed before the transaction.");
    if (cleanupOnly) {
        snapshot = await operate("GET");
        await writeFile(join(output, "media-state.json"), JSON.stringify(snapshot, null, 2));
        const cleanup = await operate("DELETE");
        check(cleanup.cleaned === true, "synthetic cleanup not confirmed.");
        cleaned = true;
    }
    else {
        const creation = await operate("POST");
        check(creation.committed === true, "atomic creation not confirmed.");
        await writeFile(join(output, "creation.json"), JSON.stringify(creation));
        for (const product of manifest.products) {
            const response = await fetch(`${env.WORKER_URL}/v2/internal/operations/print-assets-refresh?configuredProductId=${product.id}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(120000), headers: { "x-bent-shirt-operations-secret": env.BENT_SHIRT_OPERATIONS_SECRET } });
            check(response.ok, "new product print generation failed.");
            await response.body?.cancel();
        }
        const deadline = Date.now() + 480000;
        for (;;) {
            snapshot = await operate("GET");
            await writeFile(join(output, "media-state.json"), JSON.stringify(snapshot, null, 2));
            if (snapshot.videos.length === 4 && snapshot.videos.every(job => job.status === "ready"))
                break;
            check(Date.now() < deadline && !snapshot.videos.some(job => job.status === "failed" && job.attempt_count >= 3), "new video family did not complete; saved IDs must not be replaced.");
            console.info(JSON.stringify({ waitingForNewVideos: snapshot.videos.map(j => ({ id: j.id, status: j.status, attempt: j.attempt_count })) }));
            await setTimeout(15000);
        }
        verifyCompositionMedia(manifest, snapshot, { firstAttempt: context.environment === "development" });
        for (const geometry of geometries)
            for (const expected of geometry.rows)
                check(snapshot.assets.some(a => a.configured_product_id === geometry.productId && a.geometry_key === expected.geometry_key && a.width_px === expected.print_width && a.height_px === expected.print_height), "required print geometry missing.");
        for (const job of snapshot.videos) {
            const bytes = await readObject(context.videoBucket, job.story_key);
            check(backupHash(bytes) === job.object.metadata.sha256, "video object checksum differs.");
            const filename = `${job.product_id}-${job.colour.toLowerCase()}.mp4`;
            await writeFile(join(output, filename), bytes);
            await execute("ffmpeg", ["-v", "error", "-i", join(output, filename), "-f", "null", "-"], { timeout: 60000 });
            if (job.colour === "White")
                await writeFile(join(output, "cloud.mp4"), bytes);
        }
        for (const asset of snapshot.assets) {
            const bytes = await readObject(context.bucket, asset.storage_key);
            check(backupHash(bytes) === asset.sha256 && bytes.readUInt32BE(16) === asset.width_px && bytes.readUInt32BE(20) === asset.height_px, "print object checksum/dimensions differ.");
            await writeFile(join(output, compositionPrintFilename(manifest, asset)), bytes);
        }
        if (context.environment === "development")
            frames = await compareCompositionVideo(output, manifest);
        check(equal(await baseline(), before), "release changed during composition verification.");
        if (context.environment === "development") {
            const cleanup = await operate("DELETE");
            check(cleanup.cleaned === true, "synthetic cleanup not confirmed.");
            cleaned = true;
        }
    }
}
finally {
    await api(`/workers/scripts/${name}`, undefined, "DELETE");
    check((await send(`/workers/scripts/${name}/settings`)).status === 404, "temporary operation cleanup unconfirmed.");
}
if (cleanupOnly) {
    const receipt = { schemaVersion: 1, qualified: false, cleaned, environment: context.environment, sourceCommit: context.sourceCommit,
        originalSourceCommit: context.cleanupSource, originalRunId: intent.runId, runId: context.runId, commandId: manifest.commandId,
        originalIntentSha256: backupHash(previousIntent), releaseId: context.releaseId };
    await putOnce(`${prefix}/cleanup-${context.runId}.json`, Buffer.from(JSON.stringify(receipt)), "application/json");
    await writeFile(join(output, "cleanup-receipt.json"), JSON.stringify(receipt, null, 2));
    console.info(JSON.stringify(receipt));
}
else {
    const receipt = { schemaVersion: 1, environment: context.environment, sourceCommit: context.sourceCommit, toolingCommit: context.toolingCommit, sourceReview, releaseId: context.releaseId,
        runId: context.runId, commandId: manifest.commandId, qualified: true, cleaned, contract: "two-source-v2", frames: frames ?? null,
        productIds: manifest.products.map(p => p.id), nativeVersion: before.nativeVersion, backupVersion: before.backupVersion, featuredSelectionChanged: false };
    await putOnce(receiptKey, Buffer.from(JSON.stringify(receipt)), "application/json");
    await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.info(JSON.stringify(receipt));
}
