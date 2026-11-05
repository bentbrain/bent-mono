// Old Cloudflare v6 outputs used the same immutable revision/product key, but
// only stored renderTimeMs. Only the dispatcher may adopt that known format.
// Never rewrite it or treat incomplete/mismatched Lambda metadata as legacy.
export function serialLegacyVideoReads() {
    let pending = Promise.resolve();
    return (...args: Parameters<typeof legacyStoredVideo>) => {
        const result = pending.then(() => legacyStoredVideo(...args));
        pending = result.then(() => undefined, () => undefined);
        return result;
    };
}
export async function legacyStoredVideo(bucket: R2Bucket, object: R2Object, rendererVersion: string) {
    const metadata = object.customMetadata;
    if (rendererVersion !== "story-video-renderer-v6" ||
        !/^story-videos\/v6\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(black|white|cream)\.mp4$/.test(object.key) ||
        !metadata || Object.keys(metadata).length !== 1 || !Object.hasOwn(metadata, "renderTimeMs") ||
        !Number.isFinite(Number(metadata["renderTimeMs"])) || Number(metadata["renderTimeMs"]) <= 0 ||
        object.httpMetadata?.contentType !== "video/mp4" || object.size < 32 || object.size > 32000000)
        return;
    const stored = await bucket.get(object.key, { onlyIf: { etagMatches: object.etag } });
    if (!stored || !("body" in stored) || stored.etag !== object.etag || stored.size !== object.size)
        return;
    const bytes = await new Response(stored.body).arrayBuffer();
    if (bytes.byteLength !== object.size || !hasMp4Envelope(bytes))
        return;
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    return { key: object.key, size: bytes.byteLength, sha256 };
}
// Validate bounded, complete top-level ISO BMFF boxes. This is an envelope
// check, not a decoder; provenance comes from the private bucket's old writer
// and the immutable job key. Native outputs still require full job metadata.
function hasMp4Envelope(bytes: ArrayBuffer) {
    const view = new DataView(bytes);
    const boxes = new Set<string>();
    for (let offset = 0; offset < bytes.byteLength;) {
        if (offset + 8 > bytes.byteLength)
            return false;
        const size = view.getUint32(offset);
        if (size < 8 || offset + size > bytes.byteLength)
            return false;
        const type = String.fromCharCode(...new Uint8Array(bytes, offset + 4, 4));
        if (offset === 0 && (type !== "ftyp" || size < 16))
            return false;
        boxes.add(type);
        offset += size;
    }
    return boxes.has("ftyp") && boxes.has("moov") && boxes.has("mdat");
}
