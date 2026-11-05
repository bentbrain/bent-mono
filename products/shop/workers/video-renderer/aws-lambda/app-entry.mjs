import { protectedConfig } from "./protected-config.mjs";
import { createProductImageHandler, validateProductImageJob } from "./product-image-handler.mjs";
import { readFile } from "node:fs/promises";
import { assertAppInvocation, createAppHandler, validateAppJob } from "./app-handler.mjs";
import { appEnvironment } from "./app-environment.mjs";
let implementation;
let imageImplementation;
const mockups = new Map();
export async function handler(event, context) {
    const deployment = appEnvironment(process.env.STORY_DEPLOYMENT_ENV);
    assertAppInvocation(context, deployment.name);
    if (event?.kind === "product-image")
        validateProductImageJob(event);
    else
        validateAppJob(event);
    if (process.env.AWS_LAMBDA_FUNCTION_NAME !== deployment.functionName || process.env.AWS_REGION !== "ap-southeast-2" ||
        !process.env.AWS_LAMBDA_RUNTIME_API || process.env.STORY_BUILD_ID !== process.env.STORY_IMAGE_BUILD_ID) {
        throw new Error("Expected the isolated app Lambda environment.");
    }
    if (event?.kind === "product-image") {
        if (!imageImplementation) {
            const { renderProductImage } = await import("../src/product-image-renderer.mjs");
            imageImplementation = createProductImageHandler({ apiOrigin: process.env.STORY_API_ORIGIN, buildId: process.env.STORY_BUILD_ID,
                environment: deployment.name, render: renderProductImage, readAsset: async (file) => {
                    if (!mockups.has(file))
                        mockups.set(file, await readFile(new URL(`../product-assets/${file}`, import.meta.url)));
                    return mockups.get(file);
                } });
        }
        return imageImplementation(event, context);
    }
    if (!implementation) {
        const { renderStoryVideo } = await import("../src/renderer.mjs");
        implementation = createAppHandler({ apiOrigin: process.env.STORY_API_ORIGIN, buildId: process.env.STORY_BUILD_ID, environment: deployment.name,
            terminateQualification: async (jobId, executionId, invocation) => {
                // Never install a general kill endpoint. A production invocation cannot
                // reach this branch, even if its API returns the Development test header.
                if (deployment.name !== "development" || process.platform !== "linux" ||
                    invocation.invokedFunctionArn !== "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development" ||
                    process.env.AWS_LAMBDA_FUNCTION_NAME !== "forever-tee-video-development" || !process.env.AWS_LAMBDA_RUNTIME_API) {
                    throw new Error("Qualification termination requires the exact Development Lambda.");
                }
                console.info("Native qualification process termination", { jobId, executionId, awsRequestId: invocation.awsRequestId });
                process.kill(process.pid, "SIGKILL");
                await new Promise(() => { });
            },
            render: renderStoryVideo, readMockup: async (file) => {
                // file comes only from the checked-in four-product allowlist.
                if (!mockups.has(file))
                    mockups.set(file, await readFile(new URL(`../product-assets/${file}`, import.meta.url)));
                return mockups.get(file);
            } });
    }
    return implementation(event, context);
}
