import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseImageRecipe, renderProductDisplay, RENDERER_VERSION } from "./index.mjs";

export async function boundedImageTransfer(response, maximum) {
    if (!response.ok || !response.body)
        throw new Error("Image transfer unavailable.");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
        for (let item = await reader.read(); !item.done; item = await reader.read()) {
            size += item.value.length;
            if (size > maximum)
                throw new Error("Image transfer exceeds limit.");
            chunks.push(item.value);
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}
class PublicationRejected extends Error {
    constructor(status) { super("Image publication rejected."); this.status = status; }
}
async function publishImage(endpoint, init, signal) {
    // The same execution, checksum, key and bytes make this PUT idempotent,
    // including a lost acknowledgement after R2 and D1 have already committed.
    // Keep ownership until the verified acknowledgement; never rerender here.
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(endpoint, { ...init, signal });
            if (!response.ok) {
                await response.body?.cancel();
                if (response.status < 500)
                    throw new PublicationRejected(response.status);
                throw new Error("Image storage temporarily unavailable.");
            }
            const ack = JSON.parse((await boundedImageTransfer(response, 4096)).toString("utf8"));
            return { ack, attempts: attempt };
        }
        catch (error) {
            if (error instanceof PublicationRejected || signal.aborted || attempt === 3)
                throw error;
        }
        // R2 permits one write per second to a key; the previous write may have
        // committed even when its acknowledgement was lost.
        await delay(attempt === 1 ? 1100 : 1500, undefined, { signal });
    }
    throw new Error("Image publication unavailable.");
}

// Keep HTTP input compatibility; the native envelope is validated separately.
export function parseProductImageEvent(event) {
    if (typeof event !== "object" ||
        event === null ||
        !("jobId" in event) ||
        typeof event.jobId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(event.jobId) ||
        !("grant" in event) ||
        typeof event.grant !== "string" ||
        event.grant.length > 1024 ||
        !("rendererVersion" in event) ||
        event.rendererVersion !== RENDERER_VERSION)
        return undefined;
    return { jobId: event.jobId, grant: event.grant, rendererVersion: event.rendererVersion };
}

export async function executeProductImage(event, {
    apiUrl, assetDirectory, render = renderProductDisplay, runtimeLabel = "Vercel",
}) {
    const endpoint = `${apiUrl.replace(/\/$/, "")}/v2/internal/product-image-jobs/${event.jobId}`;
    const executionId = randomUUID(), headers = {
        authorization: `Bearer ${event.grant}`,
        "x-image-execution-id": executionId,
        "x-image-renderer-version": RENDERER_VERSION,
    };
    const signal = AbortSignal.timeout(25000), started = performance.now();
    let claimed = false;
    let stage = "claim";
    try {
        const claim = await fetch(`${endpoint}/claim`, {
            method: "POST",
            headers: { ...headers, accept: "application/vnd.bent.product-image-source" },
            signal,
            redirect: "error",
            cache: "no-store",
        });
        if (claim.status === 204)
            return { status: 200, body: { status: "skipped", jobId: event.jobId } };
        // A combined claim can acquire ownership before its source read fails.
        // The failure callback is fenced by this execution ID, including that case.
        claimed = true;
        if (claim.status !== 201)
            throw new Error("Image claim unavailable.");
        const recipeHeader = claim.headers.get("x-image-recipe");
        if (recipeHeader && recipeHeader.length > 4096)
            throw new Error("Image recipe unavailable.");
        // Retain the previous transfer contract during a paired release or rollback.
        const recipe = parseImageRecipe(JSON.parse(recipeHeader ?? (await boundedImageTransfer(claim, 4096)).toString("utf8")));
        stage = "source";
        const sourceResponse = recipeHeader ? claim : await fetch(`${endpoint}/artwork`, {
            headers, signal, redirect: "error", cache: "no-store",
        });
        const source = await boundedImageTransfer(sourceResponse, 25000000);
        const sourceDigest = sourceResponse.headers.get("x-image-source-sha256");
        if (!sourceDigest ||
            createHash("sha256").update(source).digest("hex") !== sourceDigest)
            throw new Error("Artwork checksum mismatch.");
        const loaded = performance.now();
        stage = "render";
        const image = await render(source, recipe, assetDirectory);
        if (signal.aborted)
            throw new Error("Render deadline exceeded.");
        const rendered = performance.now(), digest = createHash("sha256").update(image).digest("hex");
        stage = "publication";
        const publication = await publishImage(`${endpoint}/image`, {
            method: "PUT",
            headers: {
                ...headers,
                "content-type": "image/webp",
                "content-length": String(image.length),
                "x-image-sha256": digest,
            },
            body: Buffer.from(image),
            redirect: "error",
            cache: "no-store",
        }, signal);
        const { ack } = publication;
        if (typeof ack !== "object" ||
            ack === null ||
            !("key" in ack) ||
            ack.key !== recipe.storageKey ||
            !("sha256" in ack) ||
            ack.sha256 !== digest ||
            !("size" in ack) ||
            ack.size !== image.length)
            throw new Error("Image publication not verified.");
        const timings = {
            assetReadMs: loaded - started,
            renderMs: rendered - loaded,
            uploadMs: performance.now() - rendered,
            totalMs: performance.now() - started,
        };
        console.info(`Product image ${runtimeLabel} execution complete`, {
            jobId: event.jobId,
            sourceBytes: source.length,
            publicationAttempts: publication.attempts,
            view: recipe.view,
            color: recipe.color,
            timings,
        });
        return { status: 200, body: {
            jobId: event.jobId,
            executionId,
            key: ack.key,
            sha256: ack.sha256,
            size: ack.size,
            timings,
        }, headers: { "cache-control": "no-store" } };
    }
    catch (error) {
        console.warn(`Product image ${runtimeLabel} execution failed`, {
            jobId: event.jobId,
            stage,
            ...safeErrorDetails(error),
            status: error instanceof PublicationRejected ? error.status : undefined,
        });
        if (claimed)
            await fetch(`${endpoint}/failure`, {
                method: "POST",
                headers,
                redirect: "error",
                signal: AbortSignal.timeout(2000),
            })
                .then((response) => response.body?.cancel())
                .catch(() => undefined);
        return { status: 503, body: { error: "IMAGE_RENDER_UNAVAILABLE" }, headers: { "cache-control": "no-store" } };
    }
}
