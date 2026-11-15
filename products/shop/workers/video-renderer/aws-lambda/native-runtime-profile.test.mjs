import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRuntimeProfile, assertNativeNumberedInvocation } from './native-runtime-profile.mjs';
import { validationEnvironment } from '../../../scripts/validation-environment.mjs';

const synthetic = validationEnvironment({});
process.env.SHOP_PROTECTED_CONFIG_JSON = synthetic.SHOP_PROTECTED_CONFIG_JSON;
const { awsAccountId: account } = JSON.parse(synthetic.SHOP_PROTECTED_CONFIG_JSON);
const { appEnvironment } = await import('./app-environment.mjs');
const { assertAppInvocation } = await import('./app-handler.mjs');
const { createFailureHandler } = await import('./failure-entry.mjs');
const { validateProductImageV5Binding } = await import('./product-image-v5-handler.mjs');
const buildId = 'a'.repeat(64), main = `arn:aws:lambda:ap-southeast-2:${account}:function:qualification-native`;
const profile = { schemaVersion: 1, environment: 'development', apiOrigin: 'https://forever-tee-api-development.socialqueue.workers.dev',
  mainFunctionArn: main, failureFunctionArn: `${main}-failure`, failureQueueArn: `arn:aws:sqs:ap-southeast-2:${account}:qualification-failure`, buildId };
const environment = () => ({ SHOP_NATIVE_RUNTIME_PROFILE_JSON: JSON.stringify(profile), AWS_REGION: 'ap-southeast-2',
  AWS_LAMBDA_RUNTIME_API: '127.0.0.1:9001', AWS_LAMBDA_FUNCTION_NAME: 'qualification-native', AWS_LAMBDA_FUNCTION_VERSION: '7',
  STORY_BUILD_ID: buildId, STORY_IMAGE_BUILD_ID: buildId });
const context = () => ({ invokedFunctionArn: `${main}:7`, functionName: 'qualification-native', functionVersion: '7',
  awsRequestId: 'synthetic-request', getRemainingTimeInMillis: () => 120000 });

function installed(t, values) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

test('installed numbered profile binds actual provider context and preserves default identities', t => {
  assert.equal(nativeRuntimeProfile({}), undefined);
  const legacy = appEnvironment('development');
  assertAppInvocation({ invokedFunctionArn: legacy.functionArn, awsRequestId: 'legacy', getRemainingTimeInMillis: () => 120000 });
  const env = environment(), checked = nativeRuntimeProfile(env, 'development', account);
  assert.equal(assertNativeNumberedInvocation(context(), checked, 'main', env), `${main}:7`);
  for (const alter of [
    value => { value.functionVersion = '8'; }, value => { value.functionName = 'foreign'; },
    value => { value.invokedFunctionArn = main; }, value => { value.invokedFunctionArn = `${main}:alias`; },
    value => { value.invokedFunctionArn = `${main}:8`; },
  ]) { const invalid = context(); alter(invalid); assert.throws(() => assertNativeNumberedInvocation(invalid, checked, 'main', env)); }
  for (const [key, value] of [['AWS_LAMBDA_FUNCTION_VERSION', '$LATEST'], ['STORY_BUILD_ID', 'b'.repeat(64)], ['AWS_REGION', 'us-east-1']])
    assert.throws(() => assertNativeNumberedInvocation(context(), checked, 'main', { ...env, [key]: value }));
  installed(t, env);
  assert.equal(appEnvironment('development').functionArn, main);
  assertAppInvocation(context());
  assert.throws(() => assertAppInvocation({ ...context(), getRemainingTimeInMillis: () => 100 }));
  assert.throws(() => appEnvironment('production'));
});

test('malformed profiles cannot widen environment, account, origin or runtime identity', () => {
  for (const change of [
    value => { value.apiOrigin = 'https://example.invalid'; }, value => { value.mainFunctionArn += ':7'; },
    value => { value.failureFunctionArn = value.mainFunctionArn; }, value => { value.failureQueueArn = 'arn:aws:sqs:ap-southeast-2:111111111111:foreign'; },
    value => { value.environment = 'toString'; }, value => { value.buildId = 'unknown'; }, value => { value.callerApproved = true; },
  ]) { const invalid = structuredClone(profile); change(invalid); assert.throws(() => nativeRuntimeProfile({ SHOP_NATIVE_RUNTIME_PROFILE_JSON: JSON.stringify(invalid) }, 'development', account)); }
  assert.throws(() => nativeRuntimeProfile(environment(), 'development', '111111111111'));
});

