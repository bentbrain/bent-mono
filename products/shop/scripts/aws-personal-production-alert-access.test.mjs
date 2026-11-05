import test from "node:test";
import assert from "node:assert/strict";
import { inspectAlertAccessPlan, alertAccessArguments } from "./aws-personal-production-alert-access.mjs";
import { EXISTING_BOOTSTRAP, PRODUCTION_BOOTSTRAP_ADDITIONS } from "./aws-personal-production-bootstrap.mjs";
import { productionFoundationPermissions, productionAlertReadPermissions, productionStateStatements } from "./native-production-permissions.mjs";

const targets = ["aws_iam_policy.production_ci_boundary", "aws_iam_role_policy.production_ci"];
function plan() {
  return { terraform_version: "1.12.2", complete: true, applyable: true, errored: false, output_changes: {},
    resource_changes: [...EXISTING_BOOTSTRAP, ...PRODUCTION_BOOTSTRAP_ADDITIONS].map(address => ({ address, mode: "managed",
      provider_name: "registry.terraform.io/hashicorp/aws", change: targets.includes(address)
        ? { actions: ["update"], before: { policy: JSON.stringify(productionFoundationPermissions()) }, after: { policy: JSON.stringify(productionAlertReadPermissions()) } }
        : { actions: ["no-op"], before: {}, after: {} } })) };
}
test("alert access corrects only the exact SNS topic read in both existing policies", () => {
  assert.deepEqual(inspectAlertAccessPlan(plan()).updates, targets);
  const previous = productionFoundationPermissions(), next = productionAlertReadPermissions();
  next.Statement.find(item => item.Sid === "P12").Resource += ":*";
  assert.deepEqual(next, previous);
  const item = (value, address = targets[0]) => value.resource_changes.find(item => item.address === address);
  for (const mutate of [
    value => { value.complete = false; }, value => { value.errored = true; }, value => { value.deferred_changes = [{}]; },
    value => { value.resource_changes.pop(); }, value => { value.output_changes = { extra: { actions: ["create"] } }; },
    value => { item(value).change.actions = ["delete", "create"]; }, value => { item(value).change.after.policy = "{}"; },
    value => { item(value).change.before.policy = "{}"; }, value => { item(value).change.after.name = "other"; },
    value => { item(value).change.after_unknown = { policy: true }; }, value => { item(value).change.importing = {}; },
    value => { item(value).provider_name = "other"; }, value => { item(value, "aws_iam_role.production_ci").change.after.description = "changed"; },
    value => { item(value, "aws_iam_role.ci").change.actions = ["update"]; }, value => { value.resource_drift = [{}]; },
  ]) { const altered = plan(); mutate(altered); assert.throws(() => inspectAlertAccessPlan(altered)); }
});
test("access correction accepts only child-backed observations from the completed foundation bootstrap", () => {
  const value = plan(), previous = { Version: "2012-10-17", Statement: [{ Sid: "Existing" }] };
  const statePolicy = JSON.stringify({ ...previous, Statement: [...previous.Statement, ...productionStateStatements()] });
  const role = value.resource_changes.find(item => item.address === "aws_iam_role.production_ci");
  const bucket = value.resource_changes.find(item => item.address === "aws_s3_bucket.state");
  const child = value.resource_changes.find(item => item.address === "aws_s3_bucket_policy.state");
  child.change.before = { policy: statePolicy }; child.change.after = structuredClone(child.change.before);
  role.change.before = { inline_policy: [{ name: "production-foundation", policy: JSON.stringify(productionFoundationPermissions()) }] };
  role.change.after = structuredClone(role.change.before);
  bucket.change.before = { policy: statePolicy }; bucket.change.after = structuredClone(bucket.change.before);
  value.resource_drift = [[role, { inline_policy: [] }], [bucket, { policy: JSON.stringify(previous) }]].map(([item, before]) => ({
    address: item.address, mode: "managed", provider_name: item.provider_name, change: { actions: ["update"], before, after: structuredClone(item.change.after) } }));
  assert.equal(inspectAlertAccessPlan(value).creates, 0);
  for (const mutate of [
    plan => { plan.resource_drift[0].change.after.inline_policy[0].policy = "{}"; },
    plan => { plan.resource_drift[0].change.after.assume_role_policy = "{}"; },
    plan => { plan.resource_drift[1].change.after.policy = "{}"; },
    plan => { plan.resource_drift.push(plan.resource_drift[0]); },
  ]) { const altered = structuredClone(value); mutate(altered); assert.throws(() => inspectAlertAccessPlan(altered)); }
});
test("access correction requires its own exact saved review and rejects overrides", () => {
  assert.deepEqual(alertAccessArguments(["plan"]), { operation: "plan" });
  assert.equal(alertAccessArguments(["apply", "--review=production-alert-access-ABC123", `--plan-sha256=${"a".repeat(64)}`]).operation, "apply");
  for (const args of [["apply"], ["plan", "-target=x"], ["apply", "--review=production-foundation-ABC123", `--plan-sha256=${"a".repeat(64)}`]]) {
    assert.throws(() => alertAccessArguments(args));
  }
});
