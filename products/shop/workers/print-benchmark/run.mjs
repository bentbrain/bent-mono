import { protectedConfig } from "../../scripts/protected-config.mjs";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { comparePrints } from './runtime/compare.mjs';
import { ACCOUNT, REGION, FUNCTION, FUNCTION_ARN, BUCKET, PREFIX, CI_ROLE, RUNTIME_ROLE, check } from './runtime/contract.mjs';
import { platformReport, settledPair } from './metrics.mjs';
const execute = promisify(execFile), env = process.env, root = '.data/print-benchmark';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'bentbrain/bent-mono' &&
    env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") && env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") &&
    env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_RUN_ATTEMPT === '1' &&
    env.GITHUB_WORKFLOW_REF === 'bentbrain/bent-mono/.github/workflows/print-lambda-benchmark.yml@refs/heads/main' &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && env.RELEASE_EXPECTED_SOURCE === env.GITHUB_SHA, 'first-attempt main benchmark workflow');
check(env.AWS_REGION === REGION && env.AWS_DEFAULT_REGION === REGION &&
    ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'CLOUDFLARE_API_TOKEN'].every(key => typeof env[key] === 'string' && env[key].length), 'explicit credentials');
await mkdir(root, { recursive: true, mode: 0o700 });
const childEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN,
    AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION, AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_PAGER: '', AWS_MAX_ATTEMPTS: '1' };
