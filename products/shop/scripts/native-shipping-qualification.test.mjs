import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shippingDatabaseClient, shippingCases, verifyShippingTestReport } from './native-shipping-qualification.mjs';
import * as qualification from './native-shipping-qualification.mjs';
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main', NATIVE_OPERATION: 'qualify-all',
    CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"), CLOUDFLARE_API_TOKEN: 'fixture' };
test('remote qualification refuses local execution, other accounts, reruns and ordinary release operations', () => {
    for (const delta of [{ GITHUB_ACTIONS: 'false' }, { CLOUDFLARE_ACCOUNT_ID: 'work' }, { GITHUB_RUN_ATTEMPT: '2' }, { NATIVE_OPERATION: 'release' }])
        assert.throws(() => shippingDatabaseClient({ ...env, ...delta }));
});
test('database creation has durable intent and never touches a live database', async () => {
    const saved = [], calls = [], id = '11111111-1111-4111-8111-111111111111', name = 'forever-tee-shipping-qualification-123';
    let deleted = false;
    const cf = shippingDatabaseClient(env, async (url, options) => {
        calls.push({ url, method: options.method });
        assert.ok(url.includes(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database`));
        if (options.method === 'POST' && !url.endsWith('/query')) {
            assert.deepEqual(saved, ['qualification-shipping-database-intent.json']);
            return Response.json({ success: true, result: { uuid: id, name } });
        }
        if (options.method === 'DELETE') {
            deleted = true;
            return Response.json({ success: true });
        }
        if (url.endsWith(`/${id}`))
            return deleted ? new Response(null, { status: 404 }) : Response.json({ success: true, result: { uuid: id, name } });
        return Response.json({ success: true, result: [] });
    });
    await cf.create({ save: async (name) => saved.push(name) });
    assert.equal(cf.createdId(), id);
    assert.equal((await cf.remove()).databaseDeleted, true);
    assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
    assert.ok(calls.every(call => !call.url.includes(protectedConfig("resource_fb377032d2f5"))));
});
test('a stranded prior qualification blocks new creation instead of deleting by name', async () => {
    let mutations = 0;
    const cf = shippingDatabaseClient(env, async (_url, options) => { if (options.method !== 'GET')
        mutations++; return Response.json({ success: true, result: [{ name: 'forever-tee-shipping-qualification-122' }] }); });
    await assert.rejects(cf.create({ save: async () => { throw Error('must not save'); } }), /previous qualification/);
    assert.equal(mutations, 0);
});
test('a partial or skipped shipping suite cannot establish qualification', () => {
    const passed = shippingCases.map(title => ({ title, fullName: `Printify shipment reconciliation ${title}`, status: 'passed', duration: 10 }));
    const report = { success: true, numPassedTests: shippingCases.length, testResults: [{ assertionResults: passed }] };
    assert.equal(verifyShippingTestReport(report).length, shippingCases.length);
    assert.throws(() => verifyShippingTestReport({ ...report, numPassedTests: 1 }));
    assert.throws(() => verifyShippingTestReport({ ...report, testResults: [{ assertionResults: passed.slice(1) }] }));
});
test('failed shipping diagnostics preserve the failing case and remove credentials and URLs', () => {
    const secret = 'fixture-private-cloudflare-token';
    const report = { success: false, numPassedTests: 11, numFailedTests: 1, testResults: [{
                message: `Hook failed: Authorization: Bearer ${secret} at https://remote.example/session/private-token`,
                assertionResults: [{ title: shippingCases[0], status: 'failed', failureMessages: [
                            `D1_ERROR: fetch failed; token=${secret}; https://remote.example/?secret=another-token`,
                        ] }, { title: 'unexpected untrusted title with private data', status: 'failed', failureMessages: ['ignored'] }],
            }] };
    const summary = qualification.shippingTestFailureSummary(report, { code: 1, signal: null, stderr: `private ${secret}` }, { CLOUDFLARE_API_TOKEN: secret });
    const text = JSON.stringify(summary);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.failedTests[0].name, shippingCases[0]);
    assert.match(text, /D1_ERROR: fetch failed/);
    for (const sensitive of [secret, 'private-token', 'another-token', 'unexpected untrusted', 'stderr'])
        assert.ok(!text.includes(sensitive));
    assert.match(text, /REDACTED/);
});
test('a failed child test process saves sanitized evidence and still blocks qualification', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'shipping-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const reportPath = join(directory, 'results.json'), saved = [], logged = [];
    t.mock.method(console, 'error', value => logged.push(value));
    const child = async () => {
        await writeFile(reportPath, JSON.stringify({ testResults: [{ message: 'Hook timed out in 120000ms.', assertionResults: [] }] }));
        throw Object.assign(new Error('private child output'), { code: 1, stderr: 'must not be logged' });
    };
    await assert.rejects(qualification.runShippingTestProcess(child, [], {}, reportPath, { save: async (name, body) => saved.push({ name, body: JSON.parse(body) }) }, {}), /Shipping qualification tests failed/);
    assert.equal(saved[0].name, 'qualification-shipping-failure.json');
    assert.deepEqual(saved[0].body.suiteFailures, ['Hook timed out in 120000ms.']);
    assert.equal(saved[0].body.exitCode, 1);
    assert.ok(!JSON.stringify(logged).includes('must not be logged'));
    assert.ok(!JSON.stringify(logged).includes('private child output'));
});
test('paid-order qualification refuses skipped provider and submission regressions', () => {
    const passed = [...shippingCases, ...qualification.paidOrderCases].map(title => ({ title, fullName: title, status: 'passed', duration: 1 }));
    const report = { success: true, numPassedTests: passed.length, testResults: [{ assertionResults: passed }] };
    assert.equal(qualification.verifyPaidOrderTestReport(report).length, 32);
    for (const title of ['creates, verifies, and submits one exact Printify order idempotently: provider phone when omitted',
        'verifies a provider product with expanded readback without recreating it',
        'retries a catalogue refresh overlap at 60 minutes without a permanent exception']) {
        const skipped = passed.map(row => row.title === title ? { ...row, status: 'skipped' } : row);
        assert.throws(() => qualification.verifyPaidOrderTestReport({ ...report, testResults: [{ assertionResults: skipped }] }));
    }
});
