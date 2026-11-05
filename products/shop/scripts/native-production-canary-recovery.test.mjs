import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyReviewedCanaryFailure, recoverProductionCanary, canaryRecoveryStage } from "./native-production-canary-recovery.mjs";
import { immutableObjectVersion } from "./native-production-release-store.mjs";
const fixture = () => {
    const sessionToken = "a".repeat(43), designId = "11111111-1111-4111-8111-111111111111";
    return { releaseId: "native-" + protectedConfig("resource_99eca93d1134"), designId,
        artworkKey: "designs/" + (designId) + "/artwork/" + "ed234ac311653a0c78954716d16266f2ef124b37ddb780d96d7d3fa5ad6b60bc", createdAt: 1788065010000,
        ownerId: createHash("sha256").update(sessionToken).digest("hex"), sessionToken,
        source: { kind: "synthetic-colour-blocks-v1", byte_size: 204510, artwork_width: 2400, artwork_height: 3000,
            sha256: "ed234ac311653a0c78954716d16266f2ef124b37ddb780d96d7d3fa5ad6b60bc", customerArtworkRead: false } };
};
const reviewed = () => {
    const value = fixture();
    return { fixture: value,
        control: { paused: 1, release_id: value.releaseId, current_release_id: value.releaseId, paused_at: value.createdAt + 30000 },
        failed: { runId: protectedConfig("resource_0cee8f722ce6"), admissionsPaused: true }, failedAt: value.createdAt + 30000,
        designCount: 0, activeCount: 0, priorRecovery: { failedRun: protectedConfig("resource_366cf2abe0fe"),
            status: { protocolVerified: true, releaseId: "native-" + protectedConfig("resource_99eca93d1134"), paused: false } } };
};
test("recovery is sealed to the corrected-key guard failure before draft or video work", () => {
    verifyReviewedCanaryFailure(reviewed());
    for (const mutate of [value => { value.control.paused = 0; }, value => { value.failed.runId = "other"; },
        value => { value.fixture.artworkKey = `designs/${value.fixture.designId}/native-production-canary.png`; },
        value => { value.designCount = 1; }, value => { value.activeCount = 1; }, value => { value.priorRecovery.status.paused = true; }]) {
        const changed = structuredClone(reviewed());
        mutate(changed);
        assert.throws(() => verifyReviewedCanaryFailure(changed));
    }
});
test("each recovery attempt records independent immutable event stages", () => {
    assert.equal(canaryRecoveryStage("start", protectedConfig("resource_0cee8f722ce6")), "canary-recovery-start-" + protectedConfig("resource_0cee8f722ce6").replace(/\d/g, digit => String.fromCharCode(97 + Number(digit))));
    assert.notEqual(canaryRecoveryStage("done", protectedConfig("resource_0cee8f722ce6")), canaryRecoveryStage("done", protectedConfig("resource_366cf2abe0fe")));
    assert.throws(() => canaryRecoveryStage("retry", protectedConfig("resource_0cee8f722ce6")));
});
test("recovery evidence requires a bounded encrypted version-pinned object", () => {
    assert.equal(immutableObjectVersion({ VersionId: "fixed", ContentLength: 1024, ServerSideEncryption: "AES256" }), "fixed");
    for (const result of [{ VersionId: "null", ContentLength: 1024, ServerSideEncryption: "AES256" },
        { VersionId: "fixed", ContentLength: 65537, ServerSideEncryption: "AES256" },
        { VersionId: "fixed", ContentLength: 1024, ServerSideEncryption: "aws:kms" },
        { VersionId: "fixed", ContentLength: 1024, ServerSideEncryption: "AES256", DeleteMarker: true }]) {
        assert.throws(() => immutableObjectVersion(result));
    }
});
test("recovery cannot target another release or run outside the guarded Actions context", async () => {
    await assert.rejects(recoverProductionCanary({ NATIVE_OPERATION: "recover-canary", NATIVE_VERIFY_RELEASE: "native-123" }), /reviewed release/);
    await assert.rejects(recoverProductionCanary({ NATIVE_OPERATION: "recover-canary", NATIVE_VERIFY_RELEASE: "native-" + protectedConfig("resource_99eca93d1134") }), /exact main-only/);
});
