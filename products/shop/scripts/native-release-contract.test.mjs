import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { rollbackMetadata, validateReleaseManifest } from "./native-release-contract.mjs";
const hash = "a".repeat(64);
const image = `sha256:${"b".repeat(64)}`;
function snapshot(environment = "development") {
    return {
        environment, accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2",
        provider: "lambda", worker: environment === "development" ? "forever-tee-api-development" : "forever-tee-api",
        functionArn: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-" + (environment),
        sourceDigest: hash, imageDigest: image, imageSourceDigest: hash,
        rendererVersion: "story-video-renderer-v7", workerRelease: "b3544c91-3e0c-47e0-9344-1d5bbc4d7921",
        imageRelease: `forever-tee-video-${environment}:d0217001-a7f6-45f2-8a84-d560b6e04226`,
    };
}
function release(overrides = {}) {
    return {
        ...snapshot(),
        previous: { ...snapshot(), sourceDigest: "c".repeat(64), imageDigest: `sha256:${"d".repeat(64)}`,
            imageSourceDigest: "c".repeat(64), workerRelease: "2fc159fa-8592-4599-9478-9aaf6697537f" },
        ...overrides,
    };
}
test("checks metadata structure and returns previous metadata without authorizing a rollback", () => {
    const manifest = validateReleaseManifest(release());
    assert.equal(manifest.imageSourceDigest, manifest.sourceDigest);
    assert.deepEqual(rollbackMetadata(manifest), release().previous);
});
test("rejects cross-account, mismatched source and unpaired releases", () => {
    for (const overrides of [
        { accountId: "111111111111" },
        { region: "us-east-1" },
        { imageSourceDigest: "e".repeat(64) },
        { previous: { ...release().previous, environment: "production" } },
        { imageRelease: "" },
    ])
        assert.throws(() => validateReleaseManifest(release(overrides)), /Native release metadata rejected/);
});
test("production is explicit and cannot reuse development identifiers", () => {
    assert.throws(() => validateReleaseManifest(release({ environment: "production" })), /same environment/);
    assert.doesNotThrow(() => validateReleaseManifest({ ...snapshot("production"), previous: snapshot("production") }));
    assert.throws(() => validateReleaseManifest(release({
        ...snapshot("production"),
    })), /rollback/);
});
test("the previous record must have internally consistent declared digests", () => {
    assert.throws(() => validateReleaseManifest(release({
        previous: { ...release().previous, imageSourceDigest: hash },
    })), /digests disagree/);
});
test("metadata validation rejects coercible values and inherited environment names", () => {
    for (const overrides of [
        { workerRelease: true }, { imageRelease: {} }, { imageDigest: [image] },
        { environment: "constructor", worker: undefined, functionArn: undefined,
            previous: { ...release().previous, environment: "constructor" } },
    ])
        assert.throws(() => validateReleaseManifest(release(overrides)), /Native release/);
});
test("rollback metadata cannot smuggle different account and function identities", () => {
    assert.throws(() => validateReleaseManifest(release({ previous: {
            ...release().previous, accountId: "111111111111",
            functionArn: "arn:aws:lambda:us-east-1:111111111111:function:other",
        } })), /Native release/);
});
test("previous metadata requires complete identities and rejects unknown fields", () => {
    for (const key of ["accountId", "region", "worker", "functionArn", "rendererVersion", "imageRelease"]) {
        const previous = { ...release().previous };
        delete previous[key];
        assert.throws(() => validateReleaseManifest(release({ previous })), /record fields/);
    }
    assert.throws(() => validateReleaseManifest(release({ secret: "test-secret" })), /record fields/);
});
test("CLI reports only metadata validation, never release approval or arbitrary input values", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "native-metadata-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "release.json");
    const script = fileURLToPath(new URL("./native-release-contract.mjs", import.meta.url));
    const run = () => spawnSync(process.execPath, [script, path], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
    });
    await writeFile(path, JSON.stringify(release()));
    const valid = run();
    assert.equal(valid.status, 0);
    assert.deepEqual(JSON.parse(valid.stdout), { environment: "development", validation: "metadata-only", releaseAuthorized: false });
    await writeFile(path, JSON.stringify(release({ secret: "do-not-print-this-test-value" })));
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /do-not-print-this-test-value/);
});
