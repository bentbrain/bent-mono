import assert from "node:assert/strict";
import test from "node:test";
import { checkOwnedLock, expectServiceFailure } from "./native-ci-lock-check.mjs";
import { STATE_KMS } from "./native-ci-aws.mjs";

test("CI negative checks require the exact denial and never count a network failure as a passing guard", async () => {
  await expectServiceFailure(async () => { throw Object.assign(new Error(), { code: "AccessDenied" }); }, "AccessDenied");
  await assert.rejects(expectServiceFailure(async () => {}, "AccessDenied"));
  await assert.rejects(expectServiceFailure(async () => { throw new Error("network"); }, "AccessDenied"));
});
test("lock check writes only a fresh owned lock and refuses cleanup after an uncertain or foreign response", async () => {
  for (const corrupt of [false, true]) {
    let created = false, deleted = false;
    const argsSeen = [];
    const owned = { ETag: '"fixture"', VersionId: "version-1", ServerSideEncryption: "aws:kms", SSEKMSKeyId: STATE_KMS };
    const call = async args => {
      argsSeen.push(args);
      const error = code => { throw Object.assign(new Error(), { code }); };
      if (args[1] === "head-object") return error("404");
      if (args[1] === "put-object") {
        if (!args.includes("--ssekms-key-id") || args.some(arg => arg.includes("ci-denied-probe"))) return error("AccessDenied");
        if (created) return error("PreconditionFailed");
        created = true; return owned;
      }
      if (args[1] === "get-object") return owned;
      if (args[1] === "delete-object") { deleted = true; assert.ok(args.includes("--if-match")); return {}; }
      assert.fail("unexpected command");
    };
    const run = () => checkOwnedLock({ call, body: "fixture", path: "/tmp/lock", read: async () => corrupt ? "changed" : "fixture", runId: "123" });
    if (corrupt) { await assert.rejects(run()); assert.equal(deleted, false); }
    else { assert.equal((await run()).stateDataTouched, false); assert.equal(deleted, true); }
    assert.ok(argsSeen.every(args => !args.includes("story-video/development/terraform.tfstate")));
  }
});