const aws = async (args) => {
    try {
        const result = await execute('aws', [...args, '--region', REGION, '--output', 'json', '--no-cli-pager'], { env: childEnv, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
        return result.stdout.trim() ? JSON.parse(result.stdout) : {};
    }
    catch (error) {
        const code = typeof error.stderr === 'string' ? /\(([A-Za-z0-9]+)\) when calling/.exec(error.stderr)?.[1] : null;
        throw Object.assign(new Error('Scoped print benchmark AWS request failed.'), { code });
    }
};
const identity = await aws(['sts', 'get-caller-identity']);
check(identity.Account === ACCOUNT && identity.Arn === `arn:aws:sts::${ACCOUNT}:assumed-role/${CI_ROLE}/print-${env.GITHUB_RUN_ID}`, 'scoped CI role');
const bucketArgs = ['--bucket', BUCKET, '--expected-bucket-owner', ACCOUNT];
check((await aws(['s3api', 'get-bucket-versioning', ...bucketArgs])).Status === 'Enabled', 'versioned benchmark storage');
const access = await aws(['s3api', 'get-public-access-block', ...bucketArgs]);
check(['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].every(key => access.PublicAccessBlockConfiguration?.[key] === true), 'private storage');
try {
    await aws(['lambda', 'get-function', '--function-name', FUNCTION]);
    throw new Error('Existing benchmark function requires inspection; no takeover.');
}
catch (error) {
    if (error.code !== 'ResourceNotFoundException')
        throw error;
}
const report = { schemaVersion: 1, kind: 'isolated Lambda feasibility; excludes application queue and R2 publication',
    sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, memoryMB: 3008, architecture: 'x86_64', runtime: 'nodejs24.x',
    samples: [], concurrentCohorts: [], comparisons: [], cleanupComplete: false };
const save = () => writeFile(`${root}/report.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const versions = [], fixtures = JSON.parse(await readFile(new URL('./runtime/plans.json', import.meta.url), 'utf8'));
let created = false, creationAttempted = false;
const cfRoot = "https://api.cloudflare.com/client/v4/accounts/" + protectedConfig("cloudflareAccountId");
const cf = async (path, body) => {
    const response = await fetch(cfRoot + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    check(response.ok, `Development fixture read HTTP ${response.status}`);
    return response;
};
const readObject = async (key, sha, maxBytes) => {
    check(/^designs\/[a-f0-9-]{36}\/artwork\/[a-f0-9]{64}$/.test(key) || /^print-assets\/blobs\/[a-f0-9]{64}\.png$/.test(key), 'read-only fixture object');
    const response = await cf(`/r2/buckets/forever-tee-design-artwork-development/objects/${key}`);
    const chunks = [];
    let count = 0;
    for await (const chunk of response.body) {
        count += chunk.length;
        check(count <= maxBytes, 'bounded fixture response');
        chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    check(hash(bytes) === sha, 'fixture checksum');
    return bytes;
};
const put = async (key, path) => {
    const result = await aws(['s3api', 'put-object', ...bucketArgs, '--key', key, '--body', path, '--if-none-match', '*']);
    check(result.VersionId && result.VersionId !== 'null', 'input version acknowledgement');
    versions.push({ key, version: result.VersionId });
    await writeFile(`${root}/cleanup-inventory.json`, JSON.stringify(versions));
    return result;
};
try {
    for (const fixture of fixtures) {
        const data = await (await cf("/d1/database/" + protectedConfig("resource_fb377032d2f5") + "/query", {
            sql: "SELECT artwork_key FROM designs WHERE sha256=? AND status='ready' AND deleted_at IS NULL ORDER BY created_at LIMIT 1", params: [fixture.sha256]
        })).json();
        check(data.success && data.result?.[0]?.results?.length === 1, 'existing approved fixture');
        const bytes = await readObject(data.result[0].results[0].artwork_key, fixture.sha256, fixture.bytes);
        const path = `${root}/${fixture.name}.png`;
        await writeFile(path, bytes, { mode: 0o600 });
        await put(`${PREFIX}${env.GITHUB_RUN_ID}/inputs/${fixture.sha256}.png`, path);
        for (const geometry of fixture.geometries) {
            check(/^[a-f0-9]{64}$/.test(geometry.baselineSha256) && typeof geometry.baselineVersion === 'string' &&
                geometry.baselineVersion.length > 0 && geometry.baselineVersion !== 'null', 'immutable reference version');
            const path = `${root}/baseline-${fixture.name}-${geometry.width}.png`;
            await aws(['s3api', 'get-object', ...bucketArgs, '--key', `${PREFIX}baselines/${geometry.baselineSha256}.png`,
                '--version-id', geometry.baselineVersion, path]);
            const baseline = await readFile(path);
            check(baseline.length <= 30000000 && hash(baseline) === geometry.baselineSha256, 'immutable reference checksum');
        }
    }
    await execute('zip', ['-qr', `${process.cwd()}/${root}/function.zip`, 'handler.mjs', 'contract.mjs', 'render.mjs', 'plans.json', 'package.json', 'package-lock.json', 'node_modules'], { cwd: new URL('./runtime/', import.meta.url), timeout: 60000 });
    const zip = await readFile(`${root}/function.zip`), codeKey = `${PREFIX}${env.GITHUB_RUN_ID}/function.zip`;
    const uploaded = await put(codeKey, `${root}/function.zip`);
    const code = JSON.stringify({ S3Bucket: BUCKET, S3Key: codeKey, S3ObjectVersion: uploaded.VersionId });
    try {
        await aws(['logs', 'create-log-group', '--log-group-name', `/aws/lambda/${FUNCTION}`]);
    }
    catch (error) {
        if (error.code !== 'ResourceAlreadyExistsException')
            throw error;
    }
    await aws(['logs', 'put-retention-policy', '--log-group-name', `/aws/lambda/${FUNCTION}`, '--retention-in-days', '7']);
    await writeFile(`${root}/create-intent.json`, JSON.stringify({ function: FUNCTION_ARN, codeSha256: hash(zip), runId: env.GITHUB_RUN_ID }));
    creationAttempted = true;
    const result = await aws(['lambda', 'create-function', '--function-name', FUNCTION, '--runtime', 'nodejs24.x', '--architectures', 'x86_64',
        '--handler', 'handler.handler', '--role', `arn:aws:iam::${ACCOUNT}:role/${RUNTIME_ROLE}`, '--code', code, '--memory-size', '3008', '--timeout', '60',
        '--tags', JSON.stringify({ Purpose: 'isolated-print-benchmark', RunId: env.GITHUB_RUN_ID, Source: env.GITHUB_SHA })]);
    check(result.FunctionArn === FUNCTION_ARN && result.CodeSha256 === createHash('sha256').update(zip).digest('base64'), 'created function identity and code');
    created = true;
    await aws(['lambda', 'put-function-concurrency', '--function-name', FUNCTION, '--reserved-concurrent-executions', '2']);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
        const config = await aws(['lambda', 'get-function-configuration', '--function-name', FUNCTION]);
        check(config.FunctionArn === FUNCTION_ARN && config.MemorySize === 3008 && config.Timeout === 60 && config.Role === `arn:aws:iam::${ACCOUNT}:role/${RUNTIME_ROLE}`, 'exact isolated function configuration');
        if (config.State === 'Active' && config.LastUpdateStatus === 'Successful') {
            ready = true;
            break;
        }
        check(config.State !== 'Failed' && config.LastUpdateStatus !== 'Failed', 'function startup');
        await setTimeout(2000);
    }
    check(ready && (await aws(['lambda', 'get-function-concurrency', '--function-name', FUNCTION])).ReservedConcurrentExecutions === 2, 'bounded active capacity');
    const invoke = async (fixture, cohort) => {
        const invocation = randomBytes(16).toString('hex'), path = `${root}/response-${invocation}.json`;
        const started = performance.now();
        const result = await aws(['lambda', 'invoke', '--function-name', FUNCTION, '--invocation-type', 'RequestResponse', '--log-type', 'Tail',
            '--cli-binary-format', 'raw-in-base64-out', '--payload', JSON.stringify({ fixture: fixture.name, runId: env.GITHUB_RUN_ID, invocation }), path]);
        const endToEndMs = performance.now() - started;
        check(result.StatusCode === 200 && !result.FunctionError, 'successful render invocation');
        const response = JSON.parse(await readFile(path, 'utf8'));
        check(response.fixture === fixture.name && response.outputs?.length === 3, 'complete stored print response');
        for (const output of response.outputs) {
            check(output.key === `${PREFIX}${env.GITHUB_RUN_ID}/outputs/${invocation}/${output.width}x${output.height}.png` &&
                /^[a-f0-9]{64}$/.test(output.sha256) && output.version && output.version !== 'null', 'owned output');
            versions.push({ key: output.key, version: output.version });
        }
        await writeFile(`${root}/cleanup-inventory.json`, JSON.stringify(versions));
        const log = Buffer.from(result.LogResult ?? '', 'base64').toString('utf8');
        const platform = platformReport(log, response.requestId);
        const sample = { cohort, endToEndMs, platform, ...response };
        report.samples.push(sample);
        await save();
        console.info(JSON.stringify({ fixture: fixture.name, cohort, endToEndMs, handlerMs: response.handlerMs, platform }));
        return sample;
    };
    for (const fixture of fixtures) {
        for (let round = 0; round < 3; round++)
            await invoke(fixture, round === 0 ? 'first-for-fixture' : 'sequential');
        const pair = await settledPair(() => invoke(fixture, 'two-concurrent'));
        const overlapMs = Math.min(...pair.map(sample => sample.completedAt)) - Math.max(...pair.map(sample => sample.startedAt));
        report.concurrentCohorts.push({ fixture: fixture.name, overlapMs, note: 'Handler wall-clock overlap; cross-runtime clock skew limits precision.' });
        check(Number.isFinite(overlapMs) && overlapMs > 0, 'actual concurrent handler overlap');
    }
    for (const fixture of fixtures) {
        const sample = report.samples.find(item => item.fixture === fixture.name);
        for (const output of sample.outputs) {
            const path = `${root}/native-${fixture.name}-${output.width}.png`;
            await aws(['s3api', 'get-object', ...bucketArgs, '--key', output.key, '--version-id', output.version, path]);
            const bytes = await readFile(path);
            check(hash(bytes) === output.sha256 && bytes.length === output.bytes, 'downloaded output integrity');
            report.comparisons.push({ fixture: fixture.name, width: output.width, height: output.height,
                ...await comparePrints(bytes, `${root}/baseline-${fixture.name}-${output.width}.png`) });
        }
    }
    report.completed = true;
}
catch (error) {
    report.completed = false;
    report.failure = error.code ?? (error.message.startsWith('Print benchmark rejected:') ? error.message : 'Benchmark operation failed; inspect saved inventory.');
    process.exitCode = 1;
}
finally {
    // Only a positively identified function from this run may be removed.
    try {
        if (created) {
            const current = await aws(['lambda', 'get-function', '--function-name', FUNCTION]);
            check(current.Configuration?.FunctionArn === FUNCTION_ARN && current.Tags?.RunId === env.GITHUB_RUN_ID && current.Tags?.Source === env.GITHUB_SHA, 'cleanup ownership');
            await aws(['lambda', 'delete-function', '--function-name', FUNCTION]);
            try {
                await aws(['lambda', 'get-function', '--function-name', FUNCTION]);
                throw new Error('Function cleanup not confirmed.');
            }
            catch (error) {
                if (error.code !== 'ResourceNotFoundException')
                    throw error;
            }
        }
        else
            check(!creationAttempted, 'uncertain function creation requires inspection');
        report.cleanupComplete = created;
    }
    catch {
        report.cleanupComplete = false;
        report.cleanupFailure = 'Function cleanup not confirmed; inspect exact run intent before recovery.';
        process.exitCode = 1;
    }
    // Keep checksummed fixture/output versions private for quality review and a later exact-inventory cleanup.
    report.functionCreated = created;
    report.functionCreationAttempted = creationAttempted;
    report.retainedPrivateVersions = versions;
    await save();
}
