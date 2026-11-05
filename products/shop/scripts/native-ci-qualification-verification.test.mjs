import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { verifySavedDevelopmentQualification } from "./native-ci-qualification-verification.mjs";
const receipt = { schemaVersion: 1, qualificationRunId: 200, expectedQualificationCommit: "a".repeat(40),
    expectedPair: { releaseId: "native-100", sourceCommit: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` },
    reference: { key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-complete-summary-native-100-run-200.json",
        version: "fixture-version", sha256: "c".repeat(64) } };
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: "refs/heads/perf/story-video-family-experiments", GITHUB_SHA: "a".repeat(40), GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/perf/story-video-family-experiments",
    NATIVE_OPERATION: "verify-qualification", NATIVE_VERIFY_RELEASE: receipt.expectedPair.releaseId, GITHUB_TOKEN: "private-fixture" };
test("saved evidence inspection refuses local, push, rerun, different-release and missing-token contexts", async () => {
    for (const delta of [{ GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_RUN_ATTEMPT: "2" },
        { GITHUB_TOKEN: "" }, { NATIVE_VERIFY_RELEASE: "native-999" }, { NATIVE_OPERATION: "release" }]) {
        await assert.rejects(verifySavedDevelopmentQualification(receipt, { ...env, ...delta }, {
            request: () => assert.fail("No HTTP before guard"), createStore: () => assert.fail("No AWS before guard"),
        }));
    }
});
for (const [format, key, failure] of [
    ["legacy summary", "complete-summary", /successful first-attempt personal qualification workflow/],
    ["completed receipt", "receipt", /successful completion workflow/],
])
    test(`${format} inspection rejects failed pinned Actions metadata before object reads`, async () => {
        let requests = 0;
        const selected = { ...receipt, reference: { ...receipt.reference,
                key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-" + (key) + "-native-100-run-200.json" } };
        await assert.rejects(verifySavedDevelopmentQualification(selected, env, {
            request: async (url, options) => {
                requests++;
                assert.equal(url, `https://api.github.com/repos/bentbrain/bent-mono/actions/runs/${receipt.qualificationRunId}`);
                assert.equal(options.method, undefined);
                assert.equal(options.redirect, "error");
                assert.equal(options.headers.Authorization, "Bearer private-fixture");
                return Response.json({ id: receipt.qualificationRunId, conclusion: "failure" });
            }, createStore: async () => ({ read: () => assert.fail("No reads for failed run"), save: () => assert.fail("Never save evidence during inspection") }),
        }), failure);
        assert.equal(requests, 1);
    });
