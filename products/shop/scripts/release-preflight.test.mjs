import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { allowedBranch, githubPreflight, offlinePreflight } from "./release-preflight.mjs";
import { NATIVE_MIGRATION_COUNT, NATIVE_MIGRATION_LATEST } from "./native-migration-inventory.mjs";
const migrations = Array.from({ length: NATIVE_MIGRATION_COUNT }, (_, i) => `${i}.sql`);
migrations[migrations.length - 1] = NATIVE_MIGRATION_LATEST;
const sha = "a".repeat(40);
const input = { environment: "development", lane: "web", operation: "deploy", ref: "refs/heads/main", sha, base: sha, paths: [], migrations };
test("Development schedule repair requires the recorded live release and main", () => {
    const repair = { ...input, lane: "native", operation: "repair-schedule", verifyRelease: "native-12345" };
    assert.equal(offlinePreflight(repair).passed, true);
    assert.equal(offlinePreflight({ ...repair, verifyRelease: undefined }).passed, false);
    assert.equal(offlinePreflight({ ...repair, ref: "refs/heads/feature" }).passed, false);
    assert.equal(offlinePreflight({ ...repair, environment: "production" }).passed, false);
});
test("exact main can enter web Preview without a temporary allowed branch", () => {
    const result = offlinePreflight(input);
    assert.equal(result.passed, true);
    assert.equal(result.admissionGranted, false);
    assert.equal(offlinePreflight({ ...input, paths: ["apps/web/src/page.tsx"] }).passed, false);
});
test("aggregates routing, source-policy and migration failures before cloud access", () => {
    const result = offlinePreflight({ ...input, environment: "production", lane: "wrangler", ref: "refs/heads/feature",
        migrations: [], paths: ["workers/api/src/index.ts"] });
    assert.deepEqual(result.checks.filter(c => !c.passed).map(c => c.id), ["production-ref", "migration-inventory", "native-routing"]);
});
test("checks native script policy even if a feature branch has Preview permission", () => {
    const result = offlinePreflight({ ...input, lane: "native", operation: "release", ref: "refs/heads/feature" });
    assert.equal(result.checks.find(c => c.id === "native-request").passed, false);
});
test("rejects invalid receipts and stale Worker source together", () => {
    const result = offlinePreflight({ ...input, environment: "production", lane: "native", operation: "promote", qualification: {}, sourceChanged: true });
    assert.deepEqual(result.checks.filter(c => !c.passed).map(c => c.id), ["qualification-reference", "promotion-manifest", "qualified-worker-source"]);
});
test("branch glob does not grant access across a slash or interpret regex", () => {
    assert.equal(allowedBranch({ name: "preview/*", type: "branch" }, "preview/a"), true);
    assert.equal(allowedBranch({ name: "preview/*", type: "branch" }, "preview/a/b"), false);
    assert.equal(allowedBranch({ name: "main", type: "tag" }, "main"), false);
    assert.equal(allowedBranch({ name: "main.*", type: "branch" }, "mainXthing"), false);
});
test("live reads aggregate missing permissions, stale refs and competing releases", async () => {
    const report = offlinePreflight(input);
    const checks = await githubPreflight(report, async (path) => {
        if (path === "environments/Preview")
            return { deployment_branch_policy: { custom_branch_policies: true } };
        if (path.includes("deployment-branch-policies"))
            return { total_count: 1, branch_policies: [{ name: "old-branch", type: "branch" }] };
        if (path.startsWith("branches/"))
            return { commit: { sha: "b".repeat(40) } };
        return { total_count: 1, workflow_runs: [{ id: 55, path: ".github/workflows/native-development.yml" }] };
    });
    assert.equal(checks.length, 3);
    assert.ok(checks.every(c => c.passed === false));
    assert.match(checks.find(c => c.id === "github-release-activity").message, /55/);
});
test("qualification and rollback require the actual caller-supplied release IDs", () => {
    const native = { ...input, lane: "native", operation: "qualify-all" };
    assert.equal(offlinePreflight(native).passed, false);
    assert.equal(offlinePreflight({ ...native, verifyRelease: "native-12345" }).passed, true);
    assert.equal(offlinePreflight({ ...native, operation: "rollback", rollbackRelease: "native-12345" }).passed, true);
    assert.equal(offlinePreflight({ ...native, operation: "rollback" }).passed, false);
});
test("current main is not assumed to be the deployed Wrangler baseline", () => {
    assert.equal(offlinePreflight({ ...input, lane: "wrangler" }).passed, false);
    assert.equal(offlinePreflight({ ...input, lane: "wrangler", releaseBaseVerified: true }).passed, true);
});
test('failed qualification cleanup preflight accepts only its inventory reference and Development main', () => {
    const request = { ...input, lane: 'native', operation: 'cleanup-failed-qualification', verifyRelease: 'native-12345',
        qualificationReference: JSON.stringify({ key: "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-cleanup-inventory-native-12345-run-200.json", version: 'version', sha256: 'b'.repeat(64) }) };
    assert.equal(offlinePreflight(request).passed, true);
    for (const change of [{ qualificationReference: undefined }, { verifyRelease: 'native-999' },
        { environment: 'production' }, { ref: 'refs/heads/feature' }, { releaseMode: 'api' }])
        assert.equal(offlinePreflight({ ...request, ...change }).passed, false);
});
test('paused rollback recovery preflight retains exact original rollback reference and rejects Production or target substitution', () => {
    const request = { ...input, lane: 'native', operation: 'recover-rollback', rollbackRelease: 'native-456',
        rollbackReference: JSON.stringify({ key: 'source/releases/native-456/rollback.json', version: 'sealed', sha256: 'b'.repeat(64) }) };
    assert.equal(offlinePreflight(request).passed, true);
    for (const change of [{ rollbackReference: '' }, { rollbackRelease: 'native-999' }, { environment: 'production' },
        { ref: 'refs/heads/feature' }, { releaseMode: 'api' }, { operation: 'rollback' }])
        assert.equal(offlinePreflight({ ...request, ...change }).passed, false);
});
