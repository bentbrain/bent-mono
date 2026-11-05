import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectNativeRelease, requireSupportedRelease } from "./native-release-gate.mjs";
test("native API and renderer releases cannot silently use a Wrangler-only deployment", () => {
    for (const environment of ["development", "production"]) {
        for (const changes of [{ apiChanged: true, lambdaChanged: false }, { apiChanged: false, lambdaChanged: true }]) {
            assert.throws(() => requireSupportedRelease({ environment, ...changes,
                bindings: [{ name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "lambda" }] }), /Native Lambda release required/);
        }
    }
    assert.doesNotThrow(() => requireSupportedRelease({ environment: "production", apiChanged: true, lambdaChanged: true, bindings: [] }));
    assert.doesNotThrow(() => requireSupportedRelease({ environment: "development", apiChanged: false, lambdaChanged: false, bindings: [] }));
    assert.throws(() => requireSupportedRelease({ environment: "production", apiChanged: true, lambdaChanged: true,
        bindings: [], plannedProvider: "lambda" }), /Native Lambda release required/);
});
test("remote lookup and unknown providers fail closed without logging credentials", async () => {
    const env = { DEPLOY_ENV: "production", CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"),
        CLOUDFLARE_API_TOKEN: "test-only", API_CHANGED: "true", LAMBDA_CHANGED: "true" };
    await assert.rejects(inspectNativeRelease(env, async () => new Response(null, { status: 403 })), /release blocked/);
    await assert.rejects(inspectNativeRelease(env, async () => Response.json({ success: true, result: { bindings: [
                { name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "unknown" },
            ] } })), /Unknown live/);
    await assert.rejects(inspectNativeRelease({ ...env, CLOUDFLARE_ACCOUNT_ID: "foreign" }, () => assert.fail("Must not send credentials")), /configuration/);
});
test("malformed and ambiguous provider settings cannot hide a native deployment", () => {
    for (const bindings of [null, [null], [{}], [
            { name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "cloudflare" },
            { name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "lambda" },
        ]]) {
        assert.throws(() => requireSupportedRelease({ environment: "production", apiChanged: true, lambdaChanged: true, bindings }));
    }
    assert.throws(() => requireSupportedRelease({ environment: "development", bindings: [] }), /configuration/);
});
test("release gate precedes the first remote mutation", async () => {
    const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
    const gate = workflow.indexOf("node scripts/native-release-gate.mjs");
    assert.ok(gate > 0);
    assert.ok(gate < workflow.indexOf("wrangler d1 migrations apply"));
});
test("a caller-supplied readiness flag cannot bypass the Wrangler-only release stop", () => {
    for (const environment of ["development", "production"]) {
        assert.throws(() => requireSupportedRelease({ environment, apiChanged: true, lambdaChanged: true,
            bindings: [{ name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "lambda" }],
            nativeReleaseReady: true,
        }), /Native Lambda release required/);
    }
});
test("even a well-formed manifest cannot authorize a native release or cross-environment deployment", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "native-gate-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "release.json");
    const snapshot = { environment: "development", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2",
        provider: "lambda", worker: "forever-tee-api-development",
        functionArn: "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development",
        sourceDigest: "a".repeat(64), imageSourceDigest: "a".repeat(64), imageDigest: `sha256:${"b".repeat(64)}`,
        rendererVersion: "story-video-renderer-v7",
        workerRelease: "b3544c91-3e0c-47e0-9344-1d5bbc4d7921",
        imageRelease: "forever-tee-video-development:d0217001-a7f6-45f2-8a84-d560b6e04226" };
    await writeFile(path, JSON.stringify({ ...snapshot, previous: snapshot }));
    for (const environment of ["development", "production"]) {
        const env = { DEPLOY_ENV: environment, CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"),
            CLOUDFLARE_API_TOKEN: "test-only", API_CHANGED: "true", LAMBDA_CHANGED: "true", NATIVE_RELEASE_MANIFEST: path };
        await assert.rejects(inspectNativeRelease(env, async () => Response.json({ success: true, result: {
                bindings: [{ name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "lambda" }],
            } })), /Native Lambda release required/);
    }
});