test('one exact installed binding supports distinct serving and qualification pairs', () => {
  const candidate = { mainFunctionArn: `${main}-candidate`, failureFunctionArn: `${main}-candidate-failure`,
    failureQueueArn: `${profile.failureQueueArn}-candidate` };
  const raw = JSON.stringify({ ...profile, qualificationPairs: [candidate] });
  const servingEnv = { ...environment(), SHOP_NATIVE_RUNTIME_PROFILE_JSON: raw };
  const candidateEnv = { ...servingEnv, AWS_LAMBDA_FUNCTION_NAME: 'qualification-native-candidate' };
  const serving = nativeRuntimeProfile(servingEnv, 'development', account), isolated = nativeRuntimeProfile(candidateEnv, 'development', account);
  assert.equal(serving.mainFunctionArn, main); assert.equal(isolated.mainFunctionArn, candidate.mainFunctionArn);
  assert.equal(isolated.canonicalMainFunctionArn, main);
  assertNativeNumberedInvocation({ ...context(), functionName: candidateEnv.AWS_LAMBDA_FUNCTION_NAME, invokedFunctionArn: `${candidate.mainFunctionArn}:7` }, isolated, 'main', candidateEnv);
  assert.throws(() => assertNativeNumberedInvocation(context(), isolated, 'main', candidateEnv));
  for (const pair of [profile, { ...candidate, mainFunctionArn: main }, { ...candidate, failureQueueArn: profile.failureQueueArn },
    { ...candidate, failureFunctionArn: candidate.mainFunctionArn }])
    assert.throws(() => nativeRuntimeProfile({ ...servingEnv, SHOP_NATIVE_RUNTIME_PROFILE_JSON: JSON.stringify({ ...profile, qualificationPairs: [pair] }) }));
});

test('an installed isolated pair selects only its pinned Development callback Worker', t => {
  const pair = { mainFunctionArn: `${main}-candidate`, failureFunctionArn: `${main}-candidate-failure`,
    failureQueueArn: `${profile.failureQueueArn}-candidate`, apiOrigin: 'https://forever-tee-native-qualification-proof.socialqueue.workers.dev' };
  const env = { ...environment(), AWS_LAMBDA_FUNCTION_NAME: 'qualification-native-candidate',
    SHOP_NATIVE_RUNTIME_PROFILE_JSON: JSON.stringify({ ...profile, qualificationPairs: [pair] }) };
  installed(t, env);
  const isolated = nativeRuntimeProfile(env, 'development', account);
  assert.equal(isolated.apiOrigin, pair.apiOrigin); assert.equal(isolated.canonicalApiOrigin, profile.apiOrigin);
  assert.equal(nativeRuntimeProfile({ ...env, AWS_LAMBDA_FUNCTION_NAME: 'qualification-native' }).apiOrigin, profile.apiOrigin);
  const binding = { schemaVersion: 1, environment: 'development', apiOrigin: pair.apiOrigin, functionArn: pair.mainFunctionArn,
    qualifiedFunctionArns: [`${pair.mainFunctionArn}:7`], buildId };
  assert.equal(validateProductImageV5Binding(binding).apiOrigin, pair.apiOrigin);
  assert.throws(() => validateProductImageV5Binding({ ...binding, functionArn: main }));
  for (const apiOrigin of ['https://example.invalid', `${pair.apiOrigin}/`, 'http://forever-tee-native-qualification-proof.socialqueue.workers.dev',
    'https://forever-tee-native-qualification-proof.foreign.workers.dev', `${pair.apiOrigin}.example.invalid`])
    assert.throws(() => nativeRuntimeProfile({ ...env, SHOP_NATIVE_RUNTIME_PROFILE_JSON: JSON.stringify({ ...profile,
      qualificationPairs: [{ ...pair, apiOrigin }] }) }));
});

test('numbered failure adapter preserves v5 grants and rejects other source functions and queues', async t => {
  const env = { ...environment(), AWS_LAMBDA_FUNCTION_NAME: 'qualification-native-failure', AWS_LAMBDA_FUNCTION_VERSION: '9' };
  installed(t, env); let calls = 0;
  const handler = createFailureHandler({ apiOrigin: profile.apiOrigin, send: async (url, init) => {
    calls++; assert.equal(url, `${profile.apiOrigin}/v2/internal/product-image-jobs/11111111-1111-1111-1111-111111111111/failure`);
    assert.equal(init.headers.authorization, 'Bearer nv5_payload.signature'); return new Response(null, { status: 204 });
  } });
  const invocation = { ...context(), functionName: env.AWS_LAMBDA_FUNCTION_NAME, functionVersion: '9', invokedFunctionArn: `${profile.failureFunctionArn}:9` };
  const payload = { kind: 'product-image-v5', schemaVersion: 1, jobId: '11111111-1111-1111-1111-111111111111', grant: 'nv5_payload.signature', rendererVersion: 'product-images-v5' };
  const record = { messageId: 'synthetic-message', eventSourceARN: profile.failureQueueArn,
    body: JSON.stringify({ requestContext: { functionArn: `${main}:7`, condition: 'RetriesExhausted' }, requestPayload: payload }) };
  assert.deepEqual(await handler({ Records: [record] }, invocation), { batchItemFailures: [] });
  for (const invalid of [{ ...record, eventSourceARN: `${profile.failureQueueArn}-foreign` },
    { ...record, body: JSON.stringify({ requestContext: { functionArn: `${main}-foreign:7`, condition: 'RetriesExhausted' }, requestPayload: payload }) }])
    assert.deepEqual(await handler({ Records: [invalid] }, invocation), { batchItemFailures: [{ itemIdentifier: record.messageId }] });
  assert.equal(calls, 1);
});
