import { protectedConfig } from "./protected-config.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryContext, runRecovery } from './paid-order-provider-recovery.mjs';
const env = {
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'bentbrain/bent-mono',
    GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_ACTOR_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '12345',
    GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/paid-order-provider-recovery.yml@refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40), OPERATIONS_ENVIRONMENT: 'production', OPERATION: 'plan',
    PAID_ORDER_ID: protectedConfig("resource_5df53ebae4ae"), WORKER_URL: 'https://forever-tee-api.socialqueue.workers.dev',
    BENT_SHIRT_OPERATIONS_SECRET: 'private-operations-fixture', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-identity-fixture',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/fixture/token',
};
const result = { fulfilmentId: protectedConfig("resource_837385716250"), providerOrderId: protectedConfig("order1003ProviderOrderId"),
    requestSha256: protectedConfig("resource_04473478c366"), ready: true, orderId: env.PAID_ORDER_ID, orderName: '#1003', planSha256: 'b'.repeat(64),
    sourceCommit: env.GITHUB_SHA, releaseId: 'native-456', runId: '12345', providerMutations: false, orderMutations: false };
test('refuses local, foreign, rerun, non-owner and unreviewed apply contexts before any request', () => {
    for (const change of [{ GITHUB_ACTIONS: 'false' }, { OPERATIONS_ENVIRONMENT: 'development' }, { PAID_ORDER_ID: '0dec2308-c699-47f9-83c0-7a604369f869' }, { GITHUB_REPOSITORY_ID: 'other' }, { GITHUB_ACTOR_ID: 'other' },
        { GITHUB_REF: 'refs/heads/branch' }, { GITHUB_RUN_ATTEMPT: '2' }, { WORKER_URL: 'https://other.example' },
        { GITHUB_WORKFLOW_REF: 'other' }, { OPERATION: 'delete' }, { PAID_ORDER_ID: 'other' }, { OPERATION: 'apply' }]) {
        assert.throws(() => recoveryContext({ ...env, ...change }), /Paid-order recovery stopped:/);
    }
});
test('saves intent before the exact signed request and persists only safe response fields', async () => {
    const saved = [], calls = [];
    const request = async (url, options) => {
        calls.push({ url: String(url), options });
        assert.equal(saved.length, 1);
        return calls.length === 1 ? Response.json({ value: 'signed-identity-fixture' })
            : Response.json({ ...result, address: 'private-address-fixture', token: 'private-token-fixture' });
    };
    const receipt = await runRecovery(env, request, async (path, body, options) => saved.push({ path, body, options }));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, `${env.WORKER_URL}/v2/internal/operations/paid-order-provider-recovery`);
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(JSON.parse(calls[1].options.body).expectedSource, env.GITHUB_SHA);
    assert.ok(new URL(calls[0].url).searchParams.get('audience').startsWith('bent-shirt:operations:production:POST:'));
    assert.deepEqual(receipt, result);
    assert.equal(saved[0].options.flag, 'wx');
    assert.equal(saved[1].options.mode, 0o600);
    assert.ok(!JSON.stringify(saved).includes('private-address-fixture'));
    assert.ok(!JSON.stringify(saved).includes('private-token-fixture'));
});
test('requires the unchanged reviewed hash and normal-verification receipt for apply', async () => {
    let calls = 0;
    const receipt = await runRecovery({ ...env, OPERATION: 'apply', EXPECTED_PLAN_SHA256: result.planSha256 }, async () => {
        calls++;
        return calls === 1 ? Response.json({ value: 'signed-identity-fixture' })
            : Response.json({ ...result, orderMutations: true, normalVerificationRequired: true });
    }, async () => { });
    assert.equal(receipt.normalVerificationRequired, true);
    assert.equal(receipt.providerMutations, false);
});
test('never retries an uncertain apply or logs an upstream failure body', async () => {
    let calls = 0;
    await assert.rejects(runRecovery({ ...env, OPERATION: 'apply', EXPECTED_PLAN_SHA256: result.planSha256 }, async () => {
        calls++;
        if (calls === 1)
            return Response.json({ value: 'signed-identity-fixture' });
        throw Error('private-provider-failure');
    }, async () => { }), /private-provider-failure/);
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(runRecovery(env, async () => {
        calls++;
        return calls === 1 ? Response.json({ value: 'signed-identity-fixture' })
            : Response.json({ address: 'private-address-fixture' }, { status: 409 });
    }, async () => { }), error => error.message.includes('HTTP 409') && !error.message.includes('private-address'));
    assert.equal(calls, 2);
});
test('rejects a drifted deployed source, target or apply result', async () => {
    for (const change of [{ fulfilmentId: 'other' }, { providerOrderId: 'other' }, { requestSha256: 'c'.repeat(64) }, { sourceCommit: 'c'.repeat(40) }, { orderId: 'other' }, { providerMutations: true },
        { planSha256: 'c'.repeat(64) }, { normalVerificationRequired: false }]) {
        let calls = 0;
        await assert.rejects(runRecovery({ ...env, OPERATION: 'apply', EXPECTED_PLAN_SHA256: result.planSha256 }, async () => {
            calls++;
            return calls === 1 ? Response.json({ value: 'signed-identity-fixture' })
                : Response.json({ ...result, orderMutations: true, normalVerificationRequired: true, ...change });
        }, async () => { }), /Paid-order recovery stopped:/);
        assert.equal(calls, 2);
    }
});
test('order 1004 recovery remains pinned to its reviewed provider and immutable request', async () => {
    const selected = { ...env, PAID_ORDER_ID: protectedConfig("resource_5ba68fa39a92") };
    const receipt = { ...result, orderId: selected.PAID_ORDER_ID, orderName: '#1004',
        fulfilmentId: protectedConfig("resource_d590174029ce"), providerOrderId: protectedConfig("order1004ProviderOrderId"),
        requestSha256: protectedConfig("resource_c7bc487d56fd") };
    for (const candidate of [receipt, result, { ...receipt, requestSha256: result.requestSha256 }]) {
        let calls = 0;
        const run = runRecovery(selected, async (url, options) => {
            calls++;
            if (calls === 1)
                return Response.json({ value: 'signed-identity-fixture' });
            assert.equal(JSON.parse(options.body).orderId, selected.PAID_ORDER_ID);
            return Response.json(candidate);
        }, async () => { });
        if (candidate === receipt)
            assert.deepEqual(await run, receipt);
        else
            await assert.rejects(run, /safe response contract differs/);
        assert.equal(calls, 2);
    }
});
