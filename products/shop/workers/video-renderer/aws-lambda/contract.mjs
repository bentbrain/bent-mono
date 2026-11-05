import { createHash } from "node:crypto";
import { DEFAULT_STORY_MOTION } from "../src/geometry.mjs";
import { STORY_RENDERER_VERSION } from "../src/version.mjs";
import { ENCODING, VARIANTS } from "./variants.mjs";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function record(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        keys.some((key) => !Object.hasOwn(value, key)))
        throw new Error(`Invalid ${label}.`);
}
export function validateSettings(value) {
    const ranges = {
        cropX: [0, 1], cropY: [0, 1], cropZoom: [0.65, 2.6],
        placementX: [0, 1], placementY: [0, 1], placementWidth: [0.08, 0.48], depth: [0, 8],
    };
    record(value, Object.keys(ranges), "settings");
    const settings = {};
    for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
        const number = value[key];
        if (!Number.isFinite(number) || number < minimum || number > maximum)
            throw new Error(`Invalid ${key}.`);
        settings[key] = number;
    }
    if (!Number.isInteger(settings.depth) || settings.placementX + settings.placementWidth > 1 ||
        settings.placementY + settings.placementWidth > 1)
        throw new Error("Invalid recursive placement.");
    return settings;
}
export function assetReference(value, kind, variantId) {
    record(value, ["key", "sha256", "size"], `${kind} reference`);
    if (typeof value.sha256 !== "string" || !HASH.test(value.sha256) ||
        !Number.isSafeInteger(value.size) || value.size < 1 || value.size > (kind === "artwork" ? 25000000 : 10000000)) {
        throw new Error(`Invalid ${kind} checksum or size.`);
    }
    const extension = kind === "artwork" ? "png" : VARIANTS[variantId].file.split(".").at(-1);
    const key = kind === "artwork" ? `inputs/artwork/${value.sha256}.png`
        : `inputs/mockups/${variantId}/${value.sha256}.${extension}`;
    if (value.key !== key)
        throw new Error(`Invalid ${kind} object key.`);
    return { key, sha256: value.sha256, size: value.size };
}
export function validateJob(value) {
    record(value, ["schemaVersion", "runId", "customerId", "variantId", "artwork", "mockup", "settings"], "job");
    if (value.schemaVersion !== 1 || typeof value.runId !== "string" || !UUID.test(value.runId) ||
        !["customer-a", "customer-b"].includes(value.customerId) || !Object.hasOwn(VARIANTS, value.variantId)) {
        throw new Error("Invalid benchmark job identity.");
    }
    return {
        schemaVersion: 1, runId: value.runId, customerId: value.customerId, variantId: value.variantId,
        artwork: assetReference(value.artwork, "artwork", value.variantId),
        mockup: assetReference(value.mockup, "mockup", value.variantId), settings: validateSettings(value.settings),
    };
}
export function jobIdentity(job, buildId) {
    if (typeof buildId !== "string" || !HASH.test(buildId))
        throw new Error("Invalid renderer build identity.");
    const digest = sha256(JSON.stringify({
        buildId, rendererVersion: STORY_RENDERER_VERSION, variantId: job.variantId,
        artwork: job.artwork, mockup: job.mockup, settings: job.settings,
        motion: DEFAULT_STORY_MOTION, encoding: ENCODING, preset: "veryfast", websiteLabel: "shop.bent.build",
    }));
    return { digest, key: `outputs/${job.runId}/${job.customerId}/${job.variantId}/${digest}.mp4` };
}
