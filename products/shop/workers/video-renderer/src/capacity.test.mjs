import assert from "node:assert/strict";
import test from "node:test";
import { laneNumbers, renderConcurrency } from "./capacity.mjs";

test("four lanes require an explicit deployment flag, and requests cannot exceed capacity", () => {
  assert.deepEqual(laneNumbers({}), [0, 1]);
  assert.equal(renderConcurrency(4, {}), 2);
  assert.equal(renderConcurrency(1, { STORY_VIDEO_LANES: "4" }), 1);
  assert.equal(renderConcurrency(4, { STORY_VIDEO_LANES: "4" }), 4);
  assert.equal(renderConcurrency(100, { STORY_VIDEO_LANES: "4" }), 2);
  assert.deepEqual(laneNumbers({ STORY_VIDEO_LANES: "4" }), [0, 1, 2, 3]);
});
