import { protectedConfig } from "./protected-config.mjs";
export const ACCOUNT = protectedConfig("awsAccountId");
export const REGION = "ap-southeast-2";
export const NAME = "forever-tee-video-bench";
export const BUCKET = `${NAME}-${ACCOUNT}-${REGION}`;
export const FUNCTION_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${NAME}`;
export const REPOSITORY = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${NAME}`;
export const RESERVED_CONCURRENCY = 8;
export { ENCODING, VARIANTS } from "./variants.mjs";
export function runtimeClientConfig(env) {
    if (env.AWS_LAMBDA_FUNCTION_NAME !== NAME || env.AWS_REGION !== REGION ||
        env.STORY_BUCKET !== BUCKET || !env.AWS_LAMBDA_RUNTIME_API ||
        !/^[0-9a-f]{64}$/.test(env.STORY_BUILD_ID ?? "") || env.STORY_BUILD_ID !== env.STORY_IMAGE_BUILD_ID ||
        !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_SESSION_TOKEN) {
        throw new Error("The isolated Lambda execution environment is required.");
    }
    return {
        region: REGION, endpoint: `https://s3.${REGION}.amazonaws.com`, maxAttempts: 1,
        // Lambda supplies and rotates these credentials. No local/default provider chain.
        credentials: async () => {
            if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_SESSION_TOKEN) {
                throw new Error("Lambda runtime credentials are unavailable.");
            }
            return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN };
        },
    };
}
