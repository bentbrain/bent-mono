import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { assertDeployableImage } from "./native-ci-image-policy.mjs";
import { verifyCandidateRecord } from "./native-ci-candidate.mjs";
import { previousDevelopmentCandidate } from "./native-ci-rollback.mjs";
import { inspectDevelopmentImagePlan } from "./native-ci-terraform.mjs";
const broken = "sha256:" + protectedConfig("resource_5447862d5917");
test("the image that failed actual Lambda startup cannot be promoted or chosen as a rollback target", () => {
    assert.doesNotThrow(() => assertDeployableImage(`sha256:${"a".repeat(64)}`));
    for (const digest of [broken, "latest", undefined, "sha256:unknown"])
        assert.throws(() => assertDeployableImage(digest));
    assert.throws(() => verifyCandidateRecord({}, { imageDigest: broken }, "a".repeat(64)), /image target rejected/);
    assert.throws(() => inspectDevelopmentImagePlan({}, { imageDigest: broken }), /image target rejected/);
    assert.throws(() => previousDevelopmentCandidate({ environment: "development", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2",
        previous: { runtime: { renderer: { imageDigest: broken } } } }), /image target rejected/);
});
