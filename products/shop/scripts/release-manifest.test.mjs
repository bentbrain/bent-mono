import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { promotionManifest, validatePromotionManifest } from "./release-manifest.mjs";
test("reviewed manifest matches the immutable qualification receipt and acceptance reports", () => {
    const read = path => JSON.parse(resolveProtectedTemplate(readFileSync(new URL(`../${path}`, import.meta.url))));
    const receipt = read("infra/story-video-lambda/development-qualification.json");
    assert.deepEqual(receipt.expectedPair, { releaseId: promotionManifest.qualification.releaseId,
        sourceCommit: promotionManifest.qualification.sourceCommit, imageDigest: promotionManifest.candidate.imageDigest });
    assert.equal(receipt.qualificationRunId, promotionManifest.qualification.runId);
    const phone = read(promotionManifest.phone.path);
    assert.equal(phone.ownerResponse, promotionManifest.phone.ownerResponse);
    assert.deepEqual(phone.requestedChecks, promotionManifest.phone.requestedChecks);
});
test("manifest rejects incomplete identities, unsafe report paths and missing acceptance", () => {
    for (const mutate of [v => { v.candidate.buildRunId = 0; }, v => { v.phone.path = "../private.json"; },
        v => { v.qualification.sourceCommit = "main"; }, v => { v.phone.ownerResponse = ""; },
        v => { v.alertDelivery.runId = protectedConfig("resource_bfc0dfa5a249"); }]) {
        const value = structuredClone(promotionManifest);
        mutate(value);
        assert.throws(() => validatePromotionManifest(value));
    }
});
