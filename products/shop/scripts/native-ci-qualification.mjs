import { protectedConfig } from "./protected-config.mjs";
import { commerceBoundary } from './rendering-inputs.mjs';
import { captureRendererArchive } from "./native-renderer-archive.mjs";
import { measureReleaseStage } from "./release-stage-timing.mjs";
import { captureRendererEvidence, verifyReusableRenderer } from "./native-rendering-qualification.mjs";
import { qualifyShippingDatabase } from "./native-shipping-qualification.mjs";
import { captureQualificationInventory } from "./native-qualification-inventory.mjs";
import { qualificationIdentity } from "./native-qualification-identity.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { developmentCloudflare } from "./native-ci-cloudflare.mjs";
import { inspectDevelopmentRuntime } from "./native-ci-runtime.mjs";
import { inspectDevelopmentWorker, verifyDevelopmentPairStatus } from "./native-ci-worker.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { createDevelopmentCICall } from "./native-ci-aws.mjs";
import { observePrintLatencyBurst } from "./print-latency-burst.mjs";
import { printLatencyDistribution } from "./print-latency-report.mjs";
import { verifyRecordedPrintExecutor } from "./native-print-executor.mjs";
import { preserveQualifiedPrintExecutor } from "./native-print-qualification.mjs";
import { verifyWorkerUpload } from "./native-worker-content.mjs";
const ARTWORK_SHA = protectedConfig("resource_73e91e639e8e");
const check = (value, reason) => { if (!value)
    throw new Error(`Native cloud qualification failed: ${reason}`); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export async function readQualifiedArtwork(response) {
    check(response.ok && response.body, "saved artwork download.");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        check(size <= 6120149, "saved artwork size exceeded.");
        chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    check(size === 6120149 && hash(bytes) === ARTWORK_SHA, "approved saved artwork checksum.");
    return bytes;
}
export async function observeFamilyStream(response, productIds, startedAt, now = Date.now, { requireComplete = true } = {}) {
    check(response.ok && response.headers.get("content-type")?.startsWith("text/event-stream") && response.body, "readiness stream.");
    const ready = new Map();
    let pending = "", push = false, completed = false;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        check(pending.length <= 65536, "bounded event stream.");
        for (let end = pending.indexOf("\n\n"); end >= 0; end = pending.indexOf("\n\n")) {
            const message = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (message.includes("notification-mode=push"))
                push = true;
            if (message.startsWith("event: complete\n"))
                completed = true;
            if (!message.startsWith("event: video\n"))
                continue;
            const value = JSON.parse(message.slice(message.indexOf("data: ") + 6));
            check(productIds.includes(value.productId) && ["black", "white", "cream"].includes(value.color), "unexpected family event.");
            check(value.status !== "unavailable", "terminal family failure.");
            if (value.status === "ready") {
                const key = `${value.productId}:${value.color}`;
                if (!ready.has(key))
                    ready.set(key, now() - startedAt);
            }
        }
    }
    check(push && (!requireComplete || completed && ready.size === 4), `all four ready events and completion required after reconnect (ready=${ready.size}, push=${push}, complete=${completed}).`);
    return { firstPushMs: ready.size ? Math.min(...ready.values()) : null, allPushMs: ready.size ? Math.max(...ready.values()) : null,
        readyKeys: [...ready.keys()], completed };
}
export async function observeReconnectingFamily(open, productIds, startedAt, now = Date.now) {
    let firstPushMs = null;
    for (let connection = 1; connection <= 4; connection++) {
        check(now() - startedAt < 180000, "family readiness exceeded the three-minute qualification window.");
        const part = await observeFamilyStream(await open(), productIds, startedAt, now, { requireComplete: false });
        check(now() - startedAt < 180000, "family readiness exceeded the three-minute qualification window.");
        firstPushMs ??= part.firstPushMs;
        if (part.completed) {
            check(part.readyKeys.length === 4 && firstPushMs !== null, "complete family must contain all four ready variants.");
            return { ...part, firstPushMs, connections: connection };
        }
    }
    throw new Error("Native cloud qualification failed: family remained incomplete after four stream connections.");
}
export function qualificationPngDimensions(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    check(bytes instanceof Uint8Array && bytes.byteLength >= 24 && signature.every((value, index) => bytes[index] === value) &&
        bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 13 &&
        bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82, "validated qualification PNG header.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16), height = view.getUint32(20);
    check(width > 0 && width <= 12000 && height > 0 && height <= 12000, "bounded qualification PNG dimensions.");
    return { width, height };
}
export function assertQualificationApiPath(path) {
    check(/^\/v2\/(configured-product-families|design-drafts\/[a-f0-9-]{36}|internal\/configured-products\/[a-f0-9-]{36}\/(purchase-readiness|story-video-events|story-videos\/(black|white|cream)))$/.test(path), "fixture API route.");
}
async function prepareQualification(env) {
    const cf = developmentCloudflare(env), releaseId = env.NATIVE_VERIFY_RELEASE;
    check(/^native-\d+$/.test(releaseId ?? "") && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") &&
        env.FOREVER_TEE_API_SHARED_SECRET && env.BENT_SHIRT_OPERATIONS_SECRET, "explicit deployed release and existing service credentials required.");
    const query = async (sql, params = []) => (await cf.query(sql, params))[0].results;
    const control = (await query("SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1"))[0];
    check(control?.paused === 0 && control.release_id === null && control.current_release_id === releaseId, "release must be live and unpaused.");
    const rows = await query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'prepared'", [releaseId]);
    check(rows.length === 1, "deployed pair preparation.");
    const prepared = JSON.parse(rows[0].payload);
    const runtime = await inspectDevelopmentRuntime(env), worker = await inspectDevelopmentWorker(cf);
    check(runtime.renderer.imageDigest === prepared.candidate.imageDigest && runtime.failure.imageDigest === prepared.candidate.imageDigest &&
        runtime.renderer.sourceDigest === prepared.candidate.sourceDigest, "live pair differs from the recorded release.");
    verifyWorkerUpload(worker.content, prepared.worker);
    await verifyDevelopmentPairStatus(env, prepared.candidate, releaseId, fetch, { paused: false, sourceCommit: prepared.sourceCommit });
    check((await query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status IN ('queued', 'rendering')"))[0].count === 0, "other active work must settle before the bounded fixture cohort.");
    const source = (await query("SELECT id, artwork_key FROM designs WHERE sha256 = ? AND status = 'ready' AND deleted_at IS NULL ORDER BY created_at LIMIT 1", [ARTWORK_SHA]))[0];
    check(source, "approved saved design unavailable.");
    const artwork = await readQualifiedArtwork(await cf.readArtwork(source.artwork_key));
    const dimensions = qualificationPngDimensions(artwork);
    const store = await createDevelopmentReleaseStore(env);
    const verifyPrintExecutor = () => verifyRecordedPrintExecutor({ env, api: cf, prepared, store,
        inspectWorker: inspectDevelopmentWorker });
    const printExecutor = await verifyPrintExecutor();
    const api = async (path, ownerId, options = {}) => {
        assertQualificationApiPath(path);
        return fetch(`${env.WORKER_URL}${path}`, { redirect: "error", signal: AbortSignal.timeout(60000), ...options,
            headers: { "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET, "x-forever-tee-owner-id": ownerId, "Content-Type": "application/json" } });
    };
    return { cf, query, prepared, source, artwork, dimensions, store, api, releaseId, runId: env.GITHUB_RUN_ID,
        printExecutor, verifyPrintExecutor };
}
export function qualificationArtworkKey(designId, sha256) {
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(designId) && /^[0-9a-f]{64}$/.test(sha256), "canonical qualification artwork identity.");
    return `designs/${designId}/artwork/${sha256}`;
}
async function createFixture(context, label) {
    const { cf, source, artwork, dimensions, store, api, releaseId, runId } = context;
    const designId = randomUUID(), ownerId = randomBytes(32).toString("hex"), artworkKey = qualificationArtworkKey(designId, ARTWORK_SHA), now = Date.now();
    const access = await api(`/v2/design-drafts/${source.id}`, ownerId);
    await access.body?.cancel();
    check(access.status === 404, "service authentication and source-owner isolation.");
    await store.save(`qualification-family-${label}.json`, Buffer.from(JSON.stringify({ designId, ownerId, artworkKey, artworkSha256: ARTWORK_SHA, sourceDesignId: source.id, releaseId })));
    const upload = await cf.createQualificationArtwork(artworkKey, artwork);
    await upload.body?.cancel();
    check(hash(await readQualifiedArtwork(await cf.readArtwork(artworkKey))) === ARTWORK_SHA, "fixture artwork readback.");
    const inserted = await cf.query(`INSERT INTO designs (id, owner_id, artwork_key, content_type, byte_size, artwork_width, artwork_height,
      sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, status, version, finalized_at, created_at, updated_at)
      SELECT ?, ?, ?, content_type, byte_size, ?, ?, ?, crop_x, crop_y, crop_zoom,
        placement_x, placement_y, placement_width, depth, 'ready', 0, NULL, ?, ? FROM designs WHERE id = ?`, [designId, ownerId, artworkKey, dimensions.width, dimensions.height, ARTWORK_SHA, now, now, source.id]);
    check(inserted[0].meta?.changes === 1, "new isolated fixture creation.");
    const marker = await cf.query(`INSERT INTO storage_test_fixtures
      (design_id, run_id, purpose, created_at, expires_at)
      VALUES (?, ?, 'native-qualification', ?, ?)`, [designId, runId, now, now + 24 * 60 * 60 * 1000]);
    check(marker[0].meta?.changes === 1, "qualification fixture expiry marker.");
    return { designId, ownerId, label };
}
async function confirmFamily(api, fixture, signal) {
    const confirmation = await api("/v2/configured-product-families", fixture.ownerId, { method: "POST", body: JSON.stringify({
            designId: fixture.designId, expectedVersion: 0, baseProductIds: ["a51b7acf-77e9-4762-83c4-62d96dd8942c", "97b629d7-1d3b-4d2a-a586-537168141e97"],
        }), ...(signal ? { signal } : {}) });
    if (confirmation.status !== 201) {
        const failure = await boundedApiFailure(confirmation);
        throw new Error(`Native cloud qualification failed: real family confirmation (status=${failure.status}, code=${failure.code}).`);
    }
    const { products } = await confirmation.json();
    check(products?.length === 2 && products.every(product => /^[a-f0-9-]{36}$/.test(product.id)), "confirmed immutable product family.");
    return products;
}
export function beginFamilyPrintQualification(api, fixture) {
    const confirmation = confirmFamily(api, fixture, AbortSignal.timeout(5000));
    const printObservation = observePrintLatencyBurst([{ id: fixture.designId }], {
        confirmFamily: async () => (await confirmation).map(product => product.id),
        readProductReadiness: async (_fixture, productId, signal) => {
            const response = await api(`/v2/internal/configured-products/${productId}/purchase-readiness`, fixture.ownerId, { signal });
            check(response.ok, "print readiness request failed.");
            const body = await response.json();
            check(body && typeof body.ready === "boolean", "invalid print readiness response.");
            return body.ready;
        },
    });
    return { confirmation, printObservation };
}
export async function boundedApiFailure(response) {
    const status = response.status;
    if (!response.body)
        return { status, code: "NO_BODY" };
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const part = await reader.read();
        if (part.done)
            break;
        size += part.value.byteLength;
        if (size > 4096) {
            await reader.cancel();
            return { status, code: "OVERSIZED_BODY" };
        }
        chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        const value = JSON.parse(new TextDecoder().decode(bytes));
        const code = value?.error?.code;
        return { status, code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNKNOWN" };
    }
    catch {
        return { status, code: "INVALID_JSON" };
    }
}
export function summarizePrintAssetFailures(rows) {
    check(Array.isArray(rows) && rows.length <= 12, "bounded Print Asset failure rows.");
    return rows.map(row => {
        const message = typeof row.last_error === "string" ? row.last_error : "NO_ERROR";
        const redacted = message
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<ID>")
            .replace(/https?:\/\/\S+/gi, "<URL>")
            .replace(/[^\x20-\x7e]/g, "?")
            .slice(0, 240);
        return {
            geometry: typeof row.geometry_key === "string" && /^[a-z0-9_-]+:[0-9]+x[0-9]+$/.test(row.geometry_key) ? row.geometry_key : "UNKNOWN",
            status: ["pending", "failed", "ready"].includes(row.status) ? row.status : "UNKNOWN",
            error: redacted,
        };
    });
}
export function summarizePrintSourceChecks(rows) {
    check(Array.isArray(rows) && rows.length <= 2, "bounded Print Asset source rows.");
    return rows.map(row => ({
        baseProduct: ["a51b7acf-77e9-4762-83c4-62d96dd8942c", "97b629d7-1d3b-4d2a-a586-537168141e97"].includes(row.base_product_id) ? row.base_product_id : "UNKNOWN",
        canonicalArtwork: row.canonical_artwork === 1,
        dimensionsValid: row.dimensions_valid === 1,
        geometryCount: Number.isSafeInteger(row.geometry_count) && row.geometry_count >= 0 && row.geometry_count <= 20 ? row.geometry_count : -1,
        hasRevision: row.has_revision === 1,
        projectionValid: row.projection_valid === 1,
        sizeValid: row.size_valid === 1,
    }));
}
export async function qualifyDevelopmentFamilies(env = process.env, familyCount = 2) {
    check(familyCount === 2 || familyCount === 3, "only the bounded two/three-family cohorts are supported.");
    const context = await prepareQualification(env);
    const { cf, query, prepared, store, api, releaseId } = context;
    const printProvider = qualificationPrintProvider(await cf.settings());
    const fixtures = [];
    for (const label of ["one", "two", "three"].slice(0, familyCount))
        fixtures.push(await createFixture(context, familyCount === 3 ? `load-${label}` : label));
    const synchronizeLoad = familyCount === 3;
    let admission;
    if (synchronizeLoad) {
        const schema = await readFile(new URL("../workers/api/sql/native-qualification.sql", import.meta.url), "utf8");
        for (const statement of schema.split(";").map(part => part.trim()).filter(Boolean))
            await cf.query(statement);
        const preparedAt = Date.now();
        for (const fixture of fixtures) {
            for (const point of ["enqueue-send", "direct-dispatch"]) {
                await cf.query(`INSERT INTO native_video_qualification_faults
          (design_id, release_id, run_id, point, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, [fixture.designId, releaseId, env.GITHUB_RUN_ID, point, preparedAt, preparedAt + 600000]);
            }
        }
    }
    const loadBarrier = synchronizeLoad ? createQualificationDispatchBarrier(3, async (revisions) => {
        await Promise.all(revisions.flatMap(revisionId => [
            cf.duplicateQualificationDelivery(revisionId),
            cf.duplicateQualificationDelivery(revisionId),
        ]));
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const rows = await query(`SELECT jobs.status, jobs.attempt_count FROM story_video_jobs jobs
        JOIN products ON products.id = jobs.product_id WHERE products.design_id IN (?, ?, ?)`, fixtures.map(fixture => fixture.designId));
            const running = rows.filter(row => row.status === "rendering").length;
            const waiting = rows.filter(row => row.status === "queued" && row.attempt_count === 0).length;
            check(running <= 8, "application admission exceeded renderer capacity.");
            if (running > 0 && waiting > 0) {
                admission = { version: 1, limit: 8, running, waiting, waitingAttempts: 0 };
                break;
            }
            await setTimeout(250);
        }
        check(admission, "excess jobs were not observed waiting without consuming attempts.");
    }) : null;
    const printLatencyReports = [];
    const outcomes = await Promise.allSettled(fixtures.map(async (fixture) => {
        let printObservation;
        try {
            const startedAt = Date.now();
            // Start print observation with configuration. Video admission, encoding and
            // reconnect checks cannot move this clock or delay the first readiness read.
            const print = beginFamilyPrintQualification(api, fixture);
            const { confirmation } = print;
            printObservation = print.printObservation;
            const products = await confirmation;
            const confirmationMs = Date.now() - startedAt;
            const revisions = await query("SELECT DISTINCT design_revision_id FROM products WHERE design_id = ?", [fixture.designId]);
            check(revisions.length === 1, "single fixture revision.");
            const revisionId = revisions[0].design_revision_id;
            if (loadBarrier) {
                const loadJobs = () => query(`SELECT jobs.id, jobs.product_id, jobs.colour, jobs.status, jobs.attempt_count, jobs.execution_id,
        jobs.output_byte_size FROM story_video_jobs AS jobs JOIN products ON products.id = jobs.product_id
        WHERE products.design_id = ? ORDER BY jobs.id`, [fixture.designId]);
                const stopped = await awaitInitialExhaustionStop(loadJobs, () => query("SELECT point, consumed_at, job_id FROM native_video_qualification_faults WHERE design_id = ? ORDER BY point", [fixture.designId]));
                preparedExhaustionJobs(stopped.jobs, stopped.faults);
                await loadBarrier.arrive(revisionId);
            }
            else {
                await cf.duplicateQualificationDelivery(revisionId);
                await cf.duplicateQualificationDelivery(revisionId);
            }
            const path = `/v2/internal/configured-products/${products[0].id}/story-video-events`;
            const first = await api(path, fixture.ownerId);
            check(first.ok && first.body, "initial stream connection.");
            const reader = first.body.getReader();
            await reader.read();
            await reader.cancel();
            const timing = await observeReconnectingFamily(() => api(path, fixture.ownerId), products.map(product => product.id), startedAt);
            const jobs = await query(`SELECT jobs.id, jobs.product_id, jobs.colour, jobs.status, jobs.attempt_count, jobs.execution_id, jobs.output_byte_size
      FROM story_video_jobs AS jobs JOIN products ON products.id = jobs.product_id WHERE products.design_id = ?`, [fixture.designId]);
            check(jobs.length === 4 && jobs.every(job => job.status === "ready" && job.attempt_count === 1 && job.execution_id && job.output_byte_size > 0), "duplicate deliveries or reconnect consumed attempts or lost readiness.");
            for (const job of jobs) {
                const response = await api(`/v2/internal/configured-products/${job.product_id}/story-videos/${job.colour.toLowerCase()}`, fixture.ownerId, { method: "HEAD" });
                check(response.status === 200 && response.headers.get("content-type") === "video/mp4" && Number(response.headers.get("content-length")) === job.output_byte_size, "stored immutable video is not available through the gallery route.");
            }
            const printReadiness = await printObservation;
            const printJobs = await query(`SELECT configured_product_id, status, lease_id, attempt_count, created_at, updated_at
      FROM print_asset_jobs WHERE configured_product_id IN (?, ?)`, products.map(product => product.id));
            const printLatency = summarizeCommittedPrintLatency(printJobs, products.map(product => product.id), {
                sourceCommit: prepared.sourceCommit, provider: printProvider,
            });
            printLatencyReports.push({ label: fixture.label, ...printLatency });
            const report = { releaseId, sourceCommit: prepared.sourceCommit, printProvider, label: fixture.label,
                startedAt, confirmationMs, ...timing, printReadiness, printLatency, jobs, products };
            await store.save(`qualification-report-${fixture.label}.json`, Buffer.from(JSON.stringify(report)));
            check(printReadiness.passed, "family print artwork did not become ready in the bounded observation window.");
            check(printLatency.passed, "family print committed readiness exceeded the 12-second candidate gate or lacked complete durable jobs.");
            return { label: fixture.label, confirmationMs, firstPushMs: timing.firstPushMs, allPushMs: timing.allPushMs,
                connections: timing.connections, printReadiness, printLatency, videos: 4, attemptsPerVideo: 1 };
        }
        catch (error) {
            loadBarrier?.fail(error);
            // All HTTP observations must settle before the outer qualification cleanup
            // can remove their pre-journaled fixtures, even if video checking failed.
            const printReadiness = printObservation ? await printObservation : null;
            const jobs = await query(`SELECT jobs.id, jobs.status, jobs.attempt_count, jobs.execution_id, jobs.output_byte_size, jobs.last_error,
        jobs.created_at, jobs.updated_at FROM story_video_jobs AS jobs JOIN products ON products.id = jobs.product_id WHERE products.design_id = ?`, [fixture.designId]);
            const assetFailures = summarizePrintAssetFailures(await query(`SELECT assets.geometry_key, assets.status, assets.last_error
        FROM print_assets AS assets JOIN products ON products.id = assets.configured_product_id
        WHERE products.design_id = ? ORDER BY assets.geometry_key LIMIT 12`, [fixture.designId]));
            const sourceChecks = summarizePrintSourceChecks(await query("SELECT products.base_product_id,\n        (products.design_revision_id IS NOT NULL) AS has_revision,\n        (products.projection_version = 'safe-margin-v1') AS projection_valid,\n        (revisions.artwork_key = 'designs/' || products.design_id || '/artwork/' || revisions.sha256) AS canonical_artwork,\n        (revisions.byte_size > 0 AND revisions.byte_size <= " + "25000000" + ") AS size_valid,\n        (revisions.artwork_width > 0 AND revisions.artwork_height > 0) AS dimensions_valid,\n        (SELECT count(DISTINCT lower(variants.decoration_method) || ':' || variants.print_width || 'x' || variants.print_height)\n          FROM printify_catalogue_variants AS variants WHERE variants.snapshot_id = (\n            SELECT snapshots.id FROM printify_catalogue_snapshots AS snapshots\n            WHERE snapshots.base_product_id = products.base_product_id\n            ORDER BY snapshots.retrieved_at DESC, snapshots.id DESC LIMIT 1)) AS geometry_count\n        FROM products LEFT JOIN design_revisions AS revisions ON revisions.id = products.design_revision_id\n        WHERE products.design_id = ? ORDER BY products.base_product_id LIMIT 2", [fixture.designId]));
            await store.save(`qualification-failure-${fixture.label}.json`, Buffer.from(JSON.stringify({ releaseId,
                sourceCommit: prepared.sourceCommit, printProvider, fixture, printReadiness, jobs, assetFailures, sourceChecks })));
            console.error(JSON.stringify({ cloudFamilyFailed: fixture.label, assetFailures, sourceChecks, jobs: jobs.map(job => ({ status: job.status, attempts: job.attempt_count,
                    executionClaimed: !!job.execution_id, hasOutput: job.output_byte_size > 0 })) }));
            throw error;
        }
    }));
    const printLatency = { sourceCommit: prepared.sourceCommit, provider: printProvider, maxReadyMs: 12000,
        expectedFamilies: familyCount, reportedFamilies: printLatencyReports.length, reports: printLatencyReports,
        passed: printLatencyReports.length === familyCount && printLatencyReports.every(item => item.passed),
        distribution: printLatencyDistribution(printLatencyReports.flatMap(item => item.samples
            .map(sample => sample.recordToReadyMs).filter(value => value !== null))),
        note: "Both product jobs are reported; missing families fail. This small correlated cohort does not estimate design p95. Start latency and final status-write duration need executor phase evidence." };
    // Retain the entire cohort's latency evidence even when its acceptance gate
    // fails. No successful-only report can conceal the slowest family.
    await store.save(familyCount === 3 ? "qualification-print-latency-load.json" : "qualification-print-latency-normal.json", Buffer.from(JSON.stringify(printLatency)));
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed)
        throw failed.reason;
    check(isDeepStrictEqual(await context.verifyPrintExecutor(), context.printExecutor), "executor changed across the print qualification cohort.");
    const printExecutorArchive = context.printExecutor
        ? await preserveQualifiedPrintExecutor(context.printExecutor, store, familyCount === 3 ? "load" : "normal") : undefined;
    const reports = outcomes.map(outcome => outcome.value);
    const report = { cloudFamilyQualification: true, releaseId, sourceCommit: prepared.sourceCommit, imageDigest: prepared.candidate.imageDigest,
        reports, printLatency, ...(context.printExecutor ? { printExecutor: context.printExecutor, printExecutorArchive } : {}), ...(admission ? { admission } : {}), tested: [`${familyCount} simultaneous four-video families`, "two extra queue submissions per family", "stream disconnect and reconnect", "immutable gallery media HEAD", "both print products commit ready within 12 seconds of durable job creation"],
        notTested: ["duplicate AWS deliveries", "throttling", "lost invoke/claim/upload responses", "failed queue sends", "termination", "exhaustion", "real mobile playback"] };
    const evidence = await store.save(familyCount === 3 ? "qualification-load-cohort.json" : "qualification-summary.json", Buffer.from(JSON.stringify(report)));
    return { ...report, evidence };
}
export function qualificationPrintProvider(settings) {
    const bindings = settings.bindings?.filter(binding => binding.name === "PRINT_EXECUTION_MODE") ?? [];
    if (bindings.length === 0)
        return "queue";
    check(bindings.length === 1 && bindings[0].type === "plain_text" &&
        ["queue", "durable-object"].includes(bindings[0].text), "explicit print execution provider binding.");
    return bindings[0].text;
}
export function summarizeCommittedPrintLatency(rows, productIds, { sourceCommit, provider }) {
    check(/^[a-f0-9]{40}$/.test(sourceCommit ?? "") && ["queue", "durable-object"].includes(provider), "print latency source and provider.");
    check(productIds.length === 2 && new Set(productIds).size === 2 && rows.length <= 2 &&
        new Set(rows.map(row => row.configured_product_id)).size === rows.length &&
        rows.every(row => productIds.includes(row.configured_product_id)), "bounded owned print job rows.");
    const samples = productIds.map(productId => {
        const job = rows.find(row => row.configured_product_id === productId);
        const complete = job?.status === "ready" && job.lease_id === null && Number.isInteger(job.attempt_count) && job.attempt_count >= 1 &&
            Number.isSafeInteger(job.created_at) && job.created_at > 0 && Number.isSafeInteger(job.updated_at) && job.updated_at >= job.created_at;
        return { productId, complete, attempts: job?.attempt_count ?? null,
            jobCreatedAtMs: job?.created_at ?? null, readyWriteAtMs: complete ? job.updated_at : null,
            recordToReadyMs: complete ? job.updated_at - job.created_at : null };
    });
    return { schemaVersion: 1, sourceCommit, provider, maxReadyMs: 12000, samples,
        passed: samples.every(sample => sample.complete && sample.recordToReadyMs <= 12000),
        note: "D1 job created_at to ready updated_at, including retries. The ready state is verified committed; its timestamp precedes the write response. Final commit duration needs executor timing. Neither polling nor product creation timestamps measure this duration." };
}
export function exhaustedJobs(jobs) {
    check(jobs.length <= 4 && new Set(jobs.map(job => `${job.product_id}:${job.colour}`)).size === jobs.length &&
        jobs.every(job => Number.isSafeInteger(job.attempt_count) && job.attempt_count >= 0 && job.attempt_count <= 3 && ["queued", "rendering", "failed"].includes(job.status)), "invalid exhaustion cohort or unexpected successful encode.");
    return jobs.length === 4 && jobs.every(job => job.status === "failed" && job.attempt_count === 3 && typeof job.execution_id === "string" && job.execution_id.length > 0 &&
        job.output_byte_size === null);
}
export function preparedExhaustionJobs(jobs, faults) {
    check(jobs.length === 4 && new Set(jobs.map(job => `${job.product_id}:${job.colour}`)).size === jobs.length &&
        jobs.every(job => job.status === "queued" && job.attempt_count === 0 && job.execution_id === null && job.output_byte_size === null), "exhaustion jobs must remain untouched before checksum corruption.");
    check(faults.length === 2 && ["direct-dispatch", "enqueue-send"].every(point => faults.some(fault => fault.point === point && Number.isSafeInteger(fault.consumed_at) && fault.consumed_at > 0 &&
        jobs.some(job => job.id === fault.job_id))), "exhaustion dispatch faults were not consumed by owned jobs.");
    return true;
}
// Video completion alone does not prove that the new product can be purchased.
export async function awaitFamilyPrintReadiness(read, productIds, { now = Date.now, timeoutMs = 60000, wait = setTimeout, } = {}) {
    check(productIds.length === 2 && new Set(productIds).size === 2, "two distinct print products required.");
    const startedAt = now();
    const pending = new Set(productIds);
    for (;;) {
        await Promise.all([...pending].map(async (productId) => {
            const response = await read(productId);
            check(response.ok, "print readiness request failed.");
            const body = await response.json();
            check(body && typeof body.ready === "boolean", "invalid print readiness response.");
            if (body.ready)
                pending.delete(productId);
        }));
        const elapsedMs = now() - startedAt;
        check(elapsedMs <= timeoutMs, "family print artwork did not become ready in time.");
        if (pending.size === 0)
            return { readyProducts: productIds.length, waitMs: elapsedMs };
        check(elapsedMs < timeoutMs, "family print artwork did not become ready in time.");
        await wait(Math.min(1000, timeoutMs - elapsedMs));
    }
}
export async function awaitInitialExhaustionStop(loadJobs, loadFaults, { now = Date.now, timeoutMs = 10000, wait = setTimeout, } = {}) {
    const startedAt = now();
    for (;;) {
        const jobs = await loadJobs();
        const faults = await loadFaults();
        if (faults.length === 2 && faults.every(fault => fault.consumed_at))
            return { faults, jobs };
        check(now() - startedAt < timeoutMs, "initial exhaustion dispatch was not stopped in time.");
        await wait(250);
    }
}
export function createQualificationDispatchBarrier(expected, dispatch) {
    check(expected === 3 && typeof dispatch === "function", "load dispatch barrier configuration.");
    const revisions = [];
    let failed = false, released = false, rejectRelease, resolveRelease;
    const release = new Promise((resolve, reject) => {
        rejectRelease = reject;
        resolveRelease = resolve;
    });
    void release.catch(() => undefined);
    return {
        async arrive(revisionId) {
            check(!failed && !released && typeof revisionId === "string" && revisionId.length > 0 &&
                !revisions.includes(revisionId), "unique staged load revision.");
            revisions.push(revisionId);
            if (revisions.length === expected) {
                try {
                    await dispatch([...revisions]);
                    released = true;
                    resolveRelease();
                }
                catch (cause) {
                    failed = true;
                    rejectRelease(cause);
                }
            }
            return release;
        },
        fail(cause) {
            if (failed || released)
                return;
            failed = true;
            rejectRelease(cause);
        },
    };
}
export async function qualifyDevelopmentExhaustion(env = process.env) {
    const context = await prepareQualification(env);
    const { cf, query, prepared, store, api, releaseId } = context;
    const schema = await readFile(new URL("../workers/api/sql/native-qualification.sql", import.meta.url), "utf8");
    for (const statement of schema.split(";").map(part => part.trim()).filter(Boolean))
        await cf.query(statement);
    const fixture = await createFixture(context, "exhaustion");
    const preparedAt = Date.now();
    for (const point of ["enqueue-send", "direct-dispatch"]) {
        await cf.query(`INSERT INTO native_video_qualification_faults
      (design_id, release_id, run_id, point, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, [fixture.designId, releaseId, env.GITHUB_RUN_ID, point, preparedAt, preparedAt + 600000]);
    }
    const products = await confirmFamily(api, fixture);
    const loadJobs = () => query(`SELECT jobs.id, jobs.product_id, jobs.colour, jobs.status, jobs.attempt_count, jobs.execution_id,
    jobs.output_byte_size FROM story_video_jobs AS jobs JOIN products ON products.id = jobs.product_id WHERE products.design_id = ? ORDER BY jobs.id`, [fixture.designId]);
    const stopped = await awaitInitialExhaustionStop(loadJobs, () => query("SELECT point, consumed_at, job_id FROM native_video_qualification_faults WHERE design_id = ? ORDER BY point", [fixture.designId]));
    const faults = stopped.faults;
    let jobs = stopped.jobs;
    preparedExhaustionJobs(jobs, faults);
    const revisions = await query("SELECT DISTINCT design_revision_id FROM products WHERE design_id = ?", [fixture.designId]);
    check(revisions.length === 1, "single exhausted fixture revision.");
    const corrupted = await cf.query(`UPDATE design_revisions SET sha256 = ?
    WHERE id = ? AND design_id = ? AND sha256 = ?`, ["0".repeat(64), revisions[0].design_revision_id, fixture.designId, ARTWORK_SHA]);
    check(corrupted[0].meta?.changes === 1, "isolated exhaustion checksum corruption.");
    await cf.duplicateQualificationDelivery(revisions[0].design_revision_id);
    const startedAt = Date.now();
    for (;;) {
        jobs = await loadJobs();
        if (exhaustedJobs(jobs))
            break;
        check(Date.now() - startedAt < 600000, "exhaustion did not settle within ten minutes.");
        await setTimeout(10000);
    }
    const settledMs = Date.now() - startedAt;
    await cf.duplicateQualificationDelivery(revisions[0].design_revision_id);
    await setTimeout(20000);
    const after = await loadJobs();
    check(exhaustedJobs(after) && isDeepStrictEqual(after, jobs), "terminal duplicate changed the exhausted jobs.");
    const stream = await api(`/v2/internal/configured-products/${products[0].id}/story-video-events`, fixture.ownerId);
    check(stream.ok && stream.headers.get("content-type")?.startsWith("text/event-stream"), "exhausted family stream.");
    const text = await stream.text();
    check(text.length <= 65536 && text.includes("notification-mode=push") && text.includes("event: complete\n"), "terminal stream completion.");
    const events = text.split("\n\n").filter(part => part.startsWith("event: video\n")).map(part => JSON.parse(part.slice(part.indexOf("data: ") + 6)));
    check(events.length === 4 && new Set(events.map(event => `${event.productId}:${event.color}`)).size === 4 &&
        events.every(event => event.status === "unavailable" && jobs.some(job => job.product_id === event.productId && job.colour.toLowerCase() === event.color)), "all four exhausted variants must become unavailable.");
    const report = { cloudExhaustionQualification: true, releaseId, sourceCommit: prepared.sourceCommit, imageDigest: prepared.candidate.imageDigest,
        settledMs, attemptsPerVideo: 3, videos: 4, terminalDuplicateStable: true, jobs };
    const evidence = await store.save("qualification-exhaustion-report.json", Buffer.from(JSON.stringify(report)));
    return { ...report, jobs: undefined, evidence };
}
export function verifyFaultEvidence(point, jobs, faults, observations) {
    check(jobs.length === 4 && new Set(jobs.map(job => `${job.product_id}:${job.colour}`)).size === 4 &&
        jobs.every(job => job.status === "ready" && job.attempt_count === 1 && job.execution_id && job.output_byte_size > 0), "fault cohort must finish all four variants in their original fenced attempts.");
    const points = point === "enqueue-send" ? [point, "direct-dispatch"] : [point];
    check(faults.length === points.length && points.every(name => faults.some(fault => fault.point === name && fault.consumed_at &&
        jobs.some(job => job.id === fault.job_id))), "one-use fault consumption is missing.");
    const target = faults.find(fault => fault.point === point).job_id;
    const seen = observations.filter(row => row.job_id === target);
    const has = (stage, status) => seen.some(row => row.stage === stage && row.status === status);
    if (point === "invoke-ack" || point === "invoke-duplicate")
        check(has("invoke", 202), "actual AWS acceptance was not observed.");
    if (point === "invoke-duplicate") {
        check(has("duplicate-invoke", 202) && has("claim", 201) && has("claim", 204), "real duplicate delivery and losing execution were not observed.");
        const winner = jobs.find(job => job.id === target).execution_id;
        check(seen.some(row => row.stage === "claim" && row.status === 204 && row.execution_id && row.execution_id !== winner), "duplicate must have a distinct losing execution identity.");
    }
    if (point === "claim-ack") {
        const claims = seen.filter(row => row.stage === "claim" && row.status === 201);
        check(claims.length >= 2 && claims.every(row => row.execution_id === jobs.find(job => job.id === target).execution_id), "lost claim acknowledgement did not retry the same execution.");
    }
    if (point === "upload-ack")
        check(has("upload-committed", 200), "upload was not committed before its acknowledgement was replaced.");
    check(points.includes(point) && ["invoke-ack", "invoke-duplicate", "claim-ack", "upload-ack", "enqueue-send"].includes(point), "unknown fault.");
    return true;
}
export async function qualifyDevelopmentFaults(env = process.env) {
    const context = await prepareQualification(env);
    const { cf, query, prepared, store, api, releaseId } = context;
    const schema = await readFile(new URL("../workers/api/sql/native-qualification.sql", import.meta.url), "utf8");
    for (const statement of schema.split(";").map(part => part.trim()).filter(Boolean))
        await cf.query(statement);
    const reports = [];
    // Serial families bound cost and keep duplicate-delivery evidence separate
    // from the simultaneous-family load test. All encodes run in real Lambda.
    for (const point of ["invoke-ack", "invoke-duplicate", "claim-ack", "upload-ack", "enqueue-send"]) {
        const fixture = await createFixture(context, point);
        const startedAt = Date.now();
        for (const name of point === "enqueue-send" ? [point, "direct-dispatch"] : [point]) {
            await cf.query(`INSERT INTO native_video_qualification_faults
        (design_id, release_id, run_id, point, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, [fixture.designId, releaseId, env.GITHUB_RUN_ID, name, startedAt, startedAt + 600000]);
        }
        const products = await confirmFamily(api, fixture);
        const confirmationMs = Date.now() - startedAt;
        const path = `/v2/internal/configured-products/${products[0].id}/story-video-events`;
        const timing = await observeReconnectingFamily(() => api(path, fixture.ownerId), products.map(product => product.id), startedAt);
        const loadJobs = () => query(`SELECT jobs.id, jobs.product_id, jobs.colour, jobs.status, jobs.attempt_count, jobs.execution_id, jobs.output_byte_size
      FROM story_video_jobs jobs JOIN products ON products.id = jobs.product_id WHERE products.design_id = ? ORDER BY jobs.id`, [fixture.designId]);
        const jobs = await loadJobs();
        // Allow late duplicate/failure callbacks to arrive after readiness. This
        // must never requeue a completed upload whose acknowledgement was lost.
        await setTimeout(20000);
        const after = await loadJobs();
        const faults = await query("SELECT * FROM native_video_qualification_faults WHERE design_id = ? ORDER BY point", [fixture.designId]);
        const observations = await query("SELECT * FROM native_video_qualification_observations WHERE design_id = ? ORDER BY observed_at", [fixture.designId]);
        const evidence = { releaseId, point, fixture, jobs, after, faults, observations, confirmationMs, ...timing };
        await store.save(`qualification-fault-${point}.json`, Buffer.from(JSON.stringify(evidence)));
        verifyFaultEvidence(point, after, faults, observations);
        check(isDeepStrictEqual(jobs, after), "late callback changed completed jobs.");
        reports.push({ point, confirmationMs, firstPushMs: timing.firstPushMs, allPushMs: timing.allPushMs, videos: 4, attemptsPerVideo: 1 });
        console.info(JSON.stringify({ cloudFaultPassed: point, ...reports.at(-1) }));
    }
    const report = { cloudFaultQualification: true, releaseId, sourceCommit: prepared.sourceCommit, imageDigest: prepared.candidate.imageDigest, reports,
        method: "real AWS invocations and encodes; one-use Development Worker boundary injection",
        notTested: ["actual AWS throttling", "process termination", "real mobile playback"] };
    const evidence = await store.save("qualification-faults-summary.json", Buffer.from(JSON.stringify(report)));
    return { ...report, evidence };
}
export function verifyTerminationEvidence(jobs, fault, observations, leaseObserved) {
    check(fault?.point === "terminate" && fault.consumed_at && fault.job_id && leaseObserved, "one-use termination and the live fenced lease must be observed.");
    const killed = observations.find(row => row.job_id === fault.job_id && row.stage === "termination-issued" && row.status === 200);
    check(killed?.execution_id && jobs.length === 4 && new Set(jobs.map(job => `${job.product_id}:${job.colour}`)).size === 4 &&
        jobs.every(job => job.status === "ready" && job.output_byte_size > 0 && job.execution_id &&
            job.attempt_count === (job.id === fault.job_id ? 2 : 1)) &&
        jobs.some(job => job.id === fault.job_id && job.execution_id !== killed.execution_id), "termination must recover exactly one new execution without restarting ready siblings.");
    return true;
}
export async function qualifyDevelopmentTermination(env = process.env) {
    const context = await prepareQualification(env);
    const { cf, query, prepared, store, api, releaseId } = context;
    const schema = await readFile(new URL("../workers/api/sql/native-qualification.sql", import.meta.url), "utf8");
    for (const statement of schema.split(";").map(part => part.trim()).filter(Boolean))
        await cf.query(statement);
    const fixture = await createFixture(context, "termination"), startedAt = Date.now();
    await cf.query(`INSERT INTO native_video_qualification_faults
    (design_id, release_id, run_id, point, created_at, expires_at) VALUES (?, ?, ?, 'terminate', ?, ?)`, [fixture.designId, releaseId, env.GITHUB_RUN_ID, startedAt, startedAt + 600000]);
    const products = await confirmFamily(api, fixture);
    let leaseObserved = false, jobs, fault;
    const samples = [];
    for (;;) {
        jobs = await query(`SELECT jobs.id, jobs.product_id, jobs.colour, jobs.status, jobs.attempt_count, jobs.execution_id,
      jobs.output_byte_size, jobs.updated_at FROM story_video_jobs jobs JOIN products ON products.id = jobs.product_id
      WHERE products.design_id = ? ORDER BY jobs.id`, [fixture.designId]);
        fault = (await query("SELECT * FROM native_video_qualification_faults WHERE design_id = ? AND point = 'terminate'", [fixture.designId]))[0];
        const elapsedMs = Date.now() - startedAt;
        const killed = jobs.find(job => job.id === fault?.job_id);
        if (elapsedMs >= 180000 && killed?.status === "rendering" && killed.attempt_count === 1 && killed.execution_id && !killed.output_byte_size)
            leaseObserved = true;
        samples.push({ elapsedMs, jobs });
        if (jobs.length === 4 && jobs.every(job => job.status === "ready"))
            break;
        check(elapsedMs < 420000 && jobs.every(job => job.attempt_count <= 2), "terminated fixture did not recover within seven minutes.");
        await setTimeout(10000);
    }
    const observations = await query("SELECT * FROM native_video_qualification_observations WHERE design_id = ? ORDER BY observed_at", [fixture.designId]);
    await store.save("qualification-termination-evidence.json", Buffer.from(JSON.stringify({ releaseId, fixture, jobs, fault, observations, samples })));
    verifyTerminationEvidence(jobs, fault, observations, leaseObserved);
    const timing = await observeFamilyStream(await api(`/v2/internal/configured-products/${products[0].id}/story-video-events`, fixture.ownerId), products.map(product => product.id), startedAt);
    const report = { cloudTerminationQualification: true, releaseId, sourceCommit: prepared.sourceCommit, imageDigest: prepared.candidate.imageDigest,
        settledMs: Date.now() - startedAt, leaseObserved, videos: 4, recoveredAttempt: 2, unchangedSiblingAttempts: 1, ...timing };
    const evidence = await store.save("qualification-termination-summary.json", Buffer.from(JSON.stringify(report)));
    return { ...report, evidence };
}
export function capacityMetricEvidence(throttles, concurrency, admission) {
    check(Array.isArray(throttles.Datapoints) && Array.isArray(concurrency.Datapoints), "CloudWatch metric response.");
    const sums = throttles.Datapoints.map(point => point.Sum), maxima = concurrency.Datapoints.map(point => point.Maximum);
    check(sums.every(value => Number.isFinite(value) && value >= 0) && maxima.every(value => Number.isFinite(value) && value >= 0 && value <= 8), "invalid metrics or the reviewed concurrency cap was exceeded.");
    const throttled = sums.reduce((sum, value) => sum + value, 0), peak = maxima.length ? Math.max(...maxima) : null;
    const admitted = admission?.version === 1 && admission.limit === 8 &&
        Number.isInteger(admission.running) && admission.running > 0 && admission.running <= 8 &&
        Number.isInteger(admission.waiting) && admission.waiting > 0 && admission.waitingAttempts === 0;
    return { throttled, peak, qualified: admission
            ? admitted && peak !== null && peak > 0 && peak <= 8 && throttled === 0
            : throttled > 0 && peak === 8 };
}
export async function qualifyDevelopmentLoad(env = process.env) {
    const call = await createDevelopmentCICall(env);
    const startedAt = Date.now(), start = new Date(Math.floor(startedAt / 60000) * 60000).toISOString();
    const cohort = await qualifyDevelopmentFamilies(env, 3);
    const metrics = {};
    let evidence;
    for (;;) {
        for (const [name, statistic] of [["Throttles", "Sum"], ["ConcurrentExecutions", "Maximum"]]) {
            metrics[name] = await call(["cloudwatch", "get-metric-statistics", "--namespace", "AWS/Lambda", "--metric-name", name,
                "--dimensions", "Name=FunctionName,Value=forever-tee-video-development", "--start-time", start,
                "--end-time", new Date().toISOString(), "--period", "60", "--statistics", statistic]);
        }
        evidence = capacityMetricEvidence(metrics.Throttles, metrics.ConcurrentExecutions, cohort.admission);
        if (evidence.qualified || Date.now() - startedAt > 300000)
            break;
        await setTimeout(15000);
    }
    const store = await createDevelopmentReleaseStore(env);
    await store.save("qualification-load-metrics.json", Buffer.from(JSON.stringify({ startedAt, metrics, evidence })));
    console.info(JSON.stringify({ qualificationCapacitySample: evidence }));
    check(evidence.qualified, "cloud cohort did not establish queued admission within eight executions without AWS throttling.");
    const report = { ...cohort, cloudCapacityQualification: true, capacity: evidence,
        tested: [...cohort.tested, "durable admission at reserved concurrency eight without AWS throttling"], notTested: cohort.notTested };
    const reference = await store.save("qualification-load-summary.json", Buffer.from(JSON.stringify(report)));
    return { ...report, evidence: reference };
}
export function completeQualificationSummary(stages, releaseId) {
    const names = ["families", "exhaustion", "faults", "termination", "load"];
    check(/^native-\d+$/.test(releaseId ?? "") && stages.length === names.length &&
        stages.every((stage, index) => stage.name === names[index] && stage.releaseId === releaseId &&
            /^[a-f0-9]{40}$/.test(stage.sourceCommit ?? "") && /^sha256:[a-f0-9]{64}$/.test(stage.imageDigest ?? "") &&
            stage.sourceCommit === stages[0].sourceCommit && stage.imageDigest === stages[0].imageDigest &&
            /^source\/releases\/native-\d+\/qualification-[a-z0-9-]+\.json$/.test(stage.evidence?.key ?? "") &&
            typeof stage.evidence?.version === "string" && stage.evidence.version.length > 0 && stage.evidence.version !== "null" &&
            /^[a-f0-9]{64}$/.test(stage.evidence?.sha256 ?? "")) && new Set(stages.map(stage => stage.evidence.key)).size === names.length, "complete ordered qualification evidence for one pair is required.");
    return { cloudQualificationComplete: true, releaseId, sourceCommit: stages[0].sourceCommit,
        imageDigest: stages[0].imageDigest, stages, realMobilePlaybackVerified: false, productionPromotionPerformed: false };
}
export async function qualifyDevelopmentRelease(env = process.env) {
    const contextStore = await createDevelopmentReleaseStore(env), contextCf = developmentCloudflare(env);
    const before = await qualificationIdentity(contextCf, contextStore, env);
    const rendererEvidence = await captureRendererEvidence(env, contextCf, contextStore, before);
    const shipping = env.GITHUB_REF === "refs/heads/main" ? await measureReleaseStage("shipping-qualification", () => qualifyShippingDatabase(env, contextStore, { pair: before, paidJourney: true })) : null;
    const stages = [];
    for (const [name, run] of [["families", qualifyDevelopmentFamilies], ["exhaustion", qualifyDevelopmentExhaustion],
        ["faults", qualifyDevelopmentFaults], ["termination", qualifyDevelopmentTermination], ["load", qualifyDevelopmentLoad]]) {
        const report = await measureReleaseStage(`qualification-${name}`, () => run(env));
        check(report.releaseId === env.NATIVE_VERIFY_RELEASE && report.evidence?.version && report.evidence.sha256, "stage did not preserve its immutable evidence.");
        if (stages.length)
            check(report.imageDigest === stages[0].imageDigest && report.sourceCommit === stages[0].sourceCommit, "qualification stages did not run against the same deployed pair.");
        stages.push({ name, releaseId: report.releaseId, sourceCommit: report.sourceCommit, imageDigest: report.imageDigest, evidence: report.evidence });
        console.info(JSON.stringify({ qualificationStage: name, ...report }));
    }
    const store = await createDevelopmentReleaseStore(env);
    const identity = await qualificationIdentity(developmentCloudflare(env), store, env);
    const inventory = await captureQualificationInventory(developmentCloudflare(env), env);
    const inventoryReference = await store.save("qualification-cleanup-inventory.json", Buffer.from(JSON.stringify(inventory)));
    const rendererArchive = await captureRendererArchive(env, store, identity);
    const report = { ...completeQualificationSummary(stages, env.NATIVE_VERIFY_RELEASE),
        schemaVersion: 2, identity, inventoryReference, rendererEvidence, rendererArchive, baselineSelectionEligible: env.NATIVE_SCHEDULED_QUALIFICATION !== "true", shippingEvidence: shipping?.evidence ?? null };
    check(isDeepStrictEqual(before, identity), "qualification identity changed during the functional suite.");
    check(report.sourceCommit === identity.sourceCommit && report.imageDigest === identity.imageDigest, "final qualification identity changed.");
    const evidence = await store.save("qualification-complete-summary.json", Buffer.from(JSON.stringify(report)));
    return { ...report, evidence };
}
export async function qualifyDevelopmentComponents(env = process.env) {
    const cf = developmentCloudflare(env), store = await createDevelopmentReleaseStore(env);
    const before = await qualificationIdentity(cf, store, env);
    let renderer;
    try {
        renderer = await verifyReusableRenderer({ value: env.NATIVE_RENDERER_REFERENCE, env, cf, store, identity: before });
    }
    catch {
        console.info("Renderer input or runtime equivalence was not established; selecting full qualification.");
        return qualifyDevelopmentRelease(env);
    }
    const commerce = renderer.boundary === commerceBoundary;
    const shipping = await measureReleaseStage("shipping-qualification", () => qualifyShippingDatabase(env, store, { pair: before, paidJourney: commerce }));
    const smoke = await measureReleaseStage("video-smoke", () => qualifyDevelopmentFamilies(env));
    const identity = await qualificationIdentity(cf, store, env);
    check(isDeepStrictEqual(before, identity), "shipping qualification pair changed.");
    const inventory = await captureQualificationInventory(cf, env);
    const inventoryReference = await store.save("qualification-cleanup-inventory.json", Buffer.from(JSON.stringify(inventory)));
    const report = { schemaVersion: commerce ? 4 : 3, qualificationKind: commerce ? "commerce" : "shipping", cloudQualificationComplete: true,
        releaseId: identity.releaseId, sourceCommit: identity.sourceCommit, imageDigest: identity.imageDigest, identity,
        shippingEvidence: shipping.evidence, smokeEvidence: smoke.evidence, rendererQualification: renderer, inventoryReference,
        realMobilePlaybackVerified: false, productionPromotionPerformed: false };
    const evidence = await store.save("qualification-complete-summary.json", Buffer.from(JSON.stringify(report)));
    return { ...report, evidence };
}
