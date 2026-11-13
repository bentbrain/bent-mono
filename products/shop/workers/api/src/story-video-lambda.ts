import { protectedConfig } from "./protected-config";
import { AwsClient } from "aws4fetch";
import { createStoryVideoGrant } from "./story-video-grants";
import { legacyStoredVideo } from "./story-video-legacy-cache";
import type { NativeV5Target } from "./native-v5-target";
export interface LambdaStoryVideoEnv {
    readonly STORY_VIDEO_PROVIDER?: string;
    readonly STORY_VIDEO_ENVIRONMENT?: string;
    readonly STORY_VIDEO_LAMBDA_FUNCTION?: string;
    readonly STORY_VIDEO_LAMBDA_ACCESS_KEY_ID?: string;
    readonly STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY?: string;
    readonly STORY_VIDEO_LAMBDA_SESSION_TOKEN?: string;
    readonly STORY_VIDEO_GRANT_SECRET?: string;
    readonly STORY_VIDEOS?: R2Bucket;
}
export async function invokeQualifiedNativeV5(env: LambdaStoryVideoEnv, target: NativeV5Target, body: string, send: typeof fetch = fetch) {
    if (!env.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID || !env.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY)
        throw new Error("Install the protected native invocation credentials.");
    const signer = new AwsClient({ accessKeyId: env.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID, secretAccessKey: env.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY,
        ...(env.STORY_VIDEO_LAMBDA_SESSION_TOKEN ? { sessionToken: env.STORY_VIDEO_LAMBDA_SESSION_TOKEN } : {}),
        service: "lambda", region: "ap-southeast-2", retries: 0 });
    const request = await signer.sign(`https://lambda.ap-southeast-2.amazonaws.com/2015-03-31/functions/${encodeURIComponent(target.functionArn)}/invocations`, {
        method: "POST", headers: { "content-type": "application/json", "x-amz-invocation-type": "RequestResponse" }, body,
    });
    return send(request, { redirect: "manual", signal: AbortSignal.timeout(25000) });
}
export interface LambdaVideoJob {
    readonly jobId: string;
    readonly attempt: number;
    readonly artwork: {
        readonly sha256: string;
        readonly size: number;
    };
    readonly recursiveSource?: {
        readonly sha256: string;
        readonly size: number;
        readonly cropX: number;
        readonly cropY: number;
        readonly cropZoom: number;
        readonly placement?: {
            readonly placementX: number;
            readonly placementY: number;
            readonly placementWidth: number;
        };
    };
    readonly baseProductSlug: string;
    readonly color: string;
    readonly settings: Readonly<Record<string, number>>;
    readonly storyKey: string;
}
const hash = /^[0-9a-f]{64}$/;
export const LAMBDA_STORY_FUNCTION = "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development";
export function validateLambdaStoryVideoEnv(env: LambdaStoryVideoEnv) {
    const functionArn = env.STORY_VIDEO_ENVIRONMENT === "production"
        ? "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-production" : env.STORY_VIDEO_ENVIRONMENT === undefined || env.STORY_VIDEO_ENVIRONMENT === "development" ? LAMBDA_STORY_FUNCTION : undefined;
    if (!functionArn || env.STORY_VIDEO_LAMBDA_FUNCTION !== functionArn ||
        !env.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID || !env.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY ||
        !env.STORY_VIDEO_GRANT_SECRET || env.STORY_VIDEO_GRANT_SECRET.length < 32 || !env.STORY_VIDEOS) {
        throw new Error("The personal Lambda provider does not match its deployment environment.");
    }
    return { functionArn, accessKeyId: env.STORY_VIDEO_LAMBDA_ACCESS_KEY_ID, secretAccessKey: env.STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY,
        grantSecret: env.STORY_VIDEO_GRANT_SECRET, videos: env.STORY_VIDEOS };
}
export async function storedLambdaVideo(bucket: R2Bucket, job: Pick<LambdaVideoJob, "storyKey" | "jobId" | "artwork"> & {
    readonly recursiveSource?: {
        readonly sha256: string;
        readonly placement?: {
            readonly placementX: number;
            readonly placementY: number;
            readonly placementWidth: number;
        };
    };
}, rendererVersion: string, readLegacy?: typeof legacyStoredVideo) {
    const object = await bucket.head(job.storyKey);
    if (!object)
        return;
    const digest = object.customMetadata?.["sha256"];
    if (readLegacy && !job.recursiveSource) {
        const legacy = await readLegacy(bucket, object, rendererVersion);
        if (legacy)
            return legacy;
    }
    if (object.size < 1 || object.size > 32000000 || object.httpMetadata?.contentType !== "video/mp4" ||
        object.customMetadata?.["jobId"] !== job.jobId || object.customMetadata["sourceSha256"] !== job.artwork.sha256 ||
        object.customMetadata["recursiveSourceSha256"] !== job.recursiveSource?.sha256 ||
        object.customMetadata["compositionVersion"] !== (job.recursiveSource?.placement ? "two-source-v2" : job.recursiveSource ? "two-source-v1" : undefined) ||
        object.customMetadata["rendererVersion"] !== rendererVersion || !digest || !hash.test(digest)) {
        throw new Error("Stored Lambda video does not match the immutable job.");
    }
    return { key: job.storyKey, size: object.size, sha256: digest };
}
type LambdaDispatchResult = {
    status: "accepted" | "uncertain";
    timings: Readonly<Record<string, number>>;
} | {
    status: "ready";
    key: string;
    size: number;
    sha256: string;
    timings: Readonly<Record<string, number>>;
};
export async function renderLambdaVideo(env: LambdaStoryVideoEnv, job: LambdaVideoJob, rendererVersion: string, send: typeof fetch = fetch, readLegacy = legacyStoredVideo): Promise<LambdaDispatchResult> {
    const config = validateLambdaStoryVideoEnv(env);
    const cached = await storedLambdaVideo(config.videos, job, rendererVersion, readLegacy);
    if (cached)
        return { status: "ready", ...cached, timings: { lambdaCacheHit: 1 } };
    const grant = await createStoryVideoGrant(config.grantSecret, job.jobId, job.attempt);
    // This service identity can invoke only the exact personal function. It never
    // uses local AWS profiles or a credential-provider chain. Retries belong to the queue.
    const signer = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
        service: "lambda", region: "ap-southeast-2", retries: 0 });
    const request = await signer.sign(`https://lambda.ap-southeast-2.amazonaws.com/2015-03-31/functions/${encodeURIComponent(config.functionArn)}/invocations`, {
        method: "POST", headers: { "content-type": "application/json", "x-amz-invocation-type": "Event" },
        body: JSON.stringify({ schemaVersion: job.recursiveSource?.placement ? 3 : job.recursiveSource ? 2 : 1, ...job, rendererVersion, grant }),
    });
    const startedAt = Date.now();
    // Workers does not implement redirect:error. Manual plus the status check
    // below rejects redirects without forwarding the signed request elsewhere.
    let response: Response;
    try {
        response = await send(request, { signal: AbortSignal.timeout(10000), redirect: "manual" });
    }
    catch {
        // A lost response is not proof of rejection. Keep this attempt's grant
        // valid; its execution fence and bounded recovery lease handle ambiguity.
        return { status: "uncertain", timings: { lambdaDispatchMs: Date.now() - startedAt } };
    }
    if (response.status >= 500) {
        await response.body?.cancel();
        return { status: "uncertain", timings: { lambdaDispatchMs: Date.now() - startedAt } };
    }
    if (response.status !== 202 || response.headers.has("x-amz-function-error")) {
        await response.body?.cancel();
        throw new Error(`Lambda render invocation failed (${response.status.toString()}).`);
    }
    await response.body?.cancel();
    // 202 means AWS owns durable delivery, not that a video is ready. The fenced
    // R2 upload callback publishes readiness independently for each variant.
    return { status: "accepted", timings: { lambdaDispatchMs: Date.now() - startedAt, lambdaCacheHit: 0 } };
}
