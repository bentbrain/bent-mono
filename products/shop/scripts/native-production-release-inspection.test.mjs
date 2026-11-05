import test from "node:test";
import assert from "node:assert/strict";
import { bindingComparison, canaryAssetObservation, storyVideoJobObservation } from "./native-production-release-inspection.mjs";
test("release inspection distinguishes text and JSON binding types without exposing arbitrary values", () => {
  const variables = { STORY_VIDEO_PROVIDER: "cloudflare", STORY_VIDEO_RELEASE_ID: "native-123", PRIVATE: "secret" };
  const result = bindingComparison([{ name: "STORY_VIDEO_PROVIDER", type: "json", json: '"cloudflare"' },
    { name: "STORY_VIDEO_RELEASE_ID", type: "plain_text", text: "must-not-log" }, { name: "PRIVATE", type: "secret_text", text: "secret" }], variables);
  assert.equal(result[0].textMatches, false); assert.equal(result[0].jsonMatches, true); assert.equal(result[0].jsonProvider, '"cloudflare"');
  assert.equal(JSON.stringify(result).includes("must-not-log"), false); assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("release inspection exposes only bounded synthetic canary asset diagnostics", () => {
  const rows = [
    { geometry_key: "dtg:3600x4200", status: "failed", width_px: null, height_px: null,
      last_error: "Print asset rendering returned 500." },
    { geometry_key: "dtg:4500x5100", status: "private", width_px: 4500, height_px: 5100,
      last_error: "customer-controlled or provider-private detail" },
  ];
  const result = canaryAssetObservation(rows);
  assert.deepEqual(result[0], { geometry: "dtg:3600x4200", status: "failed", width: null, height: null,
    error: "Print asset rendering returned 500." });
  assert.deepEqual(result[1], { geometry: "dtg:4500x5100", status: "invalid", width: 4500, height: 5100,
    error: "unclassified" });
  assert.equal(JSON.stringify(result).includes("provider-private"), false);
});

test("release inspection aggregates eligible video failures without exposing arbitrary errors", () => {
  const result = storyVideoJobObservation([
    { status: "failed", attempt_count: 3, count: 80, missing_placement: 0, last_error: "Renderer request failed: 500." },
    { status: "failed", attempt_count: 1, count: 4, missing_placement: 4, last_error: "private provider response" },
  ]);
  assert.deepEqual(result[0], { status: "failed", attempts: 3, count: 80, missingPlacement: 0,
    error: "Renderer request failed: 500." });
  assert.deepEqual(result[1], { status: "failed", attempts: 1, count: 4, missingPlacement: 4,
    error: "unclassified" });
  assert.equal(JSON.stringify(result).includes("provider response"), false);
});
