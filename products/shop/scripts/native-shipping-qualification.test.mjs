import { protectedConfig } from "./protected-config.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shippingDatabaseClient, shippingCases, verifyShippingTestReport } from './native-shipping-qualification.mjs';
import * as qualification from './native-shipping-qualification.mjs';
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"),
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main', NATIVE_OPERATION: 'qualify-all',
    CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"), CLOUDFLARE_API_TOKEN: 'fixture' };
async function exerciseShippingLaunch(t, inspect) {
    const directory = await mkdtemp(join(tmpdir(), 'shipping-launch-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const id = '11111111-1111-4111-8111-111111111111', name = `forever-tee-shipping-qualification-${env.GITHUB_RUN_ID}`;
    let nonce, deleted = false, launched = false;
    const request = async (url, options) => {
        let result;
        if (options.method === 'DELETE') { deleted = true; return Response.json({ success: true }); }
        if (url.endsWith('/query')) {
            const body = JSON.parse(options.body);
            if (body.sql?.startsWith('INSERT INTO shipping_qualification_proof')) nonce = body.params[1];
            result = body.batch ? body.batch.map(() => ({ success: true })) : [{ success: true,
                results: body.sql?.startsWith('SELECT run_id') ? [{ run_id: env.GITHUB_RUN_ID, nonce, connected: 1 }] : [] }];
        }
        else if (options.method === 'POST') result = { uuid: id, name };
        else if (url.endsWith(`/${id}`)) {
            if (deleted) return new Response(null, { status: 404 });
            result = { uuid: id, name };
        }
        else result = [];
        return Response.json({ success: true, result });
    };
    const run = async (command, args, options) => {
        launched = true;
        await inspect(command, args, options);
        const results = [...shippingCases, ...qualification.paidOrderCases].map(title => ({ title, fullName: title, status: 'passed' }));
        const report = args.find(value => value.startsWith('--outputFile=')).slice('--outputFile='.length);
        await writeFile(report, JSON.stringify({ success: true, numPassedTests: results.length, testResults: [{ assertionResults: results }] }));
    };
    const report = await qualification.qualifyShippingDatabase({ ...env, PATH: process.env.PATH, RUNNER_TEMP: directory,
        NATIVE_VERIFY_RELEASE: 'native-123', SHOP_PROTECTED_CONFIG_JSON: process.env.SHOP_PROTECTED_CONFIG_JSON,
        PRINTIFY_API_TOKEN: 'synthetic-merchant-secret', SHOP_EVIDENCE_ENCRYPTION_KEY: 'synthetic-evidence-secret' },
        { save: async () => ({ synthetic: true }) }, { request, run, paidJourney: true,
            pair: { releaseId: 'native-123', sourceCommit: env.GITHUB_SHA, imageDigest: `sha256:${'a'.repeat(64)}` } });
    assert.equal(launched, true);
    assert.equal(deleted, true);
    assert.equal(report.tests.length, 32);
}
test('shipping qualification launches the installed Vitest CLI through the real subprocess boundary', async t => {
    await exerciseShippingLaunch(t, async (command, args, options) => {
        const result = await promisify(execFile)(command, [args[0], '--version'], options);
        assert.match(result.stdout, /vitest\/4\./);
        assert.equal(args[1], 'run');
        assert.equal(args[2], 'src/shopify-webhooks.test.ts');
        const pattern = new RegExp(args[args.indexOf('--testNamePattern') + 1]);
        for (const name of [...shippingCases, ...qualification.paidOrderCases]) assert.match(name, pattern);
    });
});
test('shipping qualification supplies only guarded identities alongside synthetic provider configuration', async t => {
    const fixtures = JSON.parse(await readFile(new URL('./protected-config.fixtures.json', import.meta.url), 'utf8'));
    const keys = ['cloudflareAccountId', 'githubRepositoryId', 'githubOwnerId', 'resource_fb377032d2f5', 'resource_1a1378f0d1dc'];
    await exerciseShippingLaunch(t, async (command, _args, options) => {
        assert.equal(typeof options.env.SHOP_PROTECTED_CONFIG_JSON, 'string');
        const expected = { ...fixtures, ...Object.fromEntries(keys.map(key => [key, protectedConfig(key)])) };
        assert.deepEqual(JSON.parse(options.env.SHOP_PROTECTED_CONFIG_JSON), expected);
        assert.equal(options.env.PRINTIFY_API_TOKEN, undefined);
        assert.equal(options.env.SHOP_EVIDENCE_ENCRYPTION_KEY, undefined);
        const setup = new URL('./test-protected-config.mjs', import.meta.url).href;
        const reader = new URL('../workers/api/src/protected-config.ts', import.meta.url).href;
        const script = `await import(${JSON.stringify(setup)}); const {protectedConfig}=await import(${JSON.stringify(reader)}); process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,protectedConfig(key)]))));`;
        const result = await promisify(execFile)(command, ['--input-type=module', '-e', script], options);
        assert.deepEqual(JSON.parse(result.stdout), Object.fromEntries(keys.map(key => [key, protectedConfig(key)])));
        assert.equal(options.cwd, fileURLToPath(new URL('../workers/api', import.meta.url)));
    });
});
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
