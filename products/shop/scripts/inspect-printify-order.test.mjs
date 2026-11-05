import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectOrder, orderShape } from './inspect-printify-order.mjs';
const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/inspect-printify-order.yml@refs/heads/main',
    PRINTIFY_ORDER_ID: protectedConfig("inspectionProviderOrderId"), PRINTIFY_SHOP_ID: protectedConfig("resource_a41528a2917c"), PRINTIFY_API_TOKEN: 'private-fixture-token',
};
test('inspection performs one exact GET and only returns field types', async () => {
    let calls = 0;
    const result = await inspectOrder(env, async (url, options) => {
        calls++;
        assert.equal(url, "https://api.printify.com/v1/shops/" + protectedConfig("resource_a41528a2917c") + "/orders/" + (env.PRINTIFY_ORDER_ID) + ".json");
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert.equal(options.body, undefined);
        return Response.json({ id: env.PRINTIFY_ORDER_ID, external_id: '0dec2308-c699-47f9-83c0-7a604369f869',
            address_to: { first_name: 'private name', email: 'private email', address2: null },
            line_items: [{ cost: 0, metadata: { sku: 'private SKU', price: 0 } }], shipments: [] });
    });
    assert.equal(calls, 1);
    assert.equal(result.applicationMutations, false);
    assert.equal(result.shape.address_to.address2, 'null');
    assert.equal(result.shape.line_items.items[0].cost, 'zero');
    assert.equal(result.shape.line_items.items[0].metadata.price, 'zero');
    assert.equal(result.shape.sent_to_production_at, 'undefined');
    assert.ok(!JSON.stringify(result).includes('private'));
});
test('untrusted context or target cannot make a request', async () => {
    for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_RUN_ATTEMPT: '2' },
        { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_WORKFLOW_REF: 'other' },
        { PRINTIFY_ORDER_ID: '../orders' }, { PRINTIFY_SHOP_ID: '../other' }, { PRINTIFY_API_TOKEN: '' }]) {
        await assert.rejects(inspectOrder({ ...env, ...change }, () => assert.fail('must not fetch')));
    }
});
test('response failures do not expose credentials or upstream bodies', async () => {
    for (const request of [async () => { throw Error(env.PRINTIFY_API_TOKEN); }, async () => new Response('private upstream', { status: 403 }),
        async () => Response.json({ id: 'other', shop_id: 123 }), async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
        await assert.rejects(inspectOrder(env, request), error => !error.message.includes('private') && !error.message.includes('upstream'));
    }
    assert.equal(orderShape({ status: '' }).status, 'empty string');
});
