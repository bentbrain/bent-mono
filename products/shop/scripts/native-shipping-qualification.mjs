import { resolveProtectedTemplate } from "./protected-config.mjs";
import { measureReleaseStage } from "./release-stage-timing.mjs";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertActionsIdentityContext } from './native-ci-identity.mjs';
import { CLOUDFLARE_ACCOUNT } from './native-ci-cloudflare.mjs';
import { isReviewedMigrationInventory } from './native-migration-inventory.mjs';
const execute = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const check = (value, reason) => { if (!value)
    throw Error(`Shipping cloud qualification stopped: ${reason}`); };
export const shippingCases = [
    'sends one notification with both item lines for one parcel',
    'does not send a second notification for an item reported after parcel submission',
    'retains delivery received during the Shopify request and fences a second scheduler',
    'fulfils both items when separate events share a tracking number',
    'accepts overlapping and reordered SKU lists without repeating fulfilments',
    'reserves overlapping concurrent events once and retries the losing delivery',
    'does not finish an order while another reserved parcel is still failed',
    'creates exact split-product fulfilments and ignores duplicate lifecycle events',
    'handles delivery-before-created ordering without a duplicate fulfilment',
    'rejects an invalid signature before persistence',
    'retries a safely failed Shopify read from the scheduled reconciler',
    'fences an expired Shopify mutation lease without retrying it',
];
export const paidOrderCases = [
    ...['complete', 'null company', 'missing shipments', 'missing production timestamp', 'phone prefix', 'provider phone when omitted', 'observed pending response']
        .map(shape => `creates, verifies, and submits one exact Printify order idempotently: ${shape}`),
    ...['address', 'phone digits', 'missing phone', 'SKU', 'production timestamp', 'provider', 'malformed shipments']
        .map(shape => `never submits a mismatched order readback: ${shape}`),
    'verifies a provider product with expanded readback without recreating it',
    'verifies a provider product with create acknowledgement without recreating it',
    'retries a catalogue refresh overlap at 60 minutes without a permanent exception',
    'keeps pending fraud retryable after hold expiry',
    'routes an invalid address to a stable exception at hold expiry',
    'fences an expired order mutation lease for manual reconciliation',
];
export function verifyPaidOrderTestReport(report) {
    const passed = (report.testResults ?? []).flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'passed');
    check(report.success === true && report.numPassedTests === shippingCases.length + paidOrderCases.length &&
        passed.length === shippingCases.length + paidOrderCases.length &&
        [...shippingCases, ...paidOrderCases].every(name => passed.filter(test => test.title === name).length === 1), 'complete paid-order, provider-contract, mutation-fence and shipping journey required');
    return passed.map(test => ({ name: test.title, passed: true, durationMs: test.duration ?? null }));
}
export function verifyShippingTestReport(report) {
    const passed = (report.testResults ?? []).flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'passed');
    check(report.success === true && report.numPassedTests === shippingCases.length && passed.length === shippingCases.length &&
        shippingCases.every(name => passed.some(test => test.title === name && test.fullName.includes('Printify shipment reconciliation'))), 'every signed-webhook, reservation, scheduler and notification-sink scenario must pass');
    return passed.map(test => ({ name: test.title, passed: true, durationMs: test.duration ?? null }));
}
export function shippingTestFailureSummary(report, error, env) {
    const secrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|KEY/.test(key) && typeof value === 'string' && value.length > 0).map(([, value]) => value);
    const redact = value => {
        let text = typeof value === 'string' ? value : '';
        for (const secret of secrets)
            text = text.split(secret).join('<REDACTED>');
        return text.replace(/https?:\/\/[^\s"'<>]+/g, '<URL REDACTED>')
            .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer <REDACTED>').slice(0, 4000);
    };
    const files = Array.isArray(report?.testResults) ? report.testResults : [];
    return { schemaVersion: 1, reportAvailable: !!report,
        exitCode: Number.isInteger(error?.code) ? error.code : null,
        signal: ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(error?.signal) ? error.signal : null,
        suiteFailures: files.filter(file => file.message).slice(0, 4).map(file => redact(file.message)),
        failedTests: files.flatMap(file => Array.isArray(file.assertionResults) ? file.assertionResults : [])
            .filter(test => test.status === 'failed' && [...shippingCases, ...paidOrderCases].includes(test.title)).slice(0, shippingCases.length + paidOrderCases.length)
            .map(test => ({ name: test.title, messages: (Array.isArray(test.failureMessages) ? test.failureMessages : []).slice(0, 2).map(redact) })),
    };
}
export async function runShippingTestProcess(run, args, options, reportPath, store, env) {
    try {
        await run(process.execPath, args, options);
    }
    catch (error) {
        let report;
        try {
            report = JSON.parse(resolveProtectedTemplate(await readFile(reportPath, 'utf8')));
        }
        catch { /* Process startup failures may have no report. */ }
        const diagnostics = shippingTestFailureSummary(report, error, env);
        // Never print the child error or stdout/stderr: remote binding URLs and
        // credentials can appear there. Only bounded, redacted test messages survive.
        console.error(JSON.stringify({ shippingTestFailure: diagnostics }));
        await store.save('qualification-shipping-failure.json', Buffer.from(JSON.stringify(diagnostics)));
        throw Error('Shipping qualification tests failed; see the redacted failure evidence. No provider credentials were supplied to the test process.');
    }
}
export function shippingDatabaseClient(env, request = fetch) {
    assertActionsIdentityContext(env);
    check(env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_RUN_ATTEMPT === '1' &&
        env.GITHUB_WORKFLOW_REF === 'bentbrain/bent-mono/.github/workflows/native-development.yml@refs/heads/main' &&
        ['qualify-all', 'qualify-components'].includes(env.NATIVE_OPERATION) && env.CLOUDFLARE_ACCOUNT_ID === CLOUDFLARE_ACCOUNT &&
        env.CLOUDFLARE_API_TOKEN && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? ''), 'explicit personal Development qualification context');
    const name = `forever-tee-shipping-qualification-${env.GITHUB_RUN_ID}`;
    const api = async (path, body, method = body ? 'POST' : 'GET', allowMissing = false) => {
        const response = await request(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT}/d1/database${path}`, {
            method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        if (allowMissing && response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        check(response.ok, `D1 request returned ${response.status}`);
        const value = await response.json();
        check(value.success === true, 'D1 acknowledgement');
        return value.result;
    };
    let ownedId;
    return { name, createdId: () => ownedId,
        create: async (store) => {
            const databases = await api('?per_page=100');
            check(Array.isArray(databases) && databases.length < 100 && !databases.some(db => db.name.startsWith('forever-tee-shipping-qualification-')), 'a previous qualification database needs cleanup before another can be created');
            await store.save('qualification-shipping-database-intent.json', Buffer.from(JSON.stringify({ schemaVersion: 1, name, runId: env.GITHUB_RUN_ID, sourceCommit: env.GITHUB_SHA, accountId: CLOUDFLARE_ACCOUNT })));
            const created = await api('', { name, primary_location_hint: 'oc' });
            check(created.name === name && /^[a-f0-9-]{36}$/.test(created.uuid), 'new isolated database identity');
            ownedId = created.uuid;
            await store.save('qualification-shipping-database-created.json', Buffer.from(JSON.stringify({ name, id: ownedId, runId: env.GITHUB_RUN_ID })));
            return ownedId;
        },
        query: async (sql, params = []) => {
            check(ownedId, 'only this run newly created database may be queried');
            const result = await api(`/${ownedId}/query`, { sql, params });
            check(Array.isArray(result) && result.length > 0 && result.every(item => item.success), 'complete isolated D1 query');
            return result;
        },
        batch: async (statements) => {
            check(ownedId && statements.length > 0 && statements.length <= 100, 'bounded isolated D1 batch');
            const result = await api(`/${ownedId}/query`, { batch: statements });
            check(Array.isArray(result) && result.length === statements.length && result.every(item => item.success), 'isolated migration transaction');
        },
        remove: async () => {
            check(ownedId, 'no database creation was acknowledged');
            const database = await api(`/${ownedId}`);
            check(database?.uuid === ownedId && database.name === name, 'only this run database can be deleted');
            let uncertain;
            try {
                await api(`/${ownedId}`, undefined, 'DELETE');
            }
            catch (error) {
                uncertain = error;
            }
            const remaining = await api(`/${ownedId}`, undefined, 'GET', true);
            check(remaining === null, uncertain ? 'database deletion acknowledgement uncertain; inspect the saved creation receipt' : 'database still exists after deletion');
            return { databaseDeleted: true, databaseId: ownedId, name };
        } };
}
export async function qualifyShippingDatabase(env, store, { request = fetch, run = execute, pair, paidJourney = false } = {}) {
    check(pair?.releaseId === env.NATIVE_VERIFY_RELEASE && pair.sourceCommit === env.GITHUB_SHA && /^sha256:[a-f0-9]{64}$/.test(pair.imageDigest ?? ''), 'exact deployed pair for the test source');
    const client = shippingDatabaseClient(env, request);
    check(env.RUNNER_TEMP?.startsWith('/'), 'private runner directory');
    const directory = join(env.RUNNER_TEMP, 'shipping-qualification');
    await mkdir(directory, { recursive: false, mode: 0o700 });
    let databaseId, report, failure, cleanup;
    try {
        databaseId = await client.create(store);
        const nonce = randomUUID();
        await client.query('CREATE TABLE shipping_qualification_proof(singleton INTEGER PRIMARY KEY,run_id TEXT,nonce TEXT,connected INTEGER)');
        await client.query('INSERT INTO shipping_qualification_proof VALUES(1,?,?,0)', [env.GITHUB_RUN_ID, nonce]);
        const migrations = (await readdir(join(root, 'workers/api/drizzle'))).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
        check(isReviewedMigrationInventory(migrations), 'reviewed complete schema required');
        for (const name of migrations) {
            const sql = await readFile(join(root, 'workers/api/drizzle', name), 'utf8');
            const statements = sql.split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean).map(sql => ({ sql, params: [] }));
            await client.batch(statements);
        }
        const config = { name: `shipping-qualification-${env.GITHUB_RUN_ID}`, account_id: CLOUDFLARE_ACCOUNT,
            compatibility_date: '2026-08-12', compatibility_flags: ['nodejs_compat'],
            d1_databases: [{ binding: 'DB', database_name: client.name, database_id: databaseId, remote: true }],
            r2_buckets: [{ binding: 'DESIGN_ARTWORK', bucket_name: 'shipping-qualification-artwork', remote: false }] };
        const configPath = join(directory, 'wrangler.json'), reportPath = join(directory, 'results.json');
        await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
        const childEnv = Object.fromEntries(['PATH', 'HOME', 'CI', 'RUNNER_TEMP', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID',
            'GITHUB_REPOSITORY_OWNER_ID', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF',
            'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].flatMap(key => typeof env[key] === 'string' ? [[key, env[key]]] : []));
        Object.assign(childEnv, { NATIVE_SHIPPING_QUALIFICATION_CONFIG: configPath, NATIVE_SHIPPING_DATABASE_ID: databaseId, NATIVE_SHIPPING_DATABASE_NONCE: nonce });
        const selected = paidJourney ? [...shippingCases, ...paidOrderCases] : shippingCases;
        const pattern = `(?:${selected.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
        await runShippingTestProcess(run, [join(root, 'workers/api/node_modules/vitest/vitest.mjs'), 'run', 'src/shopify-webhooks.test.ts',
            '--testNamePattern', pattern, '--reporter=json', `--outputFile=${reportPath}`, '--testTimeout=60000', '--hookTimeout=120000'], { cwd: join(root, 'workers/api'), env: childEnv, timeout: 600000, maxBuffer: 2 * 1024 * 1024 }, reportPath, store, childEnv);
        const tests = (paidJourney ? verifyPaidOrderTestReport : verifyShippingTestReport)(JSON.parse(resolveProtectedTemplate(await readFile(reportPath, 'utf8'))));
        const proof = (await client.query('SELECT run_id,nonce,connected FROM shipping_qualification_proof WHERE singleton=1'))[0].results;
        check(proof.length === 1 && proof[0].run_id === env.GITHUB_RUN_ID && proof[0].nonce === nonce && proof[0].connected === 1, 'the suite must exercise the real isolated Development D1 database');
        report = { schemaVersion: 1, cloudShippingQualification: true, runId: env.GITHUB_RUN_ID, sourceCommit: env.GITHUB_SHA, releaseId: pair.releaseId, imageDigest: pair.imageDigest, databaseId,
            tests, ...(paidJourney ? { paidOrderJourneyVerified: true, providerSink: 'in-process-simulated-printify', providerMutations: 0 } : {}), notificationSink: 'in-process-simulated-shopify', customerNotificationsSent: 0 };
    }
    catch (error) {
        failure = error;
    }
    finally {
        databaseId ??= client.createdId();
        if (databaseId) {
            try {
                cleanup = await measureReleaseStage("shipping-database-cleanup", () => client.remove());
            }
            catch (error) {
                failure ??= error;
            }
        }
    }
    if (failure)
        throw failure;
    const evidence = await store.save('qualification-shipping-report.json', Buffer.from(JSON.stringify({ ...report, cleanup })));
    return { ...report, cleanup, evidence };
}
