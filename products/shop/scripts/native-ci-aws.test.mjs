import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { STATE_KMS, verifyCIStorage } from "./native-ci-aws.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/perf/story-video-family-experiments", GITHUB_SHA: "a".repeat(40),
    GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "123", GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-ci-identity.yml@refs/heads/perf/story-video-family-experiments",
    AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "ap-southeast-2", AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture-secret", AWS_SESSION_TOKEN: "fixture-token",
    AWS_PROFILE: "work", AWS_ENDPOINT_URL: "https://wrong.invalid" };
const responses = {
    "get-caller-identity": { Account: protectedConfig("awsAccountId"), Arn: "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/forever-tee-video-development-ci/native-123" },
    "get-bucket-versioning": { Status: "Enabled" },
    "get-bucket-encryption": { ServerSideEncryptionConfiguration: { Rules: [{ BucketKeyEnabled: false,
                    ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: STATE_KMS } }] } },
    "get-public-access-block": { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } },
};
test("CI storage verification uses the exact temporary role and strips inherited credential configuration", async () => {
    const calls = [];
    const result = await verifyCIStorage(env, async (command, args, options) => {
        calls.push(args);
        assert.equal(command, "aws");
        assert.equal(options.env.AWS_PROFILE, undefined);
        assert.equal(options.env.AWS_ENDPOINT_URL, undefined);
        assert.equal(options.env.AWS_CONFIG_FILE, "/dev/null");
        assert.equal(options.env.AWS_SESSION_TOKEN, "fixture-token");
        return { stdout: JSON.stringify(responses[args[1]]) };
    });
    assert.equal(result.ciAWSVerified, true);
    assert.equal(result.mutationsAttempted, false);
    assert.equal(calls.length, 4);
    assert.equal(calls[0][0], "sts");
});
test("local/wrong account, role, region, bucket security and CLI failures cannot pass CI verification", async () => {
    for (const changed of [{ ...env, GITHUB_ACTIONS: "false" }, { ...env, AWS_REGION: "us-east-1" }, { ...env, AWS_SESSION_TOKEN: "" }]) {
        await assert.rejects(verifyCIStorage(changed, async () => assert.fail("must reject before AWS")));
    }
    for (const operation of Object.keys(responses)) {
        let calls = 0;
        await assert.rejects(verifyCIStorage(env, async (_command, args) => {
            calls++;
            return { stdout: JSON.stringify(args[1] === operation ? {} : responses[args[1]]) };
        }));
        if (operation === "get-caller-identity")
            assert.equal(calls, 1);
    }
    await assert.rejects(verifyCIStorage(env, async () => { throw new Error("fixture-secret"); }), error => !error.message.includes("fixture-secret"));
});
