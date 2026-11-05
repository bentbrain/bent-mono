import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProduct, productShape } from './inspect-printify-product.mjs';
const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
    GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/inspect-printify-product.yml@refs/heads/main',
    PRINTIFY_PRODUCT_ID: 'a'.repeat(24), PRINTIFY_SHOP_ID: '123', PRINTIFY_API_TOKEN: 'private-fixture-token',
};
test('inspection performs one exact GET and only returns field types', async () => {
    let calls = 0;
    const result = await inspectProduct(env, async (url, options) => {
        calls++;
        assert.equal(url, `https://api.printify.com/v1/shops/123/products/${env.PRINTIFY_PRODUCT_ID}.json`);
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert.equal(options.body, undefined);
        return Response.json({ id: env.PRINTIFY_PRODUCT_ID, shop_id: 123, title: 'private title', description: 'private description',
            variants: [{ sku: 'private SKU', cost: null }], print_areas: [{ variant_ids: [1], placeholders: [{ position: 'front', images: [{ id: 'private image', type: null }] }] }] });
    });
    assert.equal(calls, 1);
    assert.equal(result.applicationMutations, false);
    assert.equal(result.shape.variants.items[0].cost, 'null');
    assert.equal(result.shape.print_areas.items[0].placeholders.items[0].decoration_method, 'undefined');
    assert.equal(result.shape.print_areas.items[0].placeholders.items[0].images.items[0].type, 'null');
    assert.ok(!JSON.stringify(result).includes('private'));
});
test('untrusted context or target cannot make a request', async () => {
    for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_RUN_ATTEMPT: '2' },
        { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_WORKFLOW_REF: 'other' },
        { PRINTIFY_PRODUCT_ID: '../orders' }, { PRINTIFY_SHOP_ID: '../other' }, { PRINTIFY_API_TOKEN: '' }]) {
        await assert.rejects(inspectProduct({ ...env, ...change }, () => assert.fail('must not fetch')));
    }
});
test('response failures do not expose credentials or upstream bodies', async () => {
    for (const request of [async () => { throw Error(env.PRINTIFY_API_TOKEN); }, async () => new Response('private upstream', { status: 403 }),
        async () => Response.json({ id: 'other', shop_id: 123 }), async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
        await assert.rejects(inspectProduct(env, request), error => !error.message.includes('private') && !error.message.includes('upstream'));
    }
    assert.equal(productShape({ title: '' }).title, 'empty string');
});
