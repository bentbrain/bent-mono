import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { developmentReleaseObjectKey } from "./native-ci-release-store.mjs";
test("ordinary release evidence stays in its Actions run namespace", () => {
    assert.equal(developmentReleaseObjectKey({ GITHUB_RUN_ID: "456", NATIVE_OPERATION: "release" }, "release.json"), "source/releases/native-456/release.json");
});
test("complete qualification evidence uses the fixed Production-readable namespace and an immutable run suffix", () => {
    const env = {
        GITHUB_RUN_ID: "789",
        NATIVE_OPERATION: "qualify-all",
        NATIVE_VERIFY_RELEASE: "native-456",
    };
    assert.equal(developmentReleaseObjectKey(env, "qualification-complete-summary.json"), "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-complete-summary-native-456-run-789.json");
    assert.equal(developmentReleaseObjectKey(env, "qualification-family-one.json"), "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-family-one-native-456-run-789.json");
});
test("qualification evidence refuses unpinned release and run identities", () => {
    assert.throws(() => developmentReleaseObjectKey({
        GITHUB_RUN_ID: "789",
        NATIVE_OPERATION: "qualify-all",
        NATIVE_VERIFY_RELEASE: "latest",
    }, "qualification-complete-summary.json"));
    assert.throws(() => developmentReleaseObjectKey({
        GITHUB_RUN_ID: "rerun",
        NATIVE_OPERATION: "qualify-all",
        NATIVE_VERIFY_RELEASE: "native-456",
    }, "qualification-complete-summary.json"));
    assert.throws(() => developmentReleaseObjectKey({
        GITHUB_RUN_ID: "789",
        NATIVE_OPERATION: "qualify-all",
        NATIVE_VERIFY_RELEASE: "native-456",
    }, "../qualification-complete-summary.json"));
});
test('failed cleanup evidence stays outside the successful qualification namespace', () => {
    const env = { GITHUB_RUN_ID: '789', NATIVE_OPERATION: 'cleanup-failed-qualification', NATIVE_VERIFY_RELEASE: 'native-456' };
    assert.equal(developmentReleaseObjectKey(env, 'failed-qualification-cleanup-receipt.json'), 'source/releases/native-789/failed-qualification-cleanup-receipt.json');
});
