import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { assertProductionContext, productionAWS, readProductionEvidenceRun } from "./native-production-ci.mjs";
import { executeProductionPromotion } from "./native-production-provision.mjs";
const env = () => ({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "1234",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production.yml@refs/heads/main", NATIVE_OPERATION: "verify-candidate",
    AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "ap-southeast-2", AWS_ACCESS_KEY_ID: "test-key", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_SESSION_TOKEN: "test-session", GITHUB_TOKEN: "test-token" });
test("Production context forbids unknown operations, other refs, reruns and other repositories", () => {
    assert.doesNotThrow(() => assertProductionContext(env()));
    assert.doesNotThrow(() => assertProductionContext({ ...env(), NATIVE_OPERATION: "inspect-image-plan" }));
    assert.doesNotThrow(() => assertProductionContext({ ...env(), NATIVE_OPERATION: "promote" }));
    assert.doesNotThrow(() => assertProductionContext({ ...env(), NATIVE_OPERATION: "recover-release" }));
    assert.doesNotThrow(() => assertProductionContext({ ...env(), NATIVE_OPERATION: "repair-featured-videos" }));
    assert.doesNotThrow(() => assertProductionContext({ ...env(), NATIVE_OPERATION: "sweep-products" }));
    for (const [key, value] of Object.entries({ GITHUB_ACTIONS: "false", GITHUB_REPOSITORY: "other/repo", GITHUB_REPOSITORY_ID: "other", GITHUB_REPOSITORY_OWNER_ID: "other",
        GITHUB_REF: "refs/heads/perf/story-video-family-experiments", GITHUB_EVENT_NAME: "push", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "main", GITHUB_RUN_ID: "x",
        GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main", NATIVE_OPERATION: "arbitrary-deploy" })) {
        assert.throws(() => assertProductionContext({ ...env(), [key]: value }));
    }
});
test("one-pass promotion runs canary only after the same paired release completes", async () => {
    const input = { ...env(), NATIVE_OPERATION: "promote" }, calls = [];
    const result = await executeProductionPromotion(input, { qualifiedImageVerified: true }, {
        releasePair: async (releaseEnv, candidate) => {
            calls.push("release");
            assert.equal(releaseEnv.NATIVE_OPERATION, "release");
            assert.equal(candidate.qualifiedImageVerified, true);
            return { pairedReleaseComplete: true, releaseId: "native-1234", provider: "lambda" };
        },
        runCanary: async (canaryEnv) => {
            calls.push("canary");
            assert.equal(canaryEnv.NATIVE_OPERATION, "canary");
            assert.equal(canaryEnv.NATIVE_VERIFY_RELEASE, "native-1234");
            return { productionCanaryPassed: true, releaseId: "native-1234" };
        },
    });
    assert.deepEqual(calls, ["release", "canary"]);
    assert.equal(result.productionPromotionComplete, true);
    await assert.rejects(executeProductionPromotion(input, {}, {
        releasePair: async () => ({ pairedReleaseComplete: false, releaseId: "native-1234", provider: "lambda" }),
        runCanary: async () => { throw Error("must not run"); },
    }), /paired native release/);
});
test("Production AWS uses only the exact temporary role/session and strips inherited credentials and injection", async () => {
    const calls = [], input = { ...env(), AWS_PROFILE: "work", AWS_CONFIG_FILE: "/work", NODE_OPTIONS: "--require=injected", HTTPS_PROXY: "untrusted", HOME: "/work" };
    const aws = await productionAWS(input, async (command, args, options) => {
        calls.push(args);
        assert.equal(command, "aws");
        assert.equal(options.env.AWS_CONFIG_FILE, "/dev/null");
        assert.equal(options.env.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
        for (const key of ["AWS_PROFILE", "HOME", "NODE_OPTIONS", "HTTPS_PROXY"])
            assert.equal(options.env[key], undefined);
        assert.equal(options.env.AWS_MAX_ATTEMPTS, "1");
        return { stdout: JSON.stringify({ Account: protectedConfig("awsAccountId"), Arn: "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/forever-tee-video-production-ci/native-production-1234" }) };
    });
    await aws.call(["lambda", "get-account-settings"]);
    assert.equal(calls.length, 2);
    for (const identity of [{ Account: "000000000000" }, { Account: protectedConfig("awsAccountId"), Arn: "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/forever-tee-video-development-ci/native-1234" },
        { Account: protectedConfig("awsAccountId"), Arn: "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/forever-tee-video-production-ci/native-production-other" }]) {
        await assert.rejects(productionAWS(env(), async () => ({ stdout: JSON.stringify(identity) })), /role\/session/);
    }
    await assert.rejects(productionAWS({ ...env(), AWS_SESSION_TOKEN: "" }, async () => { throw Error("must not call"); }), /credentials/);
});
test("evidence reads require exact successful original runs and never expose failed response content", async () => {
    const run = { id: Number(protectedConfig("resource_616af7025011")), status: "completed", conclusion: "success", run_attempt: 1, event: "workflow_dispatch",
        repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) } };
    assert.deepEqual(await readProductionEvidenceRun(env(), run.id, async () => ({ ok: true, json: async () => run })), run);
    for (const change of [{ id: 1 }, { run_attempt: 2 }, { conclusion: "failure" }, { head_repository: { id: 7 } }])
        await assert.rejects(readProductionEvidenceRun(env(), run.id, async () => ({ ok: true, json: async () => ({ ...run, ...change }) })));
    await assert.rejects(readProductionEvidenceRun(env(), 1, async () => { throw Error("must not call"); }), /fixed original/);
    await assert.rejects(readProductionEvidenceRun(env(), run.id, async () => ({ ok: false, json: async () => { throw Error("private response"); } })), /request failed/);
});
test("the pinned saved-design qualification is admitted only after its original run succeeds", async () => {
    const run = { id: Number(protectedConfig("resource_902fcbdf18c6")), status: "completed", conclusion: "success", run_attempt: 1, event: "workflow_dispatch",
        repository: { id: Number(protectedConfig("githubRepositoryId")), owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) } };
    assert.deepEqual(await readProductionEvidenceRun(env(), run.id, async () => ({ ok: true, json: async () => run })), run);
    for (const change of [{ status: "in_progress", conclusion: null }, { conclusion: "failure" }, { run_attempt: 2 }]) {
        await assert.rejects(readProductionEvidenceRun(env(), run.id, async () => ({ ok: true, json: async () => ({ ...run, ...change }) })), /successful first-attempt personal evidence run/);
    }
});
test("API promotion retains same-release canary with ordinary recovery context", async () => {
    const calls = [];
    const result = await executeProductionPromotion({ ...env(), NATIVE_OPERATION: "promote", NATIVE_RELEASE_MODE: "api" }, {}, {
        releasePair: async (context) => { calls.push(context); return { pairedReleaseComplete: true, releaseId: "native-1234", provider: "lambda" }; },
        runCanary: async (context) => { assertProductionContext(context); calls.push(context); return { productionCanaryPassed: true, releaseId: "native-1234" }; },
    });
    assert.equal(result.productionPromotionComplete, true);
    assert.equal(calls[0].NATIVE_RELEASE_MODE, "api");
    assert.equal(calls[1].NATIVE_RELEASE_MODE, "full");
    assert.throws(() => assertProductionContext({ ...env(), NATIVE_OPERATION: "rollback", NATIVE_RELEASE_MODE: "api" }));
});
