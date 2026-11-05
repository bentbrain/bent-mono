import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export const PERSONAL_ACCOUNT = protectedConfig("awsAccountId");
export const PERSONAL_REGION = "ap-southeast-2";
export const ENVIRONMENTS = Object.freeze({
    development: Object.freeze({
        worker: "forever-tee-api-development",
        functionArn: `arn:aws:lambda:${PERSONAL_REGION}:${PERSONAL_ACCOUNT}:function:forever-tee-video-development`,
    }),
    production: Object.freeze({
        worker: "forever-tee-api",
        functionArn: `arn:aws:lambda:${PERSONAL_REGION}:${PERSONAL_ACCOUNT}:function:forever-tee-video-production`,
    }),
});
// Offline metadata checks only. Nothing here attests an AWS build, a deployed
// Worker, protocol compatibility, a drain, or permission to release/roll back.
const HASH = /^[0-9a-f]{64}$/;
const IMAGE = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAPSHOT_KEYS = ["environment", "accountId", "region", "provider", "worker", "functionArn",
    "sourceDigest", "imageDigest", "imageSourceDigest", "rendererVersion", "workerRelease", "imageRelease"];
function fail(message) {
    throw new Error(`Native release metadata rejected: ${message}`);
}
function record(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) {
        fail("expected only the documented record fields.");
    }
}
function matches(value, pattern) {
    return typeof value === "string" && pattern.test(value);
}
function validateSnapshot(manifest) {
    const environment = manifest.environment;
    if (typeof environment !== "string" || !Object.hasOwn(ENVIRONMENTS, environment)) {
        fail("unknown environment.");
    }
    const expected = ENVIRONMENTS[environment];
    if (manifest.accountId !== PERSONAL_ACCOUNT || manifest.region !== PERSONAL_REGION) {
        fail("account or region is not the approved personal target.");
    }
    if (manifest.provider !== "lambda")
        fail("the native release must explicitly target Lambda.");
    if (manifest.worker !== expected.worker || manifest.functionArn !== expected.functionArn) {
        fail("Worker and Lambda function do not belong to the same environment.");
    }
    if (!matches(manifest.sourceDigest, HASH))
        fail("source digest must be a SHA-256 string.");
    if (!matches(manifest.imageDigest, IMAGE))
        fail("image digest must be a sha256-prefixed string.");
    if (manifest.imageSourceDigest !== manifest.sourceDigest) {
        fail("declared source digests disagree.");
    }
    if (!matches(manifest.rendererVersion, /^story-video-renderer-v[1-9][0-9]*$/)) {
        fail("renderer version has an invalid format.");
    }
    if (!matches(manifest.workerRelease, UUID))
        fail("Worker version must be a UUID.");
    // imageRelease records the CodeBuild build ID, not a Lambda version/alias.
    const prefix = `forever-tee-video-${environment}:`;
    if (typeof manifest.imageRelease !== "string" || !manifest.imageRelease.startsWith(prefix) ||
        !matches(manifest.imageRelease.slice(prefix.length), UUID)) {
        fail("CodeBuild ID must belong to the same environment.");
    }
    return Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, manifest[key]]));
}
export function validateReleaseManifest(manifest) {
    record(manifest, [...SNAPSHOT_KEYS, "previous"]);
    const current = validateSnapshot(manifest);
    const previous = validatePreviousRelease(manifest.previous, current.environment);
    return { ...current, previous };
}
export function validatePreviousRelease(previous, environment) {
    record(previous, SNAPSHOT_KEYS);
    const manifest = validateSnapshot(previous);
    if (manifest.environment !== environment)
        fail("rollback metadata belongs to another environment.");
    return manifest;
}
export async function readReleaseManifest(path) {
    let value;
    try {
        value = JSON.parse(resolveProtectedTemplate(await readFile(path, "utf8")));
    }
    catch {
        fail("release manifest cannot be read.");
    }
    return validateReleaseManifest(value);
}
export function rollbackMetadata(manifest) {
    // Describes the previous record only; never execute a rollback from this.
    return validateReleaseManifest(manifest).previous;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const path = process.argv[2];
    if (!path)
        fail("supply a release manifest path.");
    const manifest = await readReleaseManifest(path);
    console.info(JSON.stringify({ environment: manifest.environment, validation: "metadata-only", releaseAuthorized: false }));
}
