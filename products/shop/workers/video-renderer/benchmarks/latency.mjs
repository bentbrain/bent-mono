import { protectedConfig } from "../../../scripts/protected-config.mjs";
import { writeFile } from "node:fs/promises";
import { captureQueueTrace } from "./trace.mjs";
import { allContainersStopped } from "./idle-state.mjs";
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const serviceSecret = process.env.FOREVER_TEE_API_SHARED_SECRET;
const api = process.env.WORKER_URL;
const storefront = process.env.WEB_ORIGIN;
if (!account || !token || !serviceSecret || !api || !storefront)
    throw new Error("Benchmark credentials and storefront origin are required.");
const production = process.env.STORY_BENCHMARK_ENV === "production";
const familyOnly = process.env.STORY_LATENCY_FAMILY_ONLY === "1";
const profile = process.env.STORY_LATENCY_PROFILE === "1";
const cold = production || process.env.STORY_LATENCY_COLD === "1";
const sourceRevision = process.env.STORY_LATENCY_SOURCE_REVISION ?? "";
const configuration = process.env.STORY_LATENCY_CONFIGURATION ?? "sequential";
const lanes = Number(process.env.STORY_LATENCY_LANES ?? "2");
const notificationMode = process.env.STORY_LATENCY_NOTIFICATIONS ?? "poll";
if (!["sequential", "family"].includes(configuration) || ![2, 4].includes(lanes) || !["poll", "push"].includes(notificationMode)) {
    throw new Error("Unsupported pipeline experiment.");
}
if (production && (configuration !== "sequential" || lanes !== 2 || notificationMode !== "poll")) {
    throw new Error("Experimental pipeline options are development-only.");
}
if (sourceRevision && !/^[0-9a-f-]{36}$/.test(sourceRevision))
    throw new Error("Invalid source revision");
