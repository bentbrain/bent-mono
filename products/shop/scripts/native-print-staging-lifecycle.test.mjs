import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { developmentPrintStagingLifecycle, printStagingLifecycleProtocol, planPrintStagingLifecycle, verifyPrintStagingLifecycle, verifyPrintStagingLifecyclePlan } from "./native-print-staging-lifecycle.mjs";
const before = { rules: [{ id: "Default Multipart Abort Rule", enabled: true, conditions: {},
            abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } }] };
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "bentbrain/bent-mono", GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40),
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", NATIVE_OPERATION: "release",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main",
    CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"), CLOUDFLARE_API_TOKEN: "fixture-secret",
    WORKER_URL: "https://forever-tee-api-development.socialqueue.workers.dev" };
test("staging lifecycle adds only one exact-prefix rule and preserves the existing multipart policy", () => {
    const plan = planPrintStagingLifecycle(before);
    assert.equal(plan.mutationRequired, true);
    assert.deepEqual(plan.before, before);
    assert.deepEqual(plan.after.rules[0], before.rules[0]);
    assert.deepEqual(plan.after.rules[1], { id: "expire-development-print-staging-after-one-day", enabled: true,
        conditions: { prefix: "print-assets/staging/v1/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86400 } } });
    assert.equal(verifyPrintStagingLifecyclePlan(plan), true);
    assert.equal(verifyPrintStagingLifecycle(plan.after, plan), true);
    assert.equal(planPrintStagingLifecycle(plan.after).mutationRequired, false);
});
test("broader prefixes, changed retention and edits to pre-existing rules fail before mutation", () => {
    for (const mutate of [plan => { plan.after.rules[1].conditions.prefix = "print-assets/"; },
        plan => { plan.after.rules[1].conditions.prefix = ""; },
        plan => { plan.after.rules[1].deleteObjectsTransition.condition.maxAge = 1; },
        plan => { plan.after.rules[0].enabled = false; }, plan => { plan.after.rules.shift(); }]) {
        const plan = planPrintStagingLifecycle(before);
        mutate(plan);
        assert.throws(() => verifyPrintStagingLifecyclePlan(plan), /scoped append/u);
    }
    const existing = planPrintStagingLifecycle(before).after;
    existing.rules[1].enabled = false;
    assert.throws(() => planPrintStagingLifecycle(existing), /cannot be overwritten/u);
});
test("guarded append rechecks live rules and reads back the exact one-rule addition", async () => {
    let current = before;
    const calls = [];
    const lifecycle = developmentPrintStagingLifecycle(env, async (url, options) => {
        assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/forever-tee-design-artwork-development/lifecycle`);
        calls.push(options.method);
        if (options.method === "PUT")
            current = JSON.parse(options.body);
        return Response.json({ success: true, result: current });
    });
    const plan = planPrintStagingLifecycle(before);
    assert.deepEqual(await lifecycle.append(plan), plan.after);
    assert.deepEqual(calls, ["GET", "PUT", "GET"]);
});
test("drift or non-release context prevents a write while qualification remains read-only", async () => {
    const calls = [];
    const request = async (_url, options) => { calls.push(options.method); return Response.json({ success: true, result: { rules: [] } }); };
    await assert.rejects(developmentPrintStagingLifecycle(env, request).append(planPrintStagingLifecycle(before)), /changed after review/u);
    assert.deepEqual(calls, ["GET"]);
    const qualification = developmentPrintStagingLifecycle({ ...env, NATIVE_OPERATION: "qualify", NATIVE_VERIFY_RELEASE: "native-100" }, request);
    await qualification.read();
    await assert.rejects(qualification.append(planPrintStagingLifecycle(before)), /only the guarded/u);
    assert.deepEqual(calls, ["GET", "GET"]);
    assert.throws(() => developmentPrintStagingLifecycle({ ...env, CLOUDFLARE_ACCOUNT_ID: "work" }, () => assert.fail()));
});
test("failed or uncertain lifecycle writes are not automatically retried", async () => {
    let writes = 0;
    const lifecycle = developmentPrintStagingLifecycle(env, async (_url, options) => {
        if (options.method === "PUT") {
            writes++;
            throw new Error("fixture-secret");
        }
        return Response.json({ success: true, result: before });
    });
    await assert.rejects(lifecycle.append(planPrintStagingLifecycle(before)), error => !error.message.includes("fixture-secret"));
    assert.equal(writes, 1);
});
test("Production staging preserves existing rules and rejects a Development plan or Actions identity", async () => {
    const protocol = printStagingLifecycleProtocol("production");
    const plan = protocol.planPrintStagingLifecycle(before);
    assert.equal(plan.bucket, "forever-tee-design-artwork-production");
    assert.equal(plan.after.rules[1].id, "expire-production-print-staging-after-one-day");
    assert.deepEqual(plan.after.rules[0], before.rules[0]);
    assert.throws(() => protocol.verifyPrintStagingLifecyclePlan(planPrintStagingLifecycle(before)), /scoped append/);
    assert.throws(() => protocol.client(env, () => assert.fail()), /Production/);
    const context = { ...env, GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/native-production.yml@refs/heads/main",
        WORKER_URL: "https://forever-tee-api.socialqueue.workers.dev" };
    let current = before;
    const methods = [];
    const lifecycle = protocol.client(context, async (url, options) => {
        assert.ok(url.endsWith("/r2/buckets/forever-tee-design-artwork-production/lifecycle"));
        methods.push(options.method);
        if (options.method === "PUT")
            current = JSON.parse(options.body);
        return Response.json({ success: true, result: current });
    });
    assert.deepEqual(await lifecycle.append(plan), plan.after);
    assert.deepEqual(methods, ["GET", "PUT", "GET"]);
});
