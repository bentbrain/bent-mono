const fields = ['schemaVersion', 'environment', 'apiOrigin', 'mainFunctionArn', 'failureFunctionArn', 'failureQueueArn', 'buildId'];
const origins = {
  development: 'https://forever-tee-api-development.socialqueue.workers.dev',
  production: 'https://forever-tee-api.socialqueue.workers.dev',
};
export function nativeRuntimeProfile(env = process.env, expectedEnvironment, expectedAccount) {
  const serialized = env.SHOP_NATIVE_RUNTIME_PROFILE_JSON;
  if (serialized === undefined) return undefined;
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 16384) throw Error('Invalid installed native runtime profile.');
  const profile = JSON.parse(serialized), account = /^arn:aws:lambda:ap-southeast-2:([0-9]{12}):function:/.exec(profile?.mainFunctionArn ?? '')?.[1];
  const arn = new RegExp(`^arn:aws:lambda:ap-southeast-2:${account}:function:[A-Za-z0-9_-]{1,64}$`);
  if (!profile || Array.isArray(profile) || Object.keys(profile).length !== fields.length + (Object.hasOwn(profile, 'qualificationPairs') ? 1 : 0) || !fields.every(key => Object.hasOwn(profile, key)) ||
    !account || expectedAccount !== undefined && account !== expectedAccount || profile.schemaVersion !== 1 || !Object.hasOwn(origins, profile.environment) ||
    expectedEnvironment !== undefined && expectedEnvironment !== profile.environment || profile.apiOrigin !== origins[profile.environment] ||
    !arn.test(profile.mainFunctionArn) || !arn.test(profile.failureFunctionArn) || profile.mainFunctionArn === profile.failureFunctionArn ||
    typeof profile.failureQueueArn !== 'string' || !new RegExp(`^arn:aws:sqs:ap-southeast-2:${account}:[A-Za-z0-9_-]{1,80}$`).test(profile.failureQueueArn) ||
    typeof profile.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(profile.buildId)) throw Error('Invalid installed native runtime profile.');
  const pairs = [{ mainFunctionArn: profile.mainFunctionArn, failureFunctionArn: profile.failureFunctionArn, failureQueueArn: profile.failureQueueArn }];
  if (Object.hasOwn(profile, 'qualificationPairs')) {
    if (!Array.isArray(profile.qualificationPairs) || profile.qualificationPairs.length < 1 || profile.qualificationPairs.length > 4)
      throw Error('Invalid installed native qualification pairs.');
    for (const pair of profile.qualificationPairs) {
      const keys = ['failureFunctionArn', 'failureQueueArn', 'mainFunctionArn', ...(Object.hasOwn(pair ?? {}, 'apiOrigin') ? ['apiOrigin'] : [])].sort();
      if (!pair || Array.isArray(pair) || Object.keys(pair).sort().join() !== keys.join() ||
          !arn.test(pair.mainFunctionArn) || !arn.test(pair.failureFunctionArn) || pair.mainFunctionArn === pair.failureFunctionArn ||
          typeof pair.failureQueueArn !== 'string' || !new RegExp(`^arn:aws:sqs:ap-southeast-2:${account}:[A-Za-z0-9_-]{1,80}$`).test(pair.failureQueueArn) ||
          Object.hasOwn(pair, 'apiOrigin') && (profile.environment !== 'development' || typeof pair.apiOrigin !== 'string' ||
            !/^https:\/\/forever-tee-native-qualification-[a-z0-9-]{1,24}\.socialqueue\.workers\.dev$/.test(pair.apiOrigin)))
        throw Error('Invalid installed native qualification pair.');
      pairs.push(pair);
    }
  }
  const functions = pairs.flatMap(pair => [pair.mainFunctionArn, pair.failureFunctionArn]);
  if (new Set(functions).size !== functions.length || new Set(pairs.map(pair => pair.failureQueueArn)).size !== pairs.length)
    throw Error('Native runtime roles and queues must be distinct.');
  const selected = pairs.find(pair => [pair.mainFunctionArn, pair.failureFunctionArn].some(arn => arn.split(':').at(-1) === env.AWS_LAMBDA_FUNCTION_NAME)) ?? pairs[0];
  return Object.freeze({ ...profile, canonicalMainFunctionArn: profile.mainFunctionArn, canonicalApiOrigin: profile.apiOrigin, ...selected });
}

export function assertNativeNumberedInvocation(context, profile, role = 'main', env = process.env) {
  if (!profile || !['main', 'failure'].includes(role)) throw Error('Expected an installed native invocation profile.');
  const base = role === 'main' ? profile.mainFunctionArn : profile.failureFunctionArn, version = env.AWS_LAMBDA_FUNCTION_VERSION;
  if (env.AWS_REGION !== 'ap-southeast-2' || !env.AWS_LAMBDA_RUNTIME_API ||
    !/^[1-9][0-9]{0,15}$/.test(version ?? '') || env.AWS_LAMBDA_FUNCTION_NAME !== base.split(':').at(-1) ||
    context?.invokedFunctionArn !== `${base}:${version}` || context.functionVersion !== version ||
    context.functionName !== env.AWS_LAMBDA_FUNCTION_NAME || typeof context.awsRequestId !== 'string' ||
    !/^[A-Za-z0-9-]{1,128}$/.test(context.awsRequestId) || env.STORY_BUILD_ID !== profile.buildId ||
    env.STORY_IMAGE_BUILD_ID !== profile.buildId) throw Error('Expected the installed numbered native Lambda invocation.');
  return `${base}:${version}`;
}