const storefrontHeaders = {};
if (!production) {
    const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID } = process.env;
    if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID || !VERCEL_ORG_ID)
        throw new Error("Preview authentication is required.");
    const response = await fetch(`https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}?teamId=${VERCEL_ORG_ID}`, {
        headers: { authorization: `Bearer ${VERCEL_TOKEN}` },
    });
    if (!response.ok)
        throw new Error(`Preview configuration unavailable: ${response.status}`);
    const project = await response.json();
    // Reuse existing automation access. Never disable protection or create a
    // bypass secret, and never include the secret in logs or timing artifacts.
    const bypass = Object.entries(project.protectionBypass ?? {}).find(([, value]) => value.scope === "automation-bypass");
    if (!bypass)
        throw new Error("An existing Preview automation bypass is required.");
    storefrontHeaders["x-vercel-protection-bypass"] = bypass[0];
}
const database = production ? protectedConfig("resource_1a1378f0d1dc") : protectedConfig("resource_fb377032d2f5");
const script = "forever-tee-story-video-development";
const cf = `https://api.cloudflare.com/client/v4/accounts/${account}`;
async function cloudflare(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(`${cf}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok || !result.success)
        throw new Error(`Cloudflare request failed: ${response.status} ${JSON.stringify(result.errors)}`);
    return result.result;
}
const queues = await cloudflare("/queues");
const pipelineQueue = queues.find((queue) => queue.queue_name === `forever-tee-story-video-${production ? "production" : "development"}`);
const queueConsumer = pipelineQueue?.consumers?.find((consumer) => consumer.type === "worker");
if (!queueConsumer)
    throw new Error("The deployed video queue consumer is unavailable.");
const queueSettings = {
    batchSize: queueConsumer.settings?.batch_size,
    maxWaitMs: queueConsumer.settings?.max_wait_time_ms,
    maxConcurrency: queueConsumer.settings?.max_concurrency,
    deliveryDelay: pipelineQueue.settings?.delivery_delay,
};
const query = await cloudflare(`/d1/database/${database}/query`, {
    sql: `SELECT p.id, p.base_product_id, p.design_revision_id, p.placement_x, p.placement_y,
    p.placement_width, p.placement_depth, r.crop_x, r.crop_y, r.crop_zoom
    FROM products p JOIN design_revisions r ON r.id = p.design_revision_id
    WHERE p.status = 'active' AND p.placement_width IS NOT NULL
    AND p.design_revision_id = (SELECT design_revision_id FROM products WHERE status = 'active'
      AND placement_width IS NOT NULL AND (? = '' OR design_revision_id = ?) GROUP BY design_revision_id
      HAVING count(DISTINCT base_product_id) = 2 ORDER BY max(created_at) DESC LIMIT 1)
    ORDER BY p.base_product_id LIMIT 2`,
    params: [sourceRevision, sourceRevision],
});
const products = query[0].results;
if (products.length !== 2)
    throw new Error("A saved two-product development design is required.");
const source = products[0];
const probe = await fetch(`${storefront}/api/configured-product-video/${source.id}/events`, {
    headers: storefrontHeaders, redirect: "manual", signal: AbortSignal.timeout(20000),
});
await probe.body?.cancel();
if (!probe.ok || !probe.headers.get("content-type")?.startsWith("text/event-stream")) {
    throw new Error(`Storefront stream preflight failed: ${probe.status} ${probe.headers.get("content-type")}`);
}
const artworkResponse = await fetch(`${api}/v2/internal/design-revisions/${source.design_revision_id}/artwork`, {
    headers: { "x-forever-tee-service-secret": serviceSecret },
});
if (!artworkResponse.ok)
    throw new Error(`Saved artwork unavailable: ${artworkResponse.status}`);
const artworkBytes = Buffer.from(await artworkResponse.arrayBuffer());
const artwork = `data:${artworkResponse.headers.get("content-type")};base64,${artworkBytes.toString("base64")}`;
const shared = { artwork, encoding: { crf: 21, frameRate: 30, frameWidth: 720, scaleBeforeHold: true },
    preset: "veryfast", websiteLabel: "shop.bent.build" };
function jobsForBatch(batchId) {
    return products.flatMap((product) => {
        const tote = product.base_product_id === "97b629d7-1d3b-4d2a-a586-537168141e97";
        return (tote ? ["Black", "Cream"] : ["Black", "White"]).map((color) => ({
            baseProductSlug: tote ? "cotton-tote" : "staple-tee", color,
            storyKey: `benchmarks/latency/${batchId}/${product.id}/${color.toLowerCase()}.mp4`,
            settings: {
                cropX: product.crop_x, cropY: product.crop_y, cropZoom: product.crop_zoom,
                depth: product.placement_depth, placementWidth: product.placement_width,
                placementX: product.placement_x, placementY: product.placement_y,
            },
        }));
    });
}
const reports = [];
let cleanupBenchmark = async () => undefined;
let trace;
let warmupAttempts = 0;
let verifyIdle;
try {
    if (profile)
        trace = await captureQueueTrace(production ? "production" : "development");
    // Production only exercises the real queue. It never exposes a benchmark
    // render endpoint or runs the sixteen-video comparison.
    if (!production) {
        const subdomain = await cloudflare("/workers/subdomain");
        const endpoint = `https://${script}.${subdomain.subdomain}.workers.dev`;
        const benchmarkToken = crypto.randomUUID();
        const secretPath = `/workers/scripts/${script}/secrets`;
        const existingSecrets = await cloudflare(secretPath);
        if (existingSecrets.some((secret) => secret.name === "BENCHMARK_TOKEN")) {
            throw new Error("An existing benchmark token is in use; refusing to replace it.");
        }
        async function stopAndVerify(jobs) {
            const response = await fetch(`${endpoint}/render-batch`, {
                method: "POST",
                headers: { authorization: `Bearer ${benchmarkToken}`, "content-type": "application/json" },
                body: JSON.stringify({ batchId: crypto.randomUUID(), jobs, shared, concurrency: 2, shutdownAfterBatch: true }),
            });
            if (!response.ok)
                throw new Error(`Could not stop benchmark containers: ${response.status} ${(await response.text()).slice(0, 1000)}`);
            await response.json();
            for (let attempt = 0; attempt < 30; attempt += 1) {
                const state = await fetch(`${endpoint}/batch-state`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${benchmarkToken}`, "content-type": "application/json" },
                    body: JSON.stringify({ batchId: crypto.randomUUID() }),
                });
                const body = await state.json();
                if (state.ok && allContainersStopped(body.states, 2))
                    return;
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            throw new Error("Both containers must be stopped before labelling a run cold.");
        }
        // Keep the credential until the family check finishes: deleting a Worker
        // secret is a rollout and must not intervene between warmup and rendering.
        cleanupBenchmark = () => cloudflare(`${secretPath}/BENCHMARK_TOKEN`, undefined, "DELETE");
        await cloudflare(secretPath, { name: "BENCHMARK_TOKEN", text: benchmarkToken, type: "secret_text" }, "PUT");
        verifyIdle = async () => {
            let lastStates;
            for (let attempt = 0; attempt < 46; attempt += 1) {
                const response = await fetch(`${endpoint}/batch-state`, {
                    method: "POST", headers: { authorization: `Bearer ${benchmarkToken}`, "content-type": "application/json" },
                    body: JSON.stringify({ batchId: crypto.randomUUID() }),
                });
                const result = await response.json();
                lastStates = result.states?.map(({ status, running, lastChange, exitCode, alarmAt, sdkInflightRequests, sdkIdleDeadline }) => ({ status, running, lastChange, exitCode, alarmAt, sdkInflightRequests, sdkIdleDeadline }));
                if (response.ok && allContainersStopped(lastStates, lanes)) {
                    return { checkedAt: Date.now(), states: lastStates };
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
            throw new Error(`Container API did not confirm idle shutdown: ${JSON.stringify(lastStates)}`);
        };
        // Secret updates are a Worker rollout. Wait for a read-only authenticated
        // probe before submitting an encode; do not retry a render blindly.
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const probe = await fetch(`${endpoint}/batch-state`, {
                method: "POST", headers: { authorization: `Bearer ${benchmarkToken}`, "content-type": "application/json" },
                body: JSON.stringify({ batchId: crypto.randomUUID() }),
            });
            await probe.arrayBuffer();
            if (probe.ok)
                break;
            if (probe.status !== 401 || attempt === 29)
                throw new Error(`Benchmark auth probe failed: ${probe.status}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        // This unmeasured preflight gives us our own cache keys for subsequent
        // shutdown requests. Never use or overwrite customer media as a control job.
        if (!familyOnly) {
            await stopAndVerify(jobsForBatch(crypto.randomUUID()));
            for (const concurrency of [1, 2]) {
                for (const temperature of ["cold", "warm"]) {
                    const batchId = crypto.randomUUID();
                    const jobs = jobsForBatch(batchId);
                    const start = performance.now();
                    const response = await fetch(`${endpoint}/render-batch`, {
                        method: "POST",
                        headers: { authorization: `Bearer ${benchmarkToken}`, "content-type": "application/json", accept: "application/x-ndjson" },
                        body: JSON.stringify({ batchId, concurrency, jobs, shared, shutdownAfterBatch: false }),
                    });
                    if (!response.ok)
                        throw new Error(`Renderer rejected benchmark: ${response.status}`);
                    const events = [];
                    let pending = "";
                    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
                        pending += chunk;
                        let end;
                        while ((end = pending.indexOf("\n")) >= 0) {
                            const event = JSON.parse(pending.slice(0, end));
                            pending = pending.slice(end + 1);
                            if (event.type === "error")
                                throw new Error(JSON.stringify(event));
                            if (event.type === "ready")
                                events.push({ ...event, observedAfterMs: Math.round(performance.now() - start) });
                        }
                    }
                    if (events.length !== 4 || events.some((event) => event.cache !== "miss"))
                        throw new Error("Expected four fresh videos.");
                    const report = { concurrency, temperature, events, totalMs: Math.round(performance.now() - start) };
                    reports.push(report);
                    await writeFile("/tmp/story-video-latency.json", JSON.stringify({ sourceRevision: source.design_revision_id, reports }, null, 2));
                    console.info(JSON.stringify(report));
                    if (temperature === "warm")
                        await stopAndVerify(jobs);
                }
            }
        }
        // The production flow does this while the customer is in the editor.
        if (!cold) {
            // Changing the temporary credential rolls the Worker and can reset a DO
            // during startup. Retry only this unmeasured, idempotent health preflight;
            // never retry an encode here or hide queue attempts from the report.
            for (;;) {
                warmupAttempts += 1;
                const warm = await fetch(`${endpoint}/warm`, {
                    method: "POST", headers: { authorization: `Bearer ${benchmarkToken}` },
                });
                await warm.arrayBuffer();
                if (warm.ok)
                    break;
                if (warmupAttempts >= 5)
                    throw new Error(`Early warmup failed: ${warm.status}`);
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
        else {
            for (let attempt = 0;; attempt += 1) {
                const state = await fetch(`${endpoint}/batch-state`, {
                    method: "POST", headers: { authorization: `Bearer ${benchmarkToken}`, "content-type": "application/json" },
                    body: JSON.stringify({ batchId: crypto.randomUUID() }),
                });
                const value = await state.json();
                if (state.ok && allContainersStopped(value.states, lanes))
                    break;
                if (attempt >= 45)
                    throw new Error("Cold benchmark requires every configured container stopped");
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
    }
    // Exercise the real configuration -> queue -> R2 -> D1 -> SSE path too.
    // Only a new, uniquely-owned test draft is seeded. Source artwork and
    // existing products are untouched; no background-removal call is charged.
    const owner = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    async function configureRequest(path, body) {
        const response = await fetch(`${api}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forever-tee-service-secret": serviceSecret, "x-forever-tee-owner-id": owner },
            body: JSON.stringify(body),
        });
        const value = await response.json();
        if (!response.ok)
            throw new Error(`Fixture configuration failed: ${response.status} ${JSON.stringify(value)}`);
        return value;
    }
    const draft = await configureRequest("/v2/design-drafts", {});
    if (!/^[0-9a-f-]{36}$/.test(draft.id))
        throw new Error("Invalid fixture draft.");
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", artworkBytes)).toString("hex");
    const artworkKey = `designs/${draft.id}/artwork/${digest}`;
    const bucket = `forever-tee-design-artwork-${production ? "production" : "development"}`;
    const copy = await fetch(`${cf}/r2/buckets/${bucket}/objects/${artworkKey}`, {
        method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": artworkResponse.headers.get("content-type") },
        body: artworkBytes,
    });
    if (!copy.ok)
        throw new Error(`Fixture artwork copy failed: ${copy.status}`);
    await cloudflare(`/d1/database/${database}/query`, {
        sql: `UPDATE designs SET
    (artwork_key, content_type, byte_size, sha256, artwork_width, artwork_height,
      crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth) =
    (SELECT ?, r.content_type, r.byte_size, r.sha256, r.artwork_width, r.artwork_height,
      r.crop_x, r.crop_y, r.crop_zoom, d.placement_x, d.placement_y, d.placement_width, d.depth
      FROM design_revisions r JOIN designs d ON d.id = r.design_id WHERE r.id = ?),
    status = 'ready' WHERE id = ? AND owner_id = ? AND status = 'creating'`,
        params: [artworkKey, source.design_revision_id, draft.id, owner],
    });
    if (production)
        await new Promise((resolve) => setTimeout(resolve, 90000));
    const configured = [];
    const familyStarted = performance.now();
    const familyStartedAt = Date.now();
    if (configuration === "family") {
        const result = await configureRequest("/v2/configured-product-families", {
            baseProductIds: products.map((product) => product.base_product_id), designId: draft.id, expectedVersion: 0,
        });
        if (!Array.isArray(result.products) || result.products.length !== 2)
            throw new Error("Incomplete configured family.");
        configured.push(...result.products);
    }
    else
        for (const product of products) {
            configured.push(await configureRequest("/v2/configured-products", {
                baseProductId: product.base_product_id,
                designId: draft.id,
                expectedVersion: configured.length === 0 ? 0 : 1,
            }));
        }
    const notifications = new Map();
    const observedNotificationModes = new Set();
    const mediaChecks = [];
    let firstSnapshotAfterMs;
    while (notifications.size < 4) {
        if (performance.now() - familyStarted > 150000)
            throw new Error("Fresh family readiness timed out.");
        const events = await fetch(`${storefront}/api/configured-product-video/${configured[0].id}/events`, {
            headers: storefrontHeaders, redirect: "manual", signal: AbortSignal.timeout(60000),
        });
        if (!events.ok || !events.headers.get("content-type")?.startsWith("text/event-stream")) {
            throw new Error(`Family event stream failed: ${events.status}`);
        }
        let pending = "";
        for await (const chunk of events.body.pipeThrough(new TextDecoderStream())) {
            pending += chunk;
            let end;
            while ((end = pending.indexOf("\n\n")) >= 0) {
                const message = pending.slice(0, end);
                pending = pending.slice(end + 2);
                const observedMode = /^: notification-mode=(poll|push)\n/.exec(message)?.[1];
                if (observedMode)
                    observedNotificationModes.add(observedMode);
                if (!message.startsWith("event: video\n"))
                    continue;
                const event = JSON.parse(message.slice(message.indexOf("data: ") + 6));
                firstSnapshotAfterMs ??= Math.round(performance.now() - familyStarted);
                if (event.status === "unavailable")
                    throw new Error("A fixture video exhausted its render attempts.");
                if (event.status !== "ready")
                    continue;
                const key = `${event.productId}:${event.color}`;
                if (notifications.has(key))
                    continue;
                notifications.set(key, { ...event, observedAfterMs: Math.round(performance.now() - familyStarted) });
                mediaChecks.push(fetch(`${storefront}/api/configured-product-video/${event.productId}/${event.color}.mp4`, {
                    method: "HEAD", headers: storefrontHeaders, redirect: "manual",
                }).then((response) => {
                    if (!response.ok || response.headers.get("content-type") !== "video/mp4" || !response.headers.get("etag")) {
                        throw new Error("A ready event did not resolve to a stored MP4.");
                    }
                    return { productId: event.productId, color: event.color, etag: response.headers.get("etag"),
                        size: Number(response.headers.get("content-length")) };
                }));
            }
        }
    }
    const media = await Promise.all(mediaChecks);
    const timings = await cloudflare(`/d1/database/${database}/query`, {
        sql: `SELECT product_id, colour, status, attempt_count, output_byte_size,
    created_at, rendered_at, rendered_at - created_at AS elapsed_ms FROM story_video_jobs
    WHERE product_id IN (?, ?) AND renderer_version = 'story-video-renderer-v7'`,
        params: configured.map((product) => product.id),
    });
    const family = { storefront, configuration, lanes, notificationMode, queueSettings, observedNotificationModes: [...observedNotificationModes], designRevisionId: configured[0].designRevisionId, familyStartedAt, firstSnapshotAfterMs, prewarmed: !cold, warmupAttempts, designId: draft.id, products: configured.map((product) => product.id),
        notifications: [...notifications.values()], jobs: timings[0].results, media };
    // Preserve the measured readiness result even if diagnostic collection fails.
    await writeFile("/tmp/story-video-latency.json", JSON.stringify({ sourceRevision: source.design_revision_id, reports, family }, null, 2));
    if (trace) {
        family.profile = await trace.results(family.products);
        family.failures = trace.failures(family.designRevisionId);
        await writeFile("/tmp/story-video-latency.json", JSON.stringify({ sourceRevision: source.design_revision_id, reports, family }, null, 2));
        if (family.profile.some((item) => item.timings.renderLanes !== lanes ||
            item.timings.notificationPush !== (notificationMode === "push" ? 1 : 0) ||
            notificationMode === "push" && item.timings.notificationDelivered !== 1)) {
            throw new Error("Deployed pipeline flags do not match the requested experiment.");
        }
    }
    if (verifyIdle)
        family.idleProof = await verifyIdle();
    await writeFile("/tmp/story-video-latency.json", JSON.stringify({ sourceRevision: source.design_revision_id, reports, family }, null, 2));
    console.info(JSON.stringify({ family }));
    if (!production && (observedNotificationModes.size !== 1 || !observedNotificationModes.has(notificationMode))) {
        throw new Error("The storefront event stream did not use the requested notification mode.");
    }
    if (family.jobs.some((job) => job.attempt_count !== 1))
        throw new Error("A benchmark video required a retry; exclude this run from first-attempt comparisons.");
}
finally {
    try {
        await cleanupBenchmark();
    }
    finally {
        trace?.stop();
    }
}
