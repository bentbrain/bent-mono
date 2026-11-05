import assert from "node:assert/strict";
import test from "node:test";
import { summarizeReleaseEvents } from "./native-release-timing.mjs";

test("release timing summarizes each immutable stage without changing release state", () => {
  assert.deepEqual(summarizeReleaseEvents([
    { stage: "prepared", created_at: 1000 },
    { stage: "drained", created_at: 1250 },
    { stage: "verified", created_at: 2000 },
  ]), {
    firstStageAt: 1000,
    lastStageAt: 2000,
    totalMs: 1000,
    stages: [
      { stage: "prepared", createdAt: 1000, durationMs: 250 },
      { stage: "drained", createdAt: 1250, durationMs: 750 },
      { stage: "verified", createdAt: 2000, durationMs: null },
    ],
  });
});

test("release timing rejects duplicate, unordered or unbounded event histories", () => {
  for (const records of [
    [{ stage: "prepared", created_at: 1000 }, { stage: "prepared", created_at: 1100 }],
    [{ stage: "prepared", created_at: 1000 }, { stage: "verified", created_at: 900 }],
    [{ stage: "prepared", created_at: -1 }],
    Array(64).fill({ stage: "prepared", created_at: 1000 }),
  ]) assert.throws(() => summarizeReleaseEvents(records));
});
