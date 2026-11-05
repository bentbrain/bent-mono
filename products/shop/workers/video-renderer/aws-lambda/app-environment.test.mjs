import assert from "node:assert/strict";
import test from "node:test";
import { APP_ENVIRONMENTS, appEnvironment, EXECUTION_PROTOCOL } from "./app-environment.mjs";
import { assertAppInvocation, createAppHandler } from "./app-handler.mjs";
import { createFailureHandler } from "./failure-entry.mjs";

const id = "11111111-1111-1111-1111-111111111111";
const job = { schemaVersion: 1, jobId: id, attempt: 1, artwork: { size: 1, sha256: "a".repeat(64) }, baseProductSlug: "staple-tee", color: "Black",
  settings: { cropX: 0.5, cropY: 0.5, cropZoom: 1, placementX: 0.3, placementY: 0.3, placementWidth: 0.4, depth: 5 },
  storyKey: `story-videos/v7/${id}/${id}/black.mp4`, rendererVersion: "story-video-renderer-v7", grant: "payload.signature" };

test("native runtime pins the personal environment, function, queue and callback origin", () => {
  assert.equal(EXECUTION_PROTOCOL, "claim-v1");
  assert.equal(appEnvironment().name, "development");
  for (const invalid of ["toString", "__proto__", "Production", "work", null, {}]) assert.throws(() => appEnvironment(invalid));
  for (const [name, expected] of Object.entries(APP_ENVIRONMENTS)) {
    const context = { invokedFunctionArn: expected.functionArn, awsRequestId: "fixture", getRemainingTimeInMillis: () => 120000 };
    assertAppInvocation(context, name);
    assert.throws(() => assertAppInvocation({ ...context, invokedFunctionArn: `${expected.functionArn}:alias` }, name));
    assert.throws(() => assertAppInvocation(context, name === "development" ? "production" : "development"));
    for (const other of ["https://example.test", `${expected.apiOrigin}/`, `${expected.apiOrigin}.evil.test`]) {
      assert.throws(() => createAppHandler({ environment: name, apiOrigin: other, buildId: "a".repeat(64) }));
      assert.throws(() => createFailureHandler({ environment: name, apiOrigin: other }));
    }
  }
});
test("production claim and failure callbacks cannot use Development identity or source queue", async () => {
  const expected = APP_ENVIRONMENTS.production;
  let calls = 0;
  const send = async url => { calls++; assert.ok(url.startsWith(`${expected.apiOrigin}/v2/internal/`)); return new Response(null, { status: 204 }); };
  const app = createAppHandler({ environment: "production", apiOrigin: expected.apiOrigin, buildId: "a".repeat(64), send,
    render: async () => assert.fail("duplicate claim cannot encode"), readMockup: async () => assert.fail("duplicate claim cannot read assets") });
  assert.equal((await app(job, { invokedFunctionArn: expected.functionArn, awsRequestId: "fixture", getRemainingTimeInMillis: () => 120000 })).status, "skipped");
  const failure = createFailureHandler({ environment: "production", apiOrigin: expected.apiOrigin, send });
  const record = { messageId: "fixture", eventSourceARN: expected.failureQueueArn,
    body: JSON.stringify({ requestContext: { functionArn: `${expected.functionArn}:$LATEST`, condition: "RetriesExhausted" }, requestPayload: job }) };
  const context = { invokedFunctionArn: `${expected.functionArn}-failures` };
  assert.deepEqual(await failure({ Records: [record] }, context), { batchItemFailures: [] });
  assert.deepEqual(await failure({ Records: [{ ...record, eventSourceARN: APP_ENVIRONMENTS.development.failureQueueArn }] }, context),
    { batchItemFailures: [{ itemIdentifier: "fixture" }] });
  assert.equal(calls, 2);
});
