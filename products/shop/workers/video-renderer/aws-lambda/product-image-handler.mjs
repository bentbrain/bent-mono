import { randomUUID } from "node:crypto";
import { assertAppInvocation } from "./app-handler.mjs";
import { appEnvironment } from "./app-environment.mjs";
import { VARIANTS } from "./config.mjs";
import { sha256, validateSettings } from "./contract.mjs";
import { loadLifestyleTemplate } from "../src/lifestyle-template.mjs";
const PRODUCT_IMAGE_VERSION = "product-images-v4";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export function validateProductImageJob(event) {
    const keys = ["kind", "schemaVersion", "jobId", "attempt", "grant", "rendererVersion", "artwork", "baseProductSlug", "color", "view", "printMode", "storageKey", "settings"];
    if (!event || typeof event !== "object" || Array.isArray(event) || Object.keys(event).length !== keys.length ||
        keys.some(key => !Object.hasOwn(event, key)) || event.kind !== "product-image" || event.schemaVersion !== 1 ||
        event.rendererVersion !== PRODUCT_IMAGE_VERSION || !UUID.test(event.jobId) || !Number.isInteger(event.attempt) || event.attempt < 1 || event.attempt > 3 ||
        typeof event.grant !== "string" || event.grant.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(event.grant))
        throw new Error("Invalid product image job.");
    const variant = Object.values(VARIANTS).find(item => item.baseProductSlug === event.baseProductSlug && item.color === event.color);
    const artwork = event.artwork;
    if (!variant || !artwork || Object.keys(artwork).sort().join(",") !== "sha256,size" || !HASH.test(artwork.sha256) ||
        !Number.isSafeInteger(artwork.size) || artwork.size < 1 || artwork.size > 25000000 || !["recursive", "base-image-only"].includes(event.printMode) ||
        !["flat", "lifestyle"].includes(event.view) || (event.view === "lifestyle" && event.baseProductSlug !== "staple-tee") ||
        typeof event.storageKey !== "string" || !/^designs\/[a-f0-9-]{36}\/product-images\/v4\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/(black|white|cream)-(flat|lifestyle)\.webp$/.test(event.storageKey) ||
        !event.storageKey.endsWith(`/${event.color.toLowerCase()}-${event.view}.webp`))
        throw new Error("Invalid product image assets.");
    return { ...event, variant, settings: validateSettings(event.settings) };
}
async function bytes(response, maximum, expected) {
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Image transfer failed (${response.status}).`);
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximum)
            throw new Error("Image transfer too large.");
        chunks.push(Buffer.from(chunk));
    }
    if (expected !== undefined && size !== expected)
        throw new Error("Image transfer truncated.");
    return Buffer.concat(chunks, size);
}
export function createProductImageHandler({ apiOrigin, environment = "development", buildId, readAsset, render, send = fetch }) {
    if (apiOrigin !== appEnvironment(environment).apiOrigin || !HASH.test(buildId))
        throw new Error("Invalid image runtime.");
    return async (event, context) => {
        assertAppInvocation(context, environment);
        const job = validateProductImageJob(event), started = performance.now();
        const endpoint = `${apiOrigin}/v2/internal/product-image-jobs/${job.jobId}`;
        const headers = { authorization: `Bearer ${job.grant}`, "x-image-execution-id": randomUUID() };
        const claimSignal = AbortSignal.timeout(10000);
        // Reuse the execution identity on acknowledgement loss; duplicate deliveries
        // have a new identity and cannot download artwork or publish an image.
        let claimed = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const result = await send(`${endpoint}/claim`, { method: "POST", headers, redirect: "error", signal: claimSignal }).catch(() => undefined);
            await result?.body?.cancel();
            if (result?.status === 204)
                return { jobId: job.jobId, status: "skipped" };
            if (result?.status === 201) {
                claimed = true;
                break;
            }
            if (claimSignal.aborted || (result && result.status < 500 && result.status !== 429))
                break;
        }
        if (!claimed)
            throw new Error("Image claim unavailable.");
        try {
            const source = await bytes(await send(`${endpoint}/artwork`, { headers, redirect: "error", signal: AbortSignal.timeout(20000) }), job.artwork.size, job.artwork.size);
            if (sha256(source) !== job.artwork.sha256)
                throw new Error("Image source checksum mismatch.");
            const assetReadMs = performance.now() - started;
            const mockup = await readAsset(job.view === "flat" ? job.variant.file : `lifestyle-${job.color.toLowerCase()}.png`);
            const templates = job.view === "lifestyle" ? JSON.parse((await readAsset("lifestyle.json")).toString("utf8")) : undefined;
            const template = templates ? await loadLifestyleTemplate(templates, job.color.toLowerCase(), readAsset) : undefined;
            const image = await render({ artwork: source, mockup, template, baseProductSlug: job.baseProductSlug,
                settings: job.settings, printMode: job.printMode, view: job.view });
            if (!Buffer.isBuffer(image) || image.length < 12 || image.length > 2000000)
                throw new Error("Invalid product image output.");
            const digest = sha256(image), uploadAt = performance.now();
            const uploadSignal = AbortSignal.timeout(20000);
            let uploaded;
            for (let attempt = 0; attempt < 3; attempt++) {
                const result = await send(`${endpoint}/image`, { method: "PUT", headers: { ...headers, "content-type": "image/webp",
                        "content-length": String(image.length), "x-image-sha256": digest }, body: image, redirect: "error", signal: uploadSignal }).catch(() => undefined);
                if (result?.ok) {
                    uploaded = result;
                    break;
                }
                await result?.body?.cancel();
                if (uploadSignal.aborted || (result && result.status < 500 && result.status !== 429))
                    break;
            }
            if (!uploaded)
                throw new Error("Image upload unavailable.");
            const ack = JSON.parse((await bytes(uploaded, 4096)).toString("utf8"));
            if (ack.key !== job.storageKey || ack.sha256 !== digest || ack.size !== image.length)
                throw new Error("Image upload not verified.");
            const timings = { assetReadMs, renderMs: uploadAt - started - assetReadMs, uploadMs: performance.now() - uploadAt, totalMs: performance.now() - started };
            console.info("Product image execution complete", { jobId: job.jobId, view: job.view, color: job.color, buildId, timings });
            return { jobId: job.jobId, executionId: headers["x-image-execution-id"], ...ack, timings };
        }
        catch (error) {
            try {
                const response = await send(`${endpoint}/failure`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
                await response.body?.cancel();
            }
            catch { /* The durable lease and queue recover a lost failure callback. */ }
            throw error;
        }
    };
}
