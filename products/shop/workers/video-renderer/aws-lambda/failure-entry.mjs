import { protectedConfig } from "./protected-config.mjs";
import { validateProductImageJob } from "./product-image-handler.mjs";
import { validateAppJob } from "./app-handler.mjs";
import { appEnvironment } from "./app-environment.mjs";
import { assertNativeNumberedInvocation } from './native-runtime-profile.mjs';
import { validateProductImageV5Event } from './product-image-v5-handler.mjs';
export const FAILURE_QUEUE_ARN = "arn:aws:sqs:ap-southeast-2:" + protectedConfig("awsAccountId") + ":forever-tee-video-development-failures";
export function createFailureHandler({ apiOrigin, environment = "development", send = fetch }) {
    const deployment = appEnvironment(environment);
    if (apiOrigin !== deployment.apiOrigin)
        throw new Error("Invalid failure callback origin.");
    return async (event, context) => {
        if (deployment.runtimeProfile) assertNativeNumberedInvocation(context, deployment.runtimeProfile, 'failure');
        if ((!deployment.runtimeProfile && context?.invokedFunctionArn !== `${deployment.functionArn}-failures`) || !Array.isArray(event?.Records) || event.Records.length > 10) {
            throw new Error("Expected the personal failure-queue Lambda.");
        }
        const batchItemFailures = [];
        for (const record of event.Records) {
            try {
                if (record.eventSourceARN !== deployment.failureQueueArn || typeof record.messageId !== "string" ||
                    typeof record.body !== "string" || record.body.length > 32000)
                    throw new Error("Invalid failure event.");
                const delivery = JSON.parse(record.body);
                const sourceArn = delivery.requestContext?.functionArn;
                const acceptedSource = deployment.runtimeProfile
                    ? typeof sourceArn === 'string' && sourceArn.startsWith(`${deployment.functionArn}:`) && /^[1-9][0-9]{0,15}$/.test(sourceArn.slice(deployment.functionArn.length + 1))
                    : [deployment.functionArn, `${deployment.functionArn}:$LATEST`].includes(sourceArn);
                if (!acceptedSource ||
                    !["RetriesExhausted", "EventAgeExceeded"].includes(delivery.requestContext?.condition))
                    throw new Error("Unexpected failed invocation.");
                const isV5 = deployment.runtimeProfile && delivery.requestPayload?.kind === 'product-image-v5';
                const isImage = isV5 || delivery.requestPayload?.kind === "product-image";
                const job = isV5 ? validateProductImageV5Event(delivery.requestPayload) : isImage ? validateProductImageJob(delivery.requestPayload) : validateAppJob(delivery.requestPayload);
                const response = await send(`${apiOrigin}/v2/internal/${isImage ? "product-image-jobs" : "story-video-jobs"}/${job.jobId}/failure`, {
                    method: "POST", headers: { authorization: `Bearer ${job.grant}` }, redirect: "error", signal: AbortSignal.timeout(10000),
                });
                await response.body?.cancel();
                if (response.status !== 204)
                    throw new Error("Failure callback not acknowledged.");
            }
            catch {
                if (typeof record.messageId !== "string")
                    throw new Error("Missing SQS message identity.");
                batchItemFailures.push({ itemIdentifier: record.messageId });
            }
        }
        return { batchItemFailures };
    };
}
export async function handler(event, context) {
    const deployment = appEnvironment(process.env.STORY_DEPLOYMENT_ENV);
    if (process.env.AWS_LAMBDA_FUNCTION_NAME !== (deployment.failureFunctionName ?? `${deployment.functionName}-failures`) ||
        process.env.AWS_REGION !== "ap-southeast-2" || !process.env.AWS_LAMBDA_RUNTIME_API)
        throw new Error("Expected the personal failure runtime.");
    return createFailureHandler({ apiOrigin: process.env.STORY_API_ORIGIN, environment: deployment.name })(event, context);
}
