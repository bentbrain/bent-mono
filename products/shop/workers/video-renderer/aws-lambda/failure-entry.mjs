import { protectedConfig } from "./protected-config.mjs";
import { validateProductImageJob } from "./product-image-handler.mjs";
import { validateAppJob } from "./app-handler.mjs";
import { appEnvironment } from "./app-environment.mjs";
export const FAILURE_QUEUE_ARN = "arn:aws:sqs:ap-southeast-2:" + protectedConfig("awsAccountId") + ":forever-tee-video-development-failures";
export function createFailureHandler({ apiOrigin, environment = "development", send = fetch }) {
    const deployment = appEnvironment(environment);
    if (apiOrigin !== deployment.apiOrigin)
        throw new Error("Invalid failure callback origin.");
    return async (event, context) => {
        if (context?.invokedFunctionArn !== `${deployment.functionArn}-failures` || !Array.isArray(event?.Records) || event.Records.length > 10) {
            throw new Error("Expected the personal failure-queue Lambda.");
        }
        const batchItemFailures = [];
        for (const record of event.Records) {
            try {
                if (record.eventSourceARN !== deployment.failureQueueArn || typeof record.messageId !== "string" ||
                    typeof record.body !== "string" || record.body.length > 32000)
                    throw new Error("Invalid failure event.");
                const delivery = JSON.parse(record.body);
                if (![deployment.functionArn, `${deployment.functionArn}:$LATEST`].includes(delivery.requestContext?.functionArn) ||
                    !["RetriesExhausted", "EventAgeExceeded"].includes(delivery.requestContext?.condition))
                    throw new Error("Unexpected failed invocation.");
                const isImage = delivery.requestPayload?.kind === "product-image";
                const job = isImage ? validateProductImageJob(delivery.requestPayload) : validateAppJob(delivery.requestPayload);
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
    if (process.env.AWS_LAMBDA_FUNCTION_NAME !== `${deployment.functionName}-failures` ||
        process.env.AWS_REGION !== "ap-southeast-2" || !process.env.AWS_LAMBDA_RUNTIME_API)
        throw new Error("Expected the personal failure runtime.");
    return createFailureHandler({ apiOrigin: process.env.STORY_API_ORIGIN, environment: deployment.name })(event, context);
}
