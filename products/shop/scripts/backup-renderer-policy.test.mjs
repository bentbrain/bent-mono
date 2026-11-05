import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { backupContext, assertInactiveBackup, assertBackupReceipt, BACKUP_ACCOUNT } from "./backup-renderer-policy.mjs";
const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_ACTOR_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: "12345",
    GITHUB_SHA: "a".repeat(40), GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/backup-renderer.yml@refs/heads/main",
    BACKUP_ENVIRONMENT: "development", CLOUDFLARE_ACCOUNT_ID: BACKUP_ACCOUNT, CLOUDFLARE_API_TOKEN: "private-test", RUNNER_TEMP: "/tmp/test" };
test("backup bootstrap binds the owner, protected main workflow, account and fixed existing resources", () => {
    assert.equal(backupContext(env).worker, "forever-tee-story-video-development");
    assert.equal(backupContext({ ...env, BACKUP_ENVIRONMENT: "production" }).worker, "forever-tee-story-video");
    for (const change of [{ GITHUB_ACTIONS: "false" }, { GITHUB_ACTOR_ID: "123" }, { GITHUB_RUN_ATTEMPT: "2" },
        { GITHUB_REF: "refs/heads/review" }, { GITHUB_EVENT_NAME: "pull_request" }, { RUNNER_ENVIRONMENT: "self-hosted" },
        { CLOUDFLARE_ACCOUNT_ID: "work" }, { BACKUP_ENVIRONMENT: "preview" }, { GITHUB_WORKFLOW_REF: "other" }]) {
        assert.throws(() => backupContext({ ...env, ...change }), /stopped/);
    }
});
test("bootstrap cannot touch an active backup, compete with a release or change a published composition runtime", () => {
    const settings = { bindings: [{ name: "STORY_VIDEO_PROVIDER", type: "plain_text", text: "lambda" }] };
    const controls = [{ paused: 0, release_id: null, current_release_id: "native-12345" }];
    assertInactiveBackup(settings, controls, [{ count: 0 }]);
    assert.throws(() => assertInactiveBackup({ bindings: [] }, controls, [{ count: 0 }]));
    assert.throws(() => assertInactiveBackup({ bindings: [{ ...settings.bindings[0], text: "cloudflare" }] }, controls, [{ count: 0 }]));
    assert.throws(() => assertInactiveBackup(settings, [{ ...controls[0], paused: 1 }], [{ count: 0 }]));
    assert.throws(() => assertInactiveBackup(settings, controls, [{ count: 1 }]));
});
test("Production must reuse the exact qualified Preview image and source with decoded frames and completed cleanup", () => {
    const receipt = { schemaVersion: 1, environment: "development", sourceCommit: env.GITHUB_SHA, runId: "12345",
        qualified: true, cleaned: true, contract: "two-source-v2", bundleSha256: "b".repeat(64),
        image: `registry.cloudflare.com/${BACKUP_ACCOUNT}/featured-backup@sha256:${"c".repeat(64)}`,
        workerVersion: "11223344-1234-1234-1234-112233445566", frames: [0, 2, 4].map(second => ({ second, rmse: 1 })) };
    assertBackupReceipt(receipt, env.GITHUB_SHA);
    for (const change of [{ sourceCommit: "d".repeat(40) }, { qualified: false }, { cleaned: false },
        { image: "registry.cloudflare.com/work/image:latest" }, { frames: [] }, { frames: [{ rmse: NaN }, { rmse: 0 }, { rmse: 0 }] },
        { frames: [{ rmse: 6 }, { rmse: 0 }, { rmse: 0 }] }])
        assert.throws(() => assertBackupReceipt({ ...receipt, ...change }, env.GITHUB_SHA));
});
test("recovery accepts only the completed original Development deployment and unchanged native baseline", async () => {
    const { backupRecoverySource, assertBackupRecovery } = await import("./backup-renderer-policy.mjs");
    const context = backupContext(env), source = "b".repeat(40);
    assert.equal(backupRecoverySource(env, context), null);
    assert.equal(backupRecoverySource({ BACKUP_OPERATION: "recover", BACKUP_RECOVERY_SOURCE: source }, context), source);
    for (const input of [
        { BACKUP_OPERATION: "replace" },
        { BACKUP_OPERATION: "deploy", BACKUP_RECOVERY_SOURCE: source },
        { BACKUP_OPERATION: "recover" },
        { BACKUP_OPERATION: "recover", BACKUP_RECOVERY_SOURCE: context.sourceCommit },
    ])
        assert.throws(() => backupRecoverySource(input, context));
    assert.equal(backupRecoverySource({ BACKUP_OPERATION: "recover", BACKUP_RECOVERY_SOURCE: source }, { ...context, environment: "production" }), source);
    const nativeBefore = { apiVersion: "native-version", controls: [{ paused: 0, release_id: null, current_release_id: "native-123" }] };
    const intent = { schemaVersion: 1, ...context, sourceCommit: source, nativeBefore,
        intentKey: `editorial/backup/${source}/development-intent.json`, receiptKey: `editorial/backup/${source}/development.json`,
        image: `registry.cloudflare.com/${BACKUP_ACCOUNT}/featured-backup@sha256:${"c".repeat(64)}`,
        bundleSha256: "d".repeat(64), before: { workerVersion: "old", container: { version: 23 } } };
    const live = { workerVersion: "new", container: { id: context.containerId, image: intent.image, version: 24 } };
    assert.equal(assertBackupRecovery(intent, context, source, live, nativeBefore), intent);
    for (const change of [{ environment: "production" }, { sourceCommit: context.sourceCommit }, { runId: "unknown" },
        { containerId: "another" }, { image: "mutable:tag" }, { bundleSha256: "" }, { intentKey: "elsewhere" },
        { recovery: { runId: "older" } }]) {
        assert.throws(() => assertBackupRecovery({ ...intent, ...change }, context, source, live, nativeBefore));
    }
    for (const changed of [{ ...live, workerVersion: "old" },
        { ...live, container: { ...live.container, image: "another" } },
        { ...live, container: { ...live.container, version: 25 } }]) {
        assert.throws(() => assertBackupRecovery(intent, context, source, changed, nativeBefore));
    }
    assert.throws(() => assertBackupRecovery(intent, context, source, live, { ...nativeBefore, apiVersion: "changed" }));
});
test("Production recovery retains the original qualified source and records the current tooling source", async () => {
    const { backupRecoverySource, assertBackupRecovery } = await import("./backup-renderer-policy.mjs");
    const source = "b".repeat(40);
    const input = { ...env, BACKUP_ENVIRONMENT: "production", BACKUP_OPERATION: "recover", BACKUP_RECOVERY_SOURCE: source };
    const context = backupContext(input);
    assert.equal(context.sourceCommit, source);
    assert.equal(context.toolingCommit, env.GITHUB_SHA);
    assert.equal(context.receiptKey, `editorial/backup/${source}/production.json`);
    assert.equal(context.intentKey, `editorial/backup/${env.GITHUB_SHA}/production-recovery-intent.json`);
    assert.equal(backupRecoverySource(input, context), source);
    const nativeBefore = { apiVersion: "unchanged", controls: [{ paused: 0, release_id: null, current_release_id: "native-999" }] };
    const intent = { schemaVersion: 1, ...context, runId: "56789", nativeBefore,
        intentKey: `editorial/backup/${source}/production-intent.json`,
        image: `registry.cloudflare.com/${BACKUP_ACCOUNT}/featured-backup@sha256:${"c".repeat(64)}`,
        bundleSha256: "d".repeat(64), before: { workerVersion: "old", container: { version: 12 } } };
    const live = { workerVersion: "new", container: { id: context.containerId, image: intent.image, version: 13 } };
    assert.equal(assertBackupRecovery(intent, context, source, live, nativeBefore), intent);
    assert.throws(() => assertBackupRecovery(intent, context, source, live, { ...nativeBefore, apiVersion: "changed" }));
    assert.throws(() => assertBackupRecovery(intent, context, source, { ...live, container: { ...live.container, version: 14 } }, nativeBefore));
});
