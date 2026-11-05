import assert from "node:assert/strict";
import test from "node:test";
import { releaseStatus } from "./release-status.mjs";
const repository = { full_name: "bentbrain/bent-mono" };
test("status identifies the failing step on the current attempt without rerunning anything", async () => {
  const calls = [];
  const result = await releaseStatus(async path => {
    calls.push(path);
    if (path === "actions/runs/123") return { id: 123, run_attempt: 2, repository, head_repository: repository,
      status: "completed", conclusion: "failure", head_sha: "a".repeat(40) };
    return { total_count: 1, jobs: [{ name: "release", conclusion: "failure", status: "completed",
      steps: [{ name: "Verify Worker", conclusion: "failure" }] }] };
  }, "123");
  assert.deepEqual(result.failed, [{ job: "release", step: "Verify Worker", conclusion: "failure" }]);
  assert.match(calls[1], /attempts\/2\/jobs/);
  assert.match(result.next, /not a rerun/);
});
test("status rejects foreign evidence and malformed run IDs", async () => {
  await assert.rejects(releaseStatus(async () => { throw Error("should not query"); }, "../123"), /numeric/);
  await assert.rejects(releaseStatus(async () => ({ id: 123, repository, head_repository: {} }), 123), /personal/);
});
