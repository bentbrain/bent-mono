export const STORY_MOCKUPS = {
    "cotton-tote:Black": "/tote-black-print-bar-1001.webp",
    "cotton-tote:Cream": "/tote-cream-print-bar-1001.webp",
    "staple-tee:Black": "/tee-black-cutout-v1.png",
    "staple-tee:White": "/tee-white-cutout-v1.png",
};
export function artworkReference(value) {
    if (!value || typeof value !== "object" ||
        typeof value.key !== "string" ||
        !/^designs\/[0-9a-f-]{36}\/(artwork|original)\/[0-9a-f]{64}$/.test(value.key) ||
        typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) ||
        !value.key.endsWith(`/${value.sha256}`) ||
        !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 25000000) {
        throw new Error("Invalid immutable artwork reference.");
    }
    return { key: value.key, sha256: value.sha256, size: value.size };
}
export function videoKey(value) {
    return typeof value === "string" &&
        /^(story-videos\/v7|benchmarks)\/[a-z0-9][a-z0-9/_-]{1,200}\.mp4$/.test(value)
        ? value : undefined;
}
export function videoSize(value) {
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size <= 0 || size > 64000000) {
        throw new Error("Invalid video content length.");
    }
    return size;
}
