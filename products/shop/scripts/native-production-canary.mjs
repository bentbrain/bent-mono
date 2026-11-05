import { createHash, randomUUID, randomBytes } from "node:crypto";
import { productionAWS } from "./native-production-ci.mjs";
import { productionCloudflare } from "./native-production-cloudflare.mjs";
import { productionReleaseStore } from "./native-production-release-store.mjs";
import { verifyProductionRuntime } from "./native-production-runtime.mjs";
import { verifyProductionPairStatus, verifyRecordedProductionVersion } from "./native-production-release.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { printExecutorProtocol } from "./native-print-executor.mjs";
import { inspectDevelopmentWorker } from "./native-ci-worker.mjs";
import { observeReconnectingFamily, summarizeCommittedPrintLatency } from "./native-ci-qualification.mjs";
import { runProductionMonitor, verifyStableProductionMonitoring } from "./native-production-monitor.mjs";
import { syntheticProductionCanaryArtwork } from "./native-production-canary-source.mjs";
import { assertReleasePaused, recordReleaseEvent } from "./native-release-pause.mjs";
const check = (value, reason) => { if (!value)
    throw new Error(`Production canary stopped: ${reason}`); };
const sha = value => createHash("sha256").update(value).digest("hex");
const SHIRT = "a51b7acf-77e9-4762-83c4-62d96dd8942c", TOTE = "97b629d7-1d3b-4d2a-a586-537168141e97";
export function canaryFailureStage(runId) {
    check(/^[1-9][0-9]+$/.test(runId ?? ""), "Actions run identity.");
    return `canary-failed-${[...runId].map(value => String.fromCharCode(97 + Number(value))).join("")}`;
}
export function canaryArtworkKey(designId, sha256) {
    check(/^[a-f0-9-]{36}$/.test(designId ?? "") && /^[a-f0-9]{64}$/.test(sha256 ?? ""), "immutable synthetic artwork identity.");
    return `designs/${designId}/artwork/${sha256}`;
}
export function verifyCanaryJobs(jobs) {
    check(jobs.length === 4 && new Set(jobs.map(job => `${job.base_product_id}:${job.colour.toLowerCase()}`)).size === 4 &&
        jobs.every(job => [`${SHIRT}:black`, `${SHIRT}:white`, `${TOTE}:black`, `${TOTE}:cream`].includes(`${job.base_product_id}:${job.colour.toLowerCase()}`) &&
            job.status === "ready" && job.attempt_count === 1 && typeof job.execution_id === "string" && job.execution_id.length > 0 && job.output_byte_size > 0), "all four approved variants must be ready from their first fenced attempts.");
}
export async function readCanaryArtwork(response, source) {
    check(response.ok && response.body && Number.isSafeInteger(source.byte_size) && source.byte_size > 0 && source.byte_size <= 25000000, "bounded artwork response.");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        check(size <= source.byte_size, "bounded seed artwork.");
        chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    check(size === source.byte_size && sha(bytes) === source.sha256, "seed artwork checksum.");
    return bytes;
}
export async function readCanaryResponse(response, limit = 65536) {
    check(response.body && Number.isSafeInteger(limit) && limit > 0 && limit <= 65536, "bounded family response.");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        check(size <= limit, "bounded family response.");
        chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}
