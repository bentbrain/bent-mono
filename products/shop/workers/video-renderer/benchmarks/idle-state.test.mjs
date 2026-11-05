import assert from "node:assert/strict";
import test from "node:test";
import { allContainersStopped, validIdleProof } from "./idle-state.mjs";

test("idle proof uses runtime state, not cached SDK labels", () => {
  const states = [{ status: "healthy", running: false }, { status: "stopped", running: false }];
  assert.equal(allContainersStopped(states, 2), true);
  assert.equal(allContainersStopped([{ status: "stopped" }, states[1]], 2), false);
  assert.equal(allContainersStopped([{ status: "stopped", running: true }, states[1]], 2), false);
  assert.equal(allContainersStopped(states, 4), false);
  assert.equal(allContainersStopped([], 0), false);
  const family = { lanes: 2, idleProof: { checkedAt: 200, states }, jobs: Array.from({ length: 4 }, () => ({ rendered_at: 100 })) };
  assert.equal(validIdleProof(family), true);
  assert.equal(validIdleProof({ ...family, idleProof: { checkedAt: 99, states } }), false);
  assert.equal(validIdleProof({ ...family, jobs: [] }), false);
  assert.equal(validIdleProof(undefined), false);
});
