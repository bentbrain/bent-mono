import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateInvocation, assertRuntime, FUNCTION, FUNCTION_ARN } from '../workers/print-benchmark/runtime/contract.mjs';
import { platformReport, settledPair } from '../workers/print-benchmark/metrics.mjs';
test('platform metrics bind to one invocation and preserve unknown cold initialization', () => {
    const id = 'a'.repeat(8) + '-1111-2222-3333-' + 'b'.repeat(12);
    const line = `REPORT RequestId: ${id}\tDuration: 100.1 ms\tBilled Duration: 101 ms\tMemory Size: 3008 MB\tMax Memory Used: 900 MB`;
    assert.deepEqual(platformReport(line, id), { durationMs: 100.1, billedMs: 101, initMs: null, maxMemoryMB: 900 });
    assert.equal(platformReport(line + '\tInit Duration: 456.2 ms', id).initMs, 456.2);
    assert.throws(() => platformReport(line, id.replace('1111', '5555')));
    assert.throws(() => platformReport(line.replace('Billed Duration', 'Unknown'), id));
});
test('concurrent failure waits for the other invocation before function cleanup', async () => {
    let calls = 0, secondFinished = false;
    await assert.rejects(settledPair(async () => {
        calls += 1;
        if (calls === 1)
            throw new Error('first failed');
        await new Promise(resolve => setTimeout(resolve, 10));
        secondFinished = true;
    }), /first failed/);
    assert.equal(secondFinished, true);
});
const layer = { width: 10, height: 10, trimLeft: 1, trimRight: 1, trimTop: 1, trimBottom: 1, destinationLeft: 2, destinationTop: 2 };
const fixture = { name: 'camera', bytes: 10, sha256: 'a'.repeat(64), plans: Array.from({ length: 3 }, () => ({ width: 10, height: 10, layers: Array.from({ length: 6 }, () => ({ ...layer })) })) };
const event = { fixture: 'camera', invocation: 'b'.repeat(32), runId: '123' };
test('all quality references pin immutable private benchmark objects rather than temporary R2 fixtures', () => {
    const fixtures = JSON.parse(resolveProtectedTemplate(readFileSync(new URL('../workers/print-benchmark/fixtures.json', import.meta.url))));
    assert.equal(fixtures.length, 2);
    for (const fixture of fixtures)
        for (const geometry of fixture.geometries) {
            assert.match(geometry.baselineSha256, /^[a-f0-9]{64}$/);
            assert.equal(typeof geometry.baselineVersion, 'string');
            assert.ok(geometry.baselineVersion.length > 0 && geometry.baselineVersion !== 'null');
        }
});
test('isolates benchmark storage by approved fixture, run and invocation', () => {
    const valid = validateInvocation(event, [fixture]);
    assert.equal(valid.sourceKey, `source/print-benchmark/123/inputs/${fixture.sha256}.png`);
    assert.equal(valid.outputPrefix, `source/print-benchmark/123/outputs/${event.invocation}/`);
    for (const changed of [{ ...event, runId: '../production' }, { ...event, fixture: 'arbitrary' }, { ...event, bucket: 'another' }]) {
        assert.throws(() => validateInvocation(changed, [fixture]));
    }
});
test('rejects oversized and out-of-canvas pixel plans before reading or rendering', () => {
    for (const change of [f => { f.bytes = 25000001; }, f => { f.plans[0].width = 100000; },
        f => { f.plans[0].layers[0].destinationLeft = 3; }, f => { f.plans[0].layers[0].trimLeft = 10; }]) {
        const changed = structuredClone(fixture);
        change(changed);
        assert.throws(() => validateInvocation(event, [changed]));
    }
});
test('runtime refuses local, wrong-account and ambient-only AWS contexts', () => {
    const env = { AWS_LAMBDA_FUNCTION_NAME: FUNCTION, AWS_REGION: 'ap-southeast-2', AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs24.x',
        AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_SESSION_TOKEN: 'test' };
    assertRuntime(env, { invokedFunctionArn: FUNCTION_ARN });
    assert.throws(() => assertRuntime(env, { invokedFunctionArn: FUNCTION_ARN.replace(protectedConfig("awsAccountId"), '000000000000') }));
    assert.throws(() => assertRuntime({ ...env, AWS_SESSION_TOKEN: undefined }, { invokedFunctionArn: FUNCTION_ARN }));
    assert.throws(() => assertRuntime({ ...env, AWS_EXECUTION_ENV: undefined }, { invokedFunctionArn: FUNCTION_ARN }));
});
test('bootstrap creates only two isolated bounded roles, with no changes to existing identities', () => {
    const template = JSON.parse(resolveProtectedTemplate(readFileSync(new URL('../infra/print-benchmark/access.json', import.meta.url))));
    assert.deepEqual(Object.keys(template.Resources).sort(), ['CIBoundary', 'CIRole', 'RuntimeBoundary', 'RuntimeRole']);
    for (const kind of ['CI', 'Runtime']) {
        const role = template.Resources[`${kind}Role`].Properties;
        assert.equal(role.RoleName, `${FUNCTION}-${kind.toLowerCase()}`);
        assert.deepEqual(role.PermissionsBoundary, { Ref: `${kind}Boundary` });
        assert.deepEqual(role.Policies[0].PolicyDocument, template.Resources[`${kind}Boundary`].Properties.PolicyDocument);
        assert.doesNotMatch(JSON.stringify(role.Policies), /production|iam:Create|iam:Put|s3:DeleteBucket|lambda:AddPermission/);
        for (const statement of role.Policies[0].PolicyDocument.Statement) {
            const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
            assert.ok(resources.every(resource => resource !== '*' && (resource.includes(FUNCTION) || resource.includes('source/print-benchmark/') || resource === "arn:aws:s3:::forever-tee-video-development-" + protectedConfig("awsAccountId") + "-ap-southeast-2")));
        }
    }
    assert.deepEqual(template.Resources.CIRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals, { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview" });
});
