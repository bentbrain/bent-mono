import { protectedConfig } from "./protected-config.mjs";
import { nativeRuntimeProfile } from './native-runtime-profile.mjs';
const ACCOUNT = protectedConfig("awsAccountId"), REGION = "ap-southeast-2";
const environment = (name, origin) => Object.freeze({
    name, functionName: `forever-tee-video-${name}`,
    functionArn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:forever-tee-video-${name}`,
    failureQueueArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:forever-tee-video-${name}-failures`, apiOrigin: origin,
});
export const APP_ENVIRONMENTS = Object.freeze({
    development: environment("development", "https://forever-tee-api-development.socialqueue.workers.dev"),
    production: environment("production", "https://forever-tee-api.socialqueue.workers.dev"),
});
export const EXECUTION_PROTOCOL = "claim-v1";
export function appEnvironment(name = "development") {
    if (typeof name !== "string" || !Object.hasOwn(APP_ENVIRONMENTS, name))
        throw new Error("Unknown native deployment environment.");
    const profile = nativeRuntimeProfile(process.env, name, ACCOUNT);
    if (!profile) return APP_ENVIRONMENTS[name];
    return Object.freeze({ ...APP_ENVIRONMENTS[name], apiOrigin: profile.apiOrigin, functionName: profile.mainFunctionArn.split(':').at(-1),
        functionArn: profile.mainFunctionArn, failureFunctionName: profile.failureFunctionArn.split(':').at(-1),
        failureFunctionArn: profile.failureFunctionArn, failureQueueArn: profile.failureQueueArn, runtimeProfile: profile });
}
