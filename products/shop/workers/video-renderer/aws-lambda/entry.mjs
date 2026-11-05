import { runtimeClientConfig } from "./config.mjs";
import { assertInvocation, createHandler } from "./handler-core.mjs";
import { createStorage, singleRequestClient } from "./s3-storage.mjs";

let implementation;
export async function handler(event, context) {
  const entryStartedAt = performance.now();
  const handlerStartedAt = Date.now();
  let runtimeLoadMs = 0;
  assertInvocation(context);
  if (!implementation) {
    const config = runtimeClientConfig(process.env);
    const { S3Client, GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { renderStoryVideo } = await import("../src/renderer.mjs");
    // Reads are idempotent and may retry transient TLS/service failures within
    // their shared 20-second deadline. Conditional writes stay single-attempt:
    // retrying a committed write after a lost response would produce a conflict.
    const readClient = new S3Client({ ...config, maxAttempts: 3 });
    // A frozen Lambda can retain a socket closed by S3 while idle. Writes use
    // a fresh connection and release it after acknowledgement, with no retry.
    const writeClient = singleRequestClient(() => new S3Client(config));
    implementation = createHandler({
      storage: createStorage({ readClient, writeClient, GetObjectCommand, PutObjectCommand }),
      render: renderStoryVideo, buildId: process.env.STORY_BUILD_ID,
    });
    runtimeLoadMs = Math.round(performance.now() - entryStartedAt);
  }
  const result = await implementation(event, context);
  return { ...result, timings: { ...result.timings, runtimeLoadMs, handlerStartedAt,
    handlerMs: Math.round(performance.now() - entryStartedAt) } };
}
