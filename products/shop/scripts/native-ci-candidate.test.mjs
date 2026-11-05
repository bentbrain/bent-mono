import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { verifyCandidateRecord } from "./native-ci-candidate.mjs";
test("reusing an image requires the exact candidate record and unchanged current source", () => {
    const sourceDigest = "a".repeat(64), sourceCommit = "b".repeat(40), zipSha256 = "c".repeat(64), githubRunId = "123";
    const imageDigest = `sha256:${"d".repeat(64)}`;
    const receipt = { schemaVersion: 1, sourceDigest, candidateKey: `source/candidates/${sourceDigest}/${githubRunId}.json`, candidateVersion: "version-1", candidateSha256: "e".repeat(64) };
    const candidate = { schemaVersion: 1, environment: "development", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2",
        sourceDigest, sourceCommit, zipSha256, githubRunId, sourceKey: `source/${sourceCommit}/${githubRunId}/${zipSha256}.zip`, sourceVersion: "version-2",
        executionProtocol: "claim-v1", rendererVersion: "story-video-renderer-v7", imageDigest,
        imageUri: protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@" + (imageDigest), deploymentPerformed: false };
    assert.equal(verifyCandidateRecord(receipt, candidate, sourceDigest), candidate);
    for (const delta of [{ accountId: "work" }, { region: "us-east-1" }, { sourceDigest: "f".repeat(64) }, { environment: "production" },
        { githubRunId: "999" }, { sourceKey: "mutable/latest.zip" }, { sourceVersion: "null" }, { imageUri: "mutable:latest" },
        { executionProtocol: "none" }, { rendererVersion: "v7" }, { deploymentPerformed: true }]) {
        assert.throws(() => verifyCandidateRecord(receipt, { ...candidate, ...delta }, sourceDigest));
    }
    for (const delta of [{ candidateVersion: "null" }, { candidateSha256: "" }, { candidateKey: "other" }, { sourceDigest: "other" }]) {
        assert.throws(() => verifyCandidateRecord({ ...receipt, ...delta }, candidate, sourceDigest));
    }
});
