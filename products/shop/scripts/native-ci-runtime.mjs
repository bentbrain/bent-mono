import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual } from "node:util";
import { createDevelopmentCICall } from "./native-ci-aws.mjs";
const NAME = "forever-tee-video-development", ACCOUNT = protectedConfig("awsAccountId"), REGION = "ap-southeast-2";
const IMAGE = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${NAME}@`;
const ORIGIN = "https://forever-tee-api-development.socialqueue.workers.dev";
const arn = name => `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;
const check = (value, reason) => { if (!value)
    throw new Error(`Native runtime verification failed: ${reason}`); };
export function verifyDevelopmentRuntimeFunction(response, failure = false) {
    const name = `${NAME}${failure ? "-failures" : ""}`;
    const config = response.Configuration;
    check(config?.FunctionName === name && config.FunctionArn === arn(name) && config.PackageType === "Image" &&
        config.State === "Active" && config.LastUpdateStatus === "Successful" && isDeepStrictEqual(config.Architectures, ["x86_64"]) &&
        config.MemorySize === (failure ? 128 : 3008) && config.Timeout === (failure ? 30 : 120) &&
        config.Role === `arn:aws:iam::${ACCOUNT}:role/${NAME}-${failure ? "failures" : "runtime"}`, "exact active function and runtime limits.");
    const image = response.Code?.ResolvedImageUri;
    check(typeof image === "string" && image.startsWith(IMAGE) && /^sha256:[a-f0-9]{64}$/.test(image.slice(IMAGE.length)) &&
        response.Code.ImageUri === image, "deployed image must be digest-pinned and resolved to that digest.");
    const variables = config.Environment?.Variables;
    check(variables?.STORY_API_ORIGIN === ORIGIN &&
        (variables.STORY_DEPLOYMENT_ENV === undefined || variables.STORY_DEPLOYMENT_ENV === "development"), "Development callback environment.");
    if (!failure) {
        check(config.EphemeralStorage?.Size === 1024 && /^[a-f0-9]{64}$/.test(variables.STORY_BUILD_ID), "source manifest and temporary storage.");
    }
    else {
        check(isDeepStrictEqual(config.ImageConfigResponse?.ImageConfig?.Command, ["aws-lambda/failure-entry.handler"]), "failure image entrypoint.");
    }
    return { functionArn: config.FunctionArn, imageUri: image, imageDigest: image.slice(IMAGE.length),
        ...(failure ? {} : { sourceDigest: variables.STORY_BUILD_ID }), revisionId: config.RevisionId,
        apiOrigin: ORIGIN, memoryMB: config.MemorySize, timeoutSeconds: config.Timeout };
}
export async function inspectDevelopmentRuntime(env = process.env, { allowMixedImages = false } = {}) {
    const call = await createDevelopmentCICall(env);
    const renderer = verifyDevelopmentRuntimeFunction(await call(["lambda", "get-function", "--function-name", NAME]));
    const failure = verifyDevelopmentRuntimeFunction(await call(["lambda", "get-function", "--function-name", `${NAME}-failures`]), true);
    check(allowMixedImages || renderer.imageUri === failure.imageUri, "existing renderer and failure images differ.");
    for (const [name, expected] of [[NAME, 8], [`${NAME}-failures`, 2]]) {
        const concurrency = await call(["lambda", "get-function-concurrency", "--function-name", name]);
        check(concurrency.ReservedConcurrentExecutions === expected, "reviewed reserved concurrency.");
    }
    const destination = await call(["lambda", "get-function-event-invoke-config", "--function-name", NAME]);
    check(destination.MaximumEventAgeInSeconds === 60 && destination.MaximumRetryAttempts === 0 &&
        destination.DestinationConfig?.OnFailure?.Destination === `arn:aws:sqs:${REGION}:${ACCOUNT}:${NAME}-failures`, "bounded asynchronous delivery and failure destination.");
    const mapping = await call(["lambda", "get-event-source-mapping", "--uuid", protectedConfig("resource_0bcc55046268")]);
    check(mapping.FunctionArn === arn(`${NAME}-failures`) && mapping.EventSourceArn === `arn:aws:sqs:${REGION}:${ACCOUNT}:${NAME}-failures` &&
        mapping.State === "Enabled" && mapping.BatchSize === 1 && mapping.ScalingConfig?.MaximumConcurrency === 2 &&
        isDeepStrictEqual(mapping.FunctionResponseTypes, ["ReportBatchItemFailures"]), "failure consumer.");
    const images = await call(["ecr", "describe-images", "--repository-name", NAME, "--image-ids", `imageTag=source-${renderer.sourceDigest}`]);
    check(images.imageDetails?.length === 1 && images.imageDetails[0].imageDigest === renderer.imageDigest, "live image/source tag.");
    const quota = await call(["lambda", "get-account-settings"]);
    check(Number.isSafeInteger(quota.AccountLimit?.ConcurrentExecutions) && quota.AccountLimit.ConcurrentExecutions >= 100 &&
        Number.isSafeInteger(quota.AccountLimit.UnreservedConcurrentExecutions) && quota.AccountLimit.UnreservedConcurrentExecutions >= 100, "regional capacity.");
    return { runtimeVerified: true, environment: "development", renderer, failure, rendererConcurrency: 8, failureConcurrency: 2,
        asyncAgeSeconds: 60, asyncRetries: 0, accountConcurrency: quota.AccountLimit.ConcurrentExecutions,
        unreservedConcurrency: quota.AccountLimit.UnreservedConcurrentExecutions, applicationMutations: false };
}
