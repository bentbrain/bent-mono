import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { developmentOperation } from "./native-ci-operation.mjs";
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: "refs/heads/perf/story-video-family-experiments", GITHUB_SHA: "a".repeat(40), GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/perf/story-video-family-experiments" };
test("pushes cannot deploy; mutation reruns, foreign workflows and ambiguous rollback are rejected", () => {
    assert.equal(developmentOperation(env), "plan");
    const release = { ...env, GITHUB_EVENT_NAME: "workflow_dispatch", NATIVE_OPERATION: "release" };
    assert.equal(developmentOperation(release), "release");
    assert.equal(developmentOperation({ ...release, NATIVE_OPERATION: "build-candidate" }), "build-candidate");
    assert.throws(() => developmentOperation({ ...env, NATIVE_OPERATION: "build-candidate" }));
    assert.equal(developmentOperation({ ...release, NATIVE_OPERATION: "rollback", NATIVE_ROLLBACK_RELEASE: "native-100" }), "rollback");
    assert.equal(developmentOperation({ ...release, NATIVE_OPERATION: "qualify", NATIVE_VERIFY_RELEASE: "native-100" }), "qualify");
    assert.equal(developmentOperation({ ...release, NATIVE_OPERATION: "qualify-exhaustion", NATIVE_VERIFY_RELEASE: "native-100" }), "qualify-exhaustion");
    assert.equal(developmentOperation({ ...release, NATIVE_OPERATION: "qualify-faults", NATIVE_VERIFY_RELEASE: "native-100" }), "qualify-faults");
    for (const operation of ["qualify-termination", "qualify-load", "qualify-all", "verify-qualification"]) {
        assert.equal(developmentOperation({ ...release, NATIVE_OPERATION: operation, NATIVE_VERIFY_RELEASE: "native-100" }), operation);
        assert.throws(() => developmentOperation({ ...release, NATIVE_OPERATION: operation }));
        assert.throws(() => developmentOperation({ ...env, NATIVE_OPERATION: operation, NATIVE_VERIFY_RELEASE: "native-100" }));
    }
    for (const delta of [{ GITHUB_EVENT_NAME: "push" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_WORKFLOW_REF: "foreign" },
        { GITHUB_REPOSITORY_ID: "work" }, { NATIVE_OPERATION: "production" }, { NATIVE_ROLLBACK_RELEASE: "native-100" },
        { NATIVE_OPERATION: "rollback" }, { NATIVE_OPERATION: "rollback", NATIVE_ROLLBACK_RELEASE: "native-123" },
        { NATIVE_OPERATION: "qualify" }, { NATIVE_OPERATION: "qualify-exhaustion" }, { NATIVE_OPERATION: "qualify-faults" }, { NATIVE_VERIFY_RELEASE: "native-100" }]) {
        assert.throws(() => developmentOperation({ ...release, ...delta }));
    }
});
test("API-only mode is restricted to first-attempt release operations", () => {
    const context = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
        GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "1234",
        GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main",
        NATIVE_OPERATION: "release", NATIVE_RELEASE_MODE: "api" };
    assert.equal(developmentOperation(context), "release");
    for (const changes of [{ NATIVE_OPERATION: "plan" }, { NATIVE_OPERATION: "rollback" }, { GITHUB_RUN_ATTEMPT: "2" },
        { NATIVE_RELEASE_MODE: "anything" }])
        assert.throws(() => developmentOperation({ ...context, ...changes }));
});
test('cleanup recovery requires an immutable original reference, main and a separate first attempt', () => {
    const context = { ...env, GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch', NATIVE_OPERATION: 'cleanup-qualification', NATIVE_VERIFY_RELEASE: 'native-100',
        NATIVE_QUALIFICATION_REFERENCE: JSON.stringify({ key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-complete-summary-native-100-run-200.json", version: 'version', sha256: 'b'.repeat(64) }) };
    assert.equal(developmentOperation(context), 'cleanup-qualification');
    for (const change of [{ NATIVE_QUALIFICATION_REFERENCE: '' }, { NATIVE_VERIFY_RELEASE: 'native-999' }, { GITHUB_RUN_ATTEMPT: '2' },
        { NATIVE_OPERATION: 'release' }, { NATIVE_RELEASE_MODE: 'api' }])
        assert.throws(() => developmentOperation({ ...context, ...change }));
});
test('scheduled qualification cannot become a release, a branch experiment or a direct schedule mutation', () => {
    const context = { ...env, GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch', NATIVE_OPERATION: 'qualify-all', NATIVE_VERIFY_RELEASE: 'native-100', NATIVE_SCHEDULED_QUALIFICATION: 'true' };
    assert.equal(developmentOperation(context), 'qualify-all');
    for (const delta of [{ NATIVE_OPERATION: 'release', NATIVE_VERIFY_RELEASE: '' }, { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_REF: env.GITHUB_REF },
        { NATIVE_SCHEDULED_QUALIFICATION: 'unexpected' }, { GITHUB_RUN_ATTEMPT: '2' }])
        assert.throws(() => developmentOperation({ ...context, ...delta }));
});
test('failed fixture cleanup is distinct from qualification recovery and requires an original inventory', () => {
    const context = { ...env, GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch', NATIVE_OPERATION: 'cleanup-failed-qualification', NATIVE_VERIFY_RELEASE: 'native-100',
        NATIVE_QUALIFICATION_REFERENCE: JSON.stringify({ key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-cleanup-inventory-native-100-run-200.json", version: 'version', sha256: 'b'.repeat(64) }) };
    assert.equal(developmentOperation(context), 'cleanup-failed-qualification');
    for (const change of [{ NATIVE_QUALIFICATION_REFERENCE: '' }, { NATIVE_VERIFY_RELEASE: 'native-999' }, { GITHUB_RUN_ATTEMPT: '2' },
        { NATIVE_OPERATION: 'cleanup-qualification' }, { NATIVE_OPERATION: 'release' }, { NATIVE_RELEASE_MODE: 'api' },
        { GITHUB_REF: env.GITHUB_REF }, { NATIVE_RENDERER_REFERENCE: '{}' },
        { NATIVE_QUALIFICATION_REFERENCE: context.NATIVE_QUALIFICATION_REFERENCE.replace('cleanup-inventory', 'complete-summary') }])
        assert.throws(() => developmentOperation({ ...context, ...change }));
});
test('paused rollback recovery requires main, first attempt and exact original versioned rollback evidence', () => {
    const recovery = { ...env, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', NATIVE_OPERATION: 'recover-rollback',
        GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main',
        NATIVE_ROLLBACK_RELEASE: 'native-100', NATIVE_ROLLBACK_REFERENCE: JSON.stringify({ key: 'source/releases/native-100/rollback.json', version: 'sealed', sha256: 'b'.repeat(64) }) };
    assert.equal(developmentOperation(recovery), 'recover-rollback');
    for (const delta of [{ GITHUB_RUN_ATTEMPT: '2' }, { NATIVE_RELEASE_MODE: 'api' }, { NATIVE_ROLLBACK_RELEASE: 'native-123' },
        { NATIVE_ROLLBACK_RELEASE: 'native-999' }, { NATIVE_ROLLBACK_REFERENCE: '' }, { NATIVE_OPERATION: 'rollback' },
        { NATIVE_OPERATION: 'release' }, { NATIVE_VERIFY_RELEASE: 'native-100' }, { GITHUB_REF: 'refs/heads/perf/story-video-family-experiments' }])
        assert.throws(() => developmentOperation({ ...recovery, ...delta }));
});
