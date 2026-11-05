import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { configurePrintifyWebhooks } from "../workers/api/scripts/configure-printify-webhooks.mjs";
const shopId = "1234567";
const endpoint = "https://forever-tee-api.socialqueue.workers.dev/v2/webhooks/printify/order-shipment";
const baseEnv = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "bentbrain/bent-mono",
    GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: "bentbrain/bent-mono/.github/workflows/configure-printify-webhooks.yml@refs/heads/main",
    PRINTIFY_API_TOKEN: "fixture-token",
    PRINTIFY_SHOP_ID: shopId,
    PRINTIFY_WEBHOOK_OPERATION: "plan",
    PRINTIFY_WEBHOOK_SECRET: "s".repeat(64),
};
const webhook = (id, topic, url = endpoint) => ({
    id,
    shop_id: shopId,
    topic,
    url,
});
test("plan is read-only and reports fixed creates and secret refreshes", async () => {
    const calls = [];
    const request = async (url, options) => {
        calls.push({ options, url });
        return Response.json([
            webhook("shipment-created", "order:shipment:created", "https://old.invalid/webhook"),
            webhook("unrelated-topic", "order:created", "https://other.invalid/webhook"),
        ]);
    };
    const result = await configurePrintifyWebhooks(baseEnv, request);
    assert.equal(result.applicationMutations, false);
    assert.deepEqual(result.plan.map(({ action, topic }) => ({ action, topic })), [
        { action: "refresh", topic: "order:shipment:created" },
        { action: "create", topic: "order:shipment:delivered" },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "GET");
});
test("apply refreshes or creates only the fixed subscriptions and verifies readback", async () => {
    const created = webhook("shipment-created", "order:shipment:created", "https://old.invalid/webhook");
    const delivered = webhook("shipment-delivered", "order:shipment:delivered");
    const calls = [];
    const request = async (url, options) => {
        calls.push({ options, url });
        if (calls.length === 1)
            return Response.json([created]);
        if (calls.length === 2)
            return Response.json({ ...created, url: endpoint });
        if (calls.length === 3)
            return Response.json(delivered);
        return Response.json([{ ...created, url: endpoint }, delivered]);
    };
    const result = await configurePrintifyWebhooks({
        ...baseEnv,
        PRINTIFY_WEBHOOK_OPERATION: "apply",
    }, request);
    assert.equal(result.configured, true);
    assert.equal(result.secretExposed, false);
    assert.deepEqual(calls.map((call) => call.options.method), ["GET", "PUT", "POST", "GET"]);
    for (const call of calls.slice(1, 3)) {
        const body = JSON.parse(call.options.body);
        assert.equal(body.secret, baseEnv.PRINTIFY_WEBHOOK_SECRET);
        assert.equal(body.url, endpoint);
    }
    assert.deepEqual(result.subscriptions.map(({ topic }) => topic), [
        "order:shipment:created",
        "order:shipment:delivered",
    ]);
});
test("duplicates, foreign shops, malformed responses and uncertain writes fail closed", async () => {
    const created = webhook("shipment-created", "order:shipment:created");
    await assert.rejects(configurePrintifyWebhooks(baseEnv, async () => Response.json([created, { ...created, id: "shipment-created-two" }])), /duplicate/);
    await assert.rejects(configurePrintifyWebhooks({ ...baseEnv, PRINTIFY_WEBHOOK_OPERATION: "apply" }, async (_url, options) => {
        if (options.method === "GET")
            return Response.json([]);
        throw new Error(baseEnv.PRINTIFY_API_TOKEN);
    }), (error) => !error.message.includes(baseEnv.PRINTIFY_API_TOKEN));
    await assert.rejects(configurePrintifyWebhooks(baseEnv, async () => Response.json({ unexpected: true })), /inventory response was invalid/);
    await assert.rejects(configurePrintifyWebhooks({ ...baseEnv, PRINTIFY_WEBHOOK_OPERATION: "apply" }, (() => {
        let read = false;
        return async (_url, options) => {
            if (!read) {
                read = true;
                return Response.json([created, webhook("shipment-delivered", "order:shipment:delivered")]);
            }
            if (options.method === "PUT")
                return Response.json({ ...created, shop_id: "999" });
            return Response.json([]);
        };
    })()), /acknowledgement differed/);
});
test("only the exact first-attempt main workflow context can access credentials", async () => {
    for (const delta of [
        { GITHUB_REF: "refs/heads/feature" },
        { GITHUB_RUN_ATTEMPT: "2" },
        { GITHUB_REPOSITORY_ID: "other" },
        { PRINTIFY_SHOP_ID: "../other" },
        { PRINTIFY_WEBHOOK_SECRET: "short" },
    ]) {
        let called = false;
        await assert.rejects(configurePrintifyWebhooks({ ...baseEnv, ...delta }, async () => {
            called = true;
            return Response.json([]);
        }));
        assert.equal(called, false);
    }
});
