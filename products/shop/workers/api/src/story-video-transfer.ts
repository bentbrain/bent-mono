import { isStoryVideoJobId, verifyStoryVideoGrant } from "./story-video-grants";
import { storedLambdaVideo, type LambdaStoryVideoEnv } from "./story-video-lambda";
import { notifyStoryVideoReady, type StoryVideoNotificationEnv } from "./story-video-notifications";
import { observeQualification, takeQualificationFault } from "./story-video-qualification";
interface TransferEnv extends LambdaStoryVideoEnv, StoryVideoNotificationEnv {
    readonly DB: D1Database;
    readonly DESIGN_ARTWORK: R2Bucket;
    readonly STORY_VIDEO_JOBS?: {
        send(message: {
            designRevisionId: string;
        }, options?: {
            delaySeconds: number;
        }): Promise<unknown>;
    };
}
interface TransferJob {
    readonly recursive_key: string | null;
    readonly recursive_sha256: string | null;
    readonly recursive_size: number | null;
    readonly recursive_placement_x: number | null;
    readonly recursive_placement_y: number | null;
    readonly recursive_placement_width: number | null;
    readonly id: string;
    readonly story_key: string;
    readonly renderer_version: string;
    readonly artwork_key: string;
    readonly sha256: string;
    readonly byte_size: number;
    readonly design_revision_id: string;
    readonly product_id: string;
    readonly colour: string;
    readonly updated_at: number;
    readonly status: string;
    readonly execution_id: string | null;
}
async function boundedBody(request: Request, size: number) {
    if (!request.body)
        throw new Error("Missing video bytes.");
    const reader = request.body.getReader();
    const bytes = new Uint8Array(size);
    let offset = 0;
    try {
        for (let item = await reader.read(); !item.done; item = await reader.read()) {
            if (offset + item.value.byteLength > size)
                throw new Error("Video exceeds declared length.");
            bytes.set(item.value, offset);
            offset += item.value.byteLength;
        }
        if (offset !== size)
            throw new Error("Video is truncated.");
        return bytes;
    }
    finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
export async function handleStoryVideoTransfer(request: Request, env: TransferEnv): Promise<Response | undefined> {
    const match = /^\/v2\/internal\/story-video-jobs\/([^/]+)\/(claim|artwork|recursive-artwork|video|failure)$/.exec(new URL(request.url).pathname);
    if (!match || !isStoryVideoJobId(match[1]))
        return;
    const jobId = match[1];
    if (!jobId || !env.STORY_VIDEO_GRANT_SECRET || !env.STORY_VIDEOS)
        return new Response(null, { status: 503 });
    const isFailure = match[2] === "failure";
    const isClaim = match[2] === "claim";
    const executionId = request.headers.get("x-video-execution-id");
    if (executionId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(executionId)) {
        return new Response(null, { status: 400 });
    }
    const grant = await verifyStoryVideoGrant(env.STORY_VIDEO_GRANT_SECRET, request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "", jobId, Date.now(), isFailure ? 15 * 60000 : 0);
    if (!grant)
        return new Response(null, { status: 403 });
    // The attempt counter is a fencing token. Expired or superseded workers cannot
    // read portrait data or publish an output for another attempt/product.
    const job = await env.DB.prepare(`
    SELECT jobs.id, jobs.story_key, jobs.renderer_version, jobs.design_revision_id, jobs.product_id, jobs.colour, jobs.updated_at, jobs.status, jobs.execution_id,
      revisions.artwork_key, revisions.sha256, revisions.byte_size,
      recursive.artwork_key AS recursive_key, recursive.sha256 AS recursive_sha256, recursive.byte_size AS recursive_size,
      recursive.video_placement_x AS recursive_placement_x, recursive.video_placement_y AS recursive_placement_y,
      recursive.video_placement_width AS recursive_placement_width
    FROM story_video_jobs AS jobs
    JOIN products ON products.id = jobs.product_id AND COALESCE(products.video_design_revision_id, products.design_revision_id) = jobs.design_revision_id AND products.status = 'active'
    JOIN design_revisions AS revisions ON revisions.id = jobs.design_revision_id AND revisions.design_id = products.design_id
    LEFT JOIN design_revisions recursive ON recursive.id = products.video_recursive_revision_id AND recursive.design_id = products.design_id
    WHERE jobs.id = ? AND jobs.attempt_count = ? AND (jobs.status = 'rendering' OR (jobs.status = 'ready' AND ? = 'video')
      OR (jobs.status = 'failed' AND jobs.last_error = 'LAMBDA_DELIVERY_FAILED' AND ? = 'failure'))
  `).bind(jobId, grant.attempt, match[2], match[2]).first<TransferJob>();
    if (!job)
        return new Response(null, { status: isFailure || isClaim ? 204 : 409 });
    if (isClaim) {
        if (request.method !== "POST")
            return new Response(null, { status: 405 });
        if (!executionId)
            return new Response(null, { status: 400 });
        // A separate random identity per handler invocation, not the event or AWS
        // request ID. A repeated event can never share the winner's execution.
        const claim = await env.DB.prepare(`UPDATE story_video_jobs SET execution_id = ?
      WHERE id = ? AND status = 'rendering' AND attempt_count = ?
        AND (execution_id IS NULL OR execution_id = ?)`)
            .bind(executionId, job.id, grant.attempt, executionId).run();
        const loseAck = claim.meta.changes === 1 && await takeQualificationFault(env, job.artwork_key, job.id, "claim-ack");
        await observeQualification(env, job.artwork_key, job.id, "claim", claim.meta.changes === 1 ? 201 : 204, executionId);
        if (loseAck)
            return new Response(null, { status: 503 });
        return new Response(null, { status: claim.meta.changes === 1 ? 201 : 204 });
    }
    if (isFailure) {
        if (request.method !== "POST")
            return new Response(null, { status: 405 });
        const result = await env.DB.prepare(`UPDATE story_video_jobs SET status = 'failed', last_error = 'LAMBDA_DELIVERY_FAILED', updated_at = ?
      WHERE id = ? AND status = 'rendering' AND attempt_count = ?
        AND (execution_id = ? OR (execution_id IS NULL AND ? IS NULL))`)
            .bind(Date.now(), job.id, grant.attempt, executionId, executionId).run();
        // Destination delivery has no execution identity. It may fail an unclaimed
        // event, but cannot poison a claimed execution from another delivery.
        const ownsFailure = job.execution_id === executionId;
        if ((result.meta.changes === 1 || (job.status === "failed" && ownsFailure)) && grant.attempt < 3) {
            if (!env.STORY_VIDEO_JOBS)
                return new Response(null, { status: 503 });
            await env.STORY_VIDEO_JOBS.send({ designRevisionId: job.design_revision_id }, { delaySeconds: grant.attempt * 5 });
        }
        await notifyStoryVideoReady(env, job.design_revision_id);
        return new Response(null, { status: 204 });
    }
    if (!executionId || job.execution_id !== executionId)
        return new Response(null, { status: 409 });
    if (match[2] === "artwork" || match[2] === "recursive-artwork") {
        if (request.method !== "GET")
            return new Response(null, { status: 405 });
        const key = match[2] === "artwork" ? job.artwork_key : job.recursive_key;
        const byteSize = match[2] === "artwork" ? job.byte_size : job.recursive_size;
        if (!key || byteSize === null)
            return new Response(null, { status: 404 });
        const object = await env.DESIGN_ARTWORK.get(key);
        if (object?.size !== byteSize)
            return new Response(null, { status: 404 });
        const headers = new Headers({ "content-type": "image/png", "content-length": String(object.size), "cache-control": "no-store" });
        if (match[2] === "artwork" && await takeQualificationFault(env, job.artwork_key, job.id, "terminate")) {
            await observeQualification(env, job.artwork_key, job.id, "termination-issued", 200, executionId);
            headers.set("x-native-qualification-terminate", job.id);
        }
        return new Response(object.body, { headers });
    }
    if (request.method !== "PUT")
        return new Response(null, { status: 405 });
    const size = Number(request.headers.get("content-length"));
    const sha256 = request.headers.get("x-video-sha256");
    if (!Number.isSafeInteger(size) || size < 1 || size > 32000000 || !sha256 || !/^[0-9a-f]{64}$/.test(sha256) ||
        request.headers.get("content-type") !== "video/mp4")
        return new Response(null, { status: 400 });
    const placement = job.recursive_placement_x !== null && job.recursive_placement_y !== null && job.recursive_placement_width !== null
        ? { placementX: job.recursive_placement_x, placementY: job.recursive_placement_y, placementWidth: job.recursive_placement_width } : undefined;
    const identity = { jobId, storyKey: job.story_key, artwork: { sha256: job.sha256, size: job.byte_size },
        ...(job.recursive_sha256 && job.recursive_size ? { recursiveSource: { sha256: job.recursive_sha256, ...(placement ? { placement } : {}) } } : {}) };
    try {
        const existing = await storedLambdaVideo(env.STORY_VIDEOS, identity, job.renderer_version);
        if (existing) {
            if (job.status !== "ready")
                await publishReady(env, job, grant.attempt, existing.size);
            return Response.json(existing, { headers: { "cache-control": "no-store" } });
        }
        const bytes = await boundedBody(request, size);
        const object = await env.STORY_VIDEOS.put(job.story_key, bytes, {
            onlyIf: { etagDoesNotMatch: "*" }, sha256,
            httpMetadata: { contentType: "video/mp4" },
            customMetadata: { jobId, sourceSha256: job.sha256, rendererVersion: job.renderer_version, sha256,
                ...(job.recursive_sha256 ? { recursiveSourceSha256: job.recursive_sha256, compositionVersion: placement ? "two-source-v2" : "two-source-v1" } : {}) },
        });
        if (!object)
            return new Response(null, { status: 409 });
        await publishReady(env, job, grant.attempt, object.size);
        if (await takeQualificationFault(env, job.artwork_key, job.id, "upload-ack")) {
            await observeQualification(env, job.artwork_key, job.id, "upload-committed", 200, executionId);
            return new Response(null, { status: 503 });
        }
        return Response.json({ key: job.story_key, size: object.size, sha256 }, { headers: { "cache-control": "no-store" } });
    }
    catch {
        return new Response(null, { status: 422 });
    }
}
async function publishReady(env: TransferEnv, job: TransferJob, attempt: number, size: number) {
    const now = Date.now();
    const result = await env.DB.prepare(`UPDATE story_video_jobs SET status = 'ready', output_byte_size = ?,
    last_error = NULL, updated_at = ?, rendered_at = ? WHERE id = ? AND status = 'rendering' AND attempt_count = ?`)
        .bind(size, now, now, job.id, attempt).run();
    if (result.meta.changes !== 1)
        throw new Error("Render attempt was superseded.");
    await notifyStoryVideoReady(env, job.design_revision_id);
    console.info("Story video ready", { provider: "lambda", productId: job.product_id, colour: job.colour,
        timings: { readyAt: now, claimedAt: job.updated_at, claimToReadyMs: now - job.updated_at } });
}
