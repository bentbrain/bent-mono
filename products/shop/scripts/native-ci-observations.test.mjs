import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTerraformObservation, verifyDevelopmentObservations } from "./native-ci-observations.mjs";

const provider = { mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws" };
function fixture() {
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: "exact-queue" }] });
  const before = { name: "exact-role", inline_policy: [], tags: null };
  const after = { ...before, inline_policy: [{ name: "exact-policy", policy }], tags: {} };
  return { resource_changes: [
    { ...provider, address: "aws_iam_role.failure", change: { actions: ["no-op"], before: after, after } },
    { ...provider, address: "aws_iam_role_policy.failure", change: { actions: ["no-op"], after: { name: "exact-policy", policy, role: "exact-role" } } },
  ], resource_drift: [{ ...provider, address: "aws_iam_role.failure", change: { actions: ["update"], before, after } }] };
}
test("only exact existing child policy observations and null-to-empty normalization pass", () => {
  assert.equal(verifyDevelopmentObservations(fixture()).length, 1);
  for (const change of [
    p => { p.resource_drift[0].change.actions = ["delete"]; },
    p => { p.resource_drift[0].change.after.tags = { Unexpected: "tag" }; },
    p => { p.resource_changes[1].change.actions = ["update"]; },
    p => { p.resource_changes[1].change.after.role = "wrong-role"; },
    p => { p.resource_drift[0].change.after.inline_policy.push({ name: "extra", policy: "{}" }); },
    p => { p.resource_drift[0].change.after.inline_policy[0].policy = "{}"; },
    p => { p.resource_drift[0].change.before.inline_policy = [{ name: "old-policy", policy: "{}" }]; },
    p => { p.resource_drift[0].change.before.name = "another-role"; },
    p => { p.resource_drift.push(p.resource_drift[0]); },
  ]) {
    const plan = fixture(); change(plan);
    assert.throws(() => verifyDevelopmentObservations(plan));
  }
});
test("a missing source bucket, changed runtime or unrecognized drift is never normalized away", () => {
  for (const address of ["aws_s3_bucket.source", "aws_lambda_function.renderer[0]", "unknown"]) {
    const plan = { resource_drift: [{ ...provider, address, change: { actions: ["update"], before: { value: null }, after: { value: [] } } }],
      resource_changes: [{ address, change: { before: { value: [] } } }] };
    assert.throws(() => verifyDevelopmentObservations(plan));
  }
});

test("the shared provider normalizer covers the Production image readback shape", () => {
  const before = { layers: null, tags: null };
  const after = { layers: [], tags: {} };
  assert.deepEqual(normalizeTerraformObservation("aws_lambda_function.renderer", before, after), {
    restored: before,
    fields: ["layers", "tags"],
  });
  const failureBefore = { image_config: [{ command: ["aws-lambda/failure-entry.handler"], entry_point: null, working_directory: "" }] };
  const failureAfter = { image_config: [{ command: ["aws-lambda/failure-entry.handler"], entry_point: [], working_directory: "" }] };
  assert.deepEqual(normalizeTerraformObservation("aws_lambda_function.failures", failureBefore, failureAfter), {
    restored: failureBefore,
    fields: ["image_config"],
  });
  assert.throws(() => normalizeTerraformObservation("aws_lambda_function.other", before, after));
});
