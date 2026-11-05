import { safeErrorDetails } from "@forever-tee/contracts/diagnostics";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseImageRecipe, renderProductDisplay, RENDERER_VERSION, } from "@forever-tee/product-image-renderer";
import { env } from "@/env";
// Cache Components uses the default Node runtime; Sharp cannot run at the edge.
export const preferredRegion = "syd1";
export const maxDuration = 30;
function authorized(request: Request) {
    const provided = request.headers.get("x-forever-tee-service-secret");
    return Boolean(provided &&
        timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(env.FOREVER_TEE_API_SHARED_SECRET).digest()));
}
export function GET(request: Request) {
    return authorized(request)
        ? Response.json({ rendererVersion: RENDERER_VERSION }, { headers: { "cache-control": "no-store" } })
        : new Response(null, { status: 401 });
}
async function bounded(response: Response, maximum: number) {
    if (!response.ok || !response.body)
        throw new Error("Image transfer unavailable.");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
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
    constructor(readonly status: number) { super("Image publication rejected."); }
}
async function publishImage(endpoint: string, init: RequestInit, signal: AbortSignal) {
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
            const ack: unknown = JSON.parse((await bounded(response, 4096)).toString("utf8"));
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
export async function POST(request: Request) {
    if (!authorized(request))
        return new Response(null, { status: 401 });
    const body = await bounded(new Response(request.body), 2048).catch(() => undefined);
    if (!body)
        return new Response(null, { status: 413 });
    let event: unknown;
    try {
        event = JSON.parse(body.toString("utf8"));
    }
    catch {
        return new Response(null, { status: 400 });
    }
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
        return new Response(null, { status: 400 });
    const endpoint = `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/v2/internal/product-image-jobs/${event.jobId}`;
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
            return Response.json({ status: "skipped", jobId: event.jobId });
        // A combined claim can acquire ownership before its source read fails.
        // The failure callback is fenced by this execution ID, including that case.
        claimed = true;
        if (claim.status !== 201)
            throw new Error("Image claim unavailable.");
        const recipeHeader = claim.headers.get("x-image-recipe");
        if (recipeHeader && recipeHeader.length > 4096)
            throw new Error("Image recipe unavailable.");
        // Retain the previous transfer contract during a paired release or rollback.
        const recipe = parseImageRecipe(JSON.parse(recipeHeader ?? (await bounded(claim, 4096)).toString("utf8")));
        stage = "source";
        const sourceResponse = recipeHeader ? claim : await fetch(`${endpoint}/artwork`, {
            headers, signal, redirect: "error", cache: "no-store",
        });
        const source = await bounded(sourceResponse, 25000000);
        const sourceDigest = sourceResponse.headers.get("x-image-source-sha256");
        if (!sourceDigest ||
            createHash("sha256").update(source).digest("hex") !== sourceDigest)
            throw new Error("Artwork checksum mismatch.");
        const loaded = performance.now();
        stage = "render";
        const image = await renderProductDisplay(source, recipe, join(process.cwd(), "public/mockups/lifestyle-v4"));
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
        console.info("Product image Vercel execution complete", {
            jobId: event.jobId,
            sourceBytes: source.length,
            publicationAttempts: publication.attempts,
            view: recipe.view,
            color: recipe.color,
            timings,
        });
        return Response.json({
            jobId: event.jobId,
            executionId,
            key: ack.key,
            sha256: ack.sha256,
            size: ack.size,
            timings,
        }, { headers: { "cache-control": "no-store" } });
    }
    catch (error) {
        console.warn("Product image Vercel execution failed", {
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
        return Response.json({ error: "IMAGE_RENDER_UNAVAILABLE" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
}
