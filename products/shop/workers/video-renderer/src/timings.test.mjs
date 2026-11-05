import assert from "node:assert/strict";
import { test } from "node:test";
import { numericTimings, requestTimings, responseTimings } from "./timings.mjs";

test("diagnostics retain bounded numeric metrics only", () => {
  assert.deepEqual(numericTimings({ renderMs: 51, credential: "secret", nested: { a: 2 }, "bad-key": 2, negative: -1, infinite: Infinity }), { renderMs: 51 });
  assert.deepEqual(requestTimings(new Request("https://internal", { headers: { "x-story-video-timings": "broken" } })), {});
  assert.deepEqual(requestTimings(new Request("https://internal", { headers: { "x-story-video-timings": JSON.stringify({ apiReadMs: 25 }) } })), { apiReadMs: 25 });
});

test("renderer timings do not invent missing headers", () => {
  assert.deepEqual(responseTimings(new Response(null, { headers: { "x-render-time-ms": "123", "x-canvas-time-ms": "no" } })), { renderMs: 123 });
});
