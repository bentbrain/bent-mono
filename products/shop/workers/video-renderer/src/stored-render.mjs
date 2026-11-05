import { createHash } from "node:crypto";
import { artworkReference, videoKey, videoSize } from "./storage-contract.mjs";
export async function renderStoredVideo(input, render, fetcher = fetch) {
    const ref = artworkReference(input.artworkRef);
    const key = videoKey(input.storyKey);
    if (!key)
        throw new Error("Invalid output key.");
    const startedAt = performance.now();
    const artworkUrl = new URL("http://story-storage.internal/artwork");
    artworkUrl.search = new URLSearchParams({ key: ref.key, sha256: ref.sha256, size: String(ref.size) });
    const mockupUrl = new URL("http://story-storage.internal/mockup");
    mockupUrl.search = new URLSearchParams({ product: input.baseProductSlug, color: input.color });
    const [artwork, mockup] = await Promise.all([artworkUrl, mockupUrl].map(async (url) => {
        const response = await fetcher(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok)
            throw new Error(`Render asset unavailable: ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    }));
    if (artwork.length !== ref.size || createHash("sha256").update(artwork).digest("hex") !== ref.sha256) {
        throw new Error("The revision artwork checksum does not match.");
    }
    let recursiveInput = {};
    if (input.recursiveArtworkRef) {
        const nestedRef = artworkReference(input.recursiveArtworkRef);
        if (ref.size + nestedRef.size > 25000000)
            throw new Error("Combined artwork exceeds its size limit.");
        const url = new URL("http://story-storage.internal/artwork");
        url.search = new URLSearchParams({ key: nestedRef.key, sha256: nestedRef.sha256, size: String(nestedRef.size) });
        const response = await fetcher(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok)
            throw new Error(`Recursive source unavailable: ${response.status}`);
        const recursiveArtwork = Buffer.from(await response.arrayBuffer());
        if (recursiveArtwork.length !== nestedRef.size || createHash("sha256").update(recursiveArtwork).digest("hex") !== nestedRef.sha256) {
            throw new Error("Recursive artwork checksum mismatch.");
        }
        recursiveInput = { recursiveArtwork };
    }
    const sourceReadMs = Math.round(performance.now() - startedAt);
    const result = await render({ ...input, artwork, mockup, ...recursiveInput });
    const size = videoSize(result.video.length);
    const storageStartedAt = performance.now();
    const stored = await fetcher("http://story-storage.internal/video", {
        method: "PUT",
        headers: {
            "content-length": String(size), "content-type": "video/mp4",
            "x-story-video-key": key, "x-render-time-ms": String(result.renderTimeMs),
        },
        body: result.video,
        signal: AbortSignal.timeout(30000),
    });
    if (!stored.ok)
        throw new Error(`Video storage failed: ${stored.status}`);
    const object = await stored.json();
    if (object.size !== size || typeof object.etag !== "string" || !object.etag) {
        throw new Error("Video storage acknowledgement is invalid.");
    }
    return {
        size, etag: object.etag, renderTimeMs: result.renderTimeMs,
        timings: {
            sourceReadMs, nodeR2WriteMs: Math.round(performance.now() - storageStartedAt),
            renderMs: result.renderTimeMs, assetDecodeMs: result.assetLoadTimeMs,
            canvasMs: result.canvasTimeMs, encoderPipeMs: result.pipeTimeMs,
            encoderDrainMs: result.encoderDrainTimeMs,
        },
    };
}
