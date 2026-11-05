import assert from "node:assert/strict";
import test from "node:test";
import { createFailureHandler, FAILURE_QUEUE_ARN } from "./failure-entry.mjs";
import { APP_ARN } from "./app-handler.mjs";
const id = "11111111-1111-1111-1111-111111111111";
const job = { schemaVersion: 1, jobId: id, attempt: 1, artwork: { size: 1, sha256: "a".repeat(64) },
  baseProductSlug: "staple-tee", color: "Black", settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.3, placementY: 0.3, placementWidth: 0.4, depth: 5 },
  storyKey: `story-videos/v7/${id}/${id}/black.mp4`, rendererVersion: "story-video-renderer-v7", grant: "payload.signature" };
const record = { eventSourceARN: FAILURE_QUEUE_ARN, messageId: "message-id", body: JSON.stringify({
  requestContext: { functionArn: `${APP_ARN}:$LATEST`, condition: "RetriesExhausted" }, requestPayload: job }) };
const context = { invokedFunctionArn: `${APP_ARN}-failures` };
test("failure queue delivers a scoped callback without exposing or loading AWS credentials", async () => {
  let calls = 0;
  const handler = createFailureHandler({ apiOrigin: "https://forever-tee-api-development.socialqueue.workers.dev", send: async (url, init) => {
    calls++; assert.ok(url.endsWith(`/${id}/failure`)); assert.equal(init.headers.authorization, "Bearer payload.signature");
    return new Response(null, { status: 204 });
  } });
  assert.deepEqual(await handler({ Records: [record] }, context), { batchItemFailures: [] });
  assert.equal(calls, 1);
});
test("wrong queue, account or payload cannot call the application", async () => {
  let calls = 0;
  const handler = createFailureHandler({ apiOrigin: "https://forever-tee-api-development.socialqueue.workers.dev", send: async () => { calls++; } });
  for (const bad of [{ ...record, eventSourceARN: "foreign" }, { ...record, body: "{}" }]) {
    assert.deepEqual(await handler({ Records: [bad] }, context), { batchItemFailures: [{ itemIdentifier: "message-id" }] });
  }
  await assert.rejects(handler({ Records: [record] }, { invokedFunctionArn: APP_ARN }));
  assert.equal(calls, 0);
});
test("unacknowledged failure stays on SQS for retry", async () => {
  const handler = createFailureHandler({ apiOrigin: "https://forever-tee-api-development.socialqueue.workers.dev", send: async () => new Response(null, { status: 503 }) });
  assert.deepEqual(await handler({ Records: [record] }, context), { batchItemFailures: [{ itemIdentifier: "message-id" }] });
});