export function canaryWebPath(path) {
    if (path === "/v2/configured-product-families")
        return "/api/configured-product-families";
    const match = /^\/v2\/internal\/configured-products\/([a-f0-9-]{36})\/(story-video-events|story-videos\/(black|white|cream))$/.exec(path);
    check(match, "bounded canary BFF route.");
    return `/api/configured-product-video/${match[1]}/${match[2] === "story-video-events" ? "events" : `${match[3]}.mp4`}`;
}
export async function productionCanary(env, { webOrigin, webProtectionBypass } = {}) {
    check(["canary", "release-storefront"].includes(env.NATIVE_OPERATION) && /^native-[1-9][0-9]+$/.test(env.NATIVE_VERIFY_RELEASE ?? "") && env.FOREVER_TEE_API_SHARED_SECRET && env.BENT_SHIRT_OPERATIONS_SECRET, "explicit deployed release and existing service credentials.");
    check(webOrigin === undefined || /^https:\/\/forever-tee-[a-z0-9]+-bentbrains-projects\.vercel\.app$/.test(webOrigin), "verified staged project origin only.");
    check(webProtectionBypass === undefined || webOrigin && /^[A-Za-z0-9_-]{16,256}$/.test(webProtectionBypass), "staged-only automation credential.");
    const protection = webProtectionBypass ? { "x-vercel-protection-bypass": webProtectionBypass } : {};
    if (webOrigin) {
        const response = await fetch(webOrigin, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30000), headers: protection });
        check(response.ok, "staged access must work before any canary fixture is created.");
    }
    const { call } = await productionAWS(env), cf = productionCloudflare(env), store = await productionReleaseStore(env, call), releaseId = env.NATIVE_VERIFY_RELEASE;
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const controls = await query("SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton=1");
    check(controls.length === 1 && controls[0].paused === 0 && controls[0].release_id === null && controls[0].current_release_id === releaseId, "exact unpaused native release.");
    const rows = await query("SELECT payload FROM native_video_release_events WHERE release_id=? AND stage='verified'", [releaseId]);
    check(rows.length === 1, "completed paired release required.");
    const verified = JSON.parse(rows[0].payload);
    check(verified.provider === "lambda" && verified.rollbackRehearsed === true && verified.releaseId === releaseId, "rehearsed native release.");
    const preparedRows = await query("SELECT payload FROM native_video_release_events WHERE release_id=? AND stage='prepared'", [releaseId]);
    check(preparedRows.length === 1, "original preparation required.");
    const prepared = JSON.parse(preparedRows[0].payload);
    const original = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
    const inspectPrintExecutor = () => printExecutorProtocol("production").verifyRecordedPrintExecutor({
        env, api: cf, prepared, store, inspectWorker: inspectDevelopmentWorker
    });
    const printExecutor = prepared.worker.printExecutor ? await inspectPrintExecutor() : null;
    check(!printExecutor || equal(verified.worker?.printExecutor, printExecutor), "admitted print generation differs.");
    await verifyProductionRuntime(call);
    await verifyRecordedProductionVersion(cf, verified.native, prepared.variables, original.settings);
    await verifyProductionPairStatus(env, releaseId, verified.sourceCommit, false);
    check((await query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status IN ('queued','rendering')"))[0].count === 0, "other active work must settle before the single-family canary.");
    const { source, bytes: artwork } = syntheticProductionCanaryArtwork();
    const designId = randomUUID(), sessionToken = randomBytes(32).toString("base64url"), ownerId = sha(sessionToken), artworkKey = canaryArtworkKey(designId, source.sha256), createdAt = Date.now();
    await store.save("canary-fixture.json", Buffer.from(JSON.stringify({ designId, ownerId, sessionToken, artworkKey, source, releaseId, createdAt })));
    await (await cf.canaryArtwork(artworkKey, artwork)).body?.cancel();
    const copy = await readCanaryArtwork(await cf.canaryArtwork(artworkKey), source);
    check(copy.length === artwork.length && sha(copy) === source.sha256, "canary artwork readback.");
    const inserted = await cf.query(`INSERT INTO designs (id,owner_id,artwork_key,content_type,byte_size,artwork_width,artwork_height,sha256,
    crop_x,crop_y,crop_zoom,placement_x,placement_y,placement_width,depth,status,version,finalized_at,created_at,updated_at)
    VALUES (?,?,?,'image/png',?,?,?, ?,0.5,0.5,1,0.39,0.43,0.22,5,'ready',0,NULL,?,?)`, [designId, ownerId, artworkKey, source.byte_size, source.artwork_width, source.artwork_height, source.sha256, createdAt, createdAt]);
    check(inserted[0].meta?.changes === 1, "new isolated canary draft creation.");
    const api = (path, options = {}) => fetch(webOrigin ? webOrigin + canaryWebPath(path) : `https://forever-tee-api.socialqueue.workers.dev${path}`, {
        ...options, redirect: "error", signal: AbortSignal.timeout(60000), headers: webOrigin
            ? { ...protection, Cookie: `__Host-forever_tee_session=${sessionToken}`, Origin: webOrigin, "Content-Type": "application/json" }
            : { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET, "x-forever-tee-owner-id": ownerId, "Content-Type": "application/json" },
    });
    const startedAt = Date.now();
    const confirmed = await api("/v2/configured-product-families", { method: "POST", body: JSON.stringify({ designId, expectedVersion: 0, baseProductIds: [SHIRT, TOTE] }) });
    const familyResponse = await readCanaryResponse(confirmed);
    await store.save("family-response.json", Buffer.from(JSON.stringify({ status: confirmed.status, body: familyResponse.value })));
    check(confirmed.status === 201, `real family confirmation returned HTTP ${confirmed.status}.`);
    const products = familyResponse.value.products;
    check(products?.length === 2 && products.every(product => /^[a-f0-9-]{36}$/.test(product.id)), "two immutable Configured Products.");
    const revisions = await query("SELECT DISTINCT design_revision_id FROM products WHERE design_id=?", [designId]);
    check(revisions.length === 1, "single canary revision.");
    await cf.duplicateCanaryDelivery(revisions[0].design_revision_id);
    await cf.duplicateCanaryDelivery(revisions[0].design_revision_id);
    const stream = `/v2/internal/configured-products/${products[0].id}/story-video-events`;
    const first = await api(stream);
    check(first.ok && first.body, "initial readiness stream.");
    const reader = first.body.getReader();
    await reader.read();
    await reader.cancel();
    const timing = await observeReconnectingFamily(() => api(stream), products.map(product => product.id), startedAt);
    const jobs = await query(`SELECT jobs.id,jobs.product_id,products.base_product_id,jobs.colour,jobs.status,jobs.attempt_count,jobs.execution_id,jobs.output_byte_size
    FROM story_video_jobs jobs JOIN products ON products.id=jobs.product_id WHERE products.design_id=? ORDER BY jobs.id`, [designId]);
    verifyCanaryJobs(jobs);
    check(timing.firstPushMs <= 60000 && timing.allPushMs <= 120000, "Production first/all readiness thresholds.");
    for (const job of jobs) {
        const response = await api(`/v2/internal/configured-products/${job.product_id}/story-videos/${job.colour.toLowerCase()}`, { method: "HEAD" });
        check(response.status === 200 && response.headers.get("content-type") === "video/mp4" && Number(response.headers.get("content-length")) === job.output_byte_size, "immutable gallery video availability.");
    }
    let printLatency;
    if (printExecutor) {
        const printJobs = await query(`SELECT configured_product_id,status,attempt_count,lease_id,created_at,updated_at
      FROM print_asset_jobs WHERE configured_product_id IN (?, ?)`, products.map(product => product.id));
        printLatency = summarizeCommittedPrintLatency(printJobs, products.map(product => product.id), {
            sourceCommit: verified.sourceCommit, provider: "durable-object"
        });
        check(printLatency.passed, "both canary print products must commit ready within twelve seconds.");
        check(equal(await inspectPrintExecutor(), printExecutor), "print executor changed during the canary.");
    }
    const report = { productionCanaryPassed: true, ...(printExecutor ? { printExecutor, printLatency } : {}), releaseId, sourceCommit: verified.sourceCommit, imageDigest: verified.candidate.imageDigest,
        videos: 4, attemptsPerVideo: 1, firstPushMs: timing.firstPushMs, allPushMs: timing.allPushMs, reconnectVerified: true, duplicateQueueDeliveries: 2,
        realMobilePlaybackMeasured: false, syntheticArtwork: source.kind, storefrontBffVerified: !!webOrigin, products: products.map(product => product.id), jobs };
    const evidence = await store.save("canary-report.json", Buffer.from(JSON.stringify(report)));
    const monitoring = await runProductionMonitor({ ...env, NATIVE_OPERATION: "monitor" });
    verifyStableProductionMonitoring(verified.monitoringBaseline, monitoring);
    if (!webOrigin)
        await recordReleaseEvent(cf, releaseId, "canary-verified", { runId: env.GITHUB_RUN_ID, evidence, sourceCommit: verified.sourceCommit });
    return { ...report, jobs: undefined, evidence, monitoring: monitoring.evidence };
}
export async function runProductionCanary(env) {
    try {
        return await productionCanary(env);
    }
    catch (error) {
        const releaseId = env.NATIVE_VERIFY_RELEASE;
        if (/^native-[1-9][0-9]+$/.test(releaseId ?? "")) {
            const cf = productionCloudflare(env), now = Date.now();
            await cf.query(`UPDATE native_video_release_control SET paused=1,release_id=?,paused_at=?,updated_at=?
        WHERE singleton=1 AND paused=0 AND release_id IS NULL AND current_release_id=?`, [releaseId, now, now, releaseId]);
            await assertReleasePaused(cf, releaseId);
            await recordReleaseEvent(cf, releaseId, canaryFailureStage(env.GITHUB_RUN_ID), { runId: env.GITHUB_RUN_ID, admissionsPaused: true });
        }
        throw error;
    }
}
