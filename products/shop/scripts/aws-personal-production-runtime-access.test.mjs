import test from "node:test";
import assert from "node:assert/strict";
import { inspectRuntimeAccessPlan, runtimeAccessArguments, RUNTIME_ADDITIONS } from "./aws-personal-production-runtime-access.mjs";
import { EXISTING_BOOTSTRAP, PRODUCTION_BOOTSTRAP_ADDITIONS } from "./aws-personal-production-bootstrap.mjs";
import { productionFoundationPermissions, productionAlertReadPermissions } from "./native-production-permissions.mjs";
import { productionReleasePermissions, productionRuntimeTerraform, RUNTIME_IDENTITIES, identityName, identityBoundaryArn } from "./native-production-runtime-permissions.mjs";
import { validatePersonalArguments } from "./aws-personal-guard.mjs";

const targets = ["aws_iam_policy.production_ci_boundary", "aws_iam_role_policy.production_ci"];
const provider = "registry.terraform.io/hashicorp/aws";
function fixture() {
  const resources = productionRuntimeTerraform().resource;
  return { terraform_version: "1.12.2", complete: true, applyable: true, errored: false, output_changes: {},
    resource_changes: [...EXISTING_BOOTSTRAP, ...PRODUCTION_BOOTSTRAP_ADDITIONS, ...RUNTIME_ADDITIONS].map(address => {
      let change = { actions: ["no-op"], before: {}, after: {} };
      if (targets.includes(address)) change = { actions: ["update"], before: { policy: JSON.stringify(productionAlertReadPermissions()) }, after: { policy: JSON.stringify(productionReleasePermissions()) } };
      if (RUNTIME_ADDITIONS.includes(address)) {
        const [type, name] = address.split("."), after = structuredClone(resources[type][name]);
        delete after.lifecycle; delete after.depends_on;
        change = { actions: ["create"], before: null, after, after_unknown: { arn: true, id: true, ...(after.tags ? { tags: {} } : {}) } };
      }
      return { address, mode: "managed", provider_name: provider, change };
    }) };
}
const entry = (value, address) => value.resource_changes.find(item => item.address === address);
test("runtime bootstrap accepts only nine new protected identities and the exact two policy updates", () => {
  const result = inspectRuntimeAccessPlan(fixture());
  assert.equal(result.creates.length, 9); assert.deepEqual(result.updates, targets); assert.equal(result.deletes, 0);
  assert.equal(result.serviceKeysCreated, false); assert.equal(result.applicationDeployment, false);
  for (const mutate of [
    value => { value.complete = false; }, value => { value.applyable = false; }, value => { value.errored = true; },
    value => { value.deferred_changes = [{}]; }, value => { value.resource_changes.pop(); },
    value => { value.resource_changes.push(value.resource_changes[0]); }, value => { value.output_changes = { extra: { actions: ["create"] } }; },
    value => { entry(value, targets[0]).change.actions = ["delete", "create"]; },
    value => { entry(value, targets[0]).change.after.policy = "{}"; }, value => { entry(value, targets[1]).change.before.policy = "{}"; },
    value => { entry(value, targets[0]).change.after_unknown = { policy: true }; },
    value => { entry(value, "aws_iam_role.production_ci").change.after.assume_role_policy = "{}"; },
    value => { entry(value, "aws_iam_role.ci").change.actions = ["update"]; },
    value => { entry(value, RUNTIME_ADDITIONS[0]).change.before = {}; },
    value => { entry(value, RUNTIME_ADDITIONS[0]).change.actions = ["no-op"]; },
    value => { entry(value, RUNTIME_ADDITIONS[0]).change.importing = {}; },
    value => { entry(value, RUNTIME_ADDITIONS[0]).previous_address = "other"; },
    value => { entry(value, RUNTIME_ADDITIONS[0]).provider_name = "other"; },
    value => { entry(value, "aws_iam_user.production_invoker").change.after.permissions_boundary = null; },
    value => { entry(value, "aws_iam_user.production_invoker").change.after.force_destroy = true; },
    value => { entry(value, "aws_iam_role.production_runtime").change.after.assume_role_policy = "{}"; },
    value => { entry(value, "aws_iam_role.production_runtime").change.after.managed_policy_arns = ["admin"]; },
    value => { entry(value, "aws_iam_role.production_runtime").change.after_unknown.permissions_boundary = true; },
    value => { entry(value, "aws_iam_role.production_runtime").change.after_unknown.tags = { Environment: true }; },
    value => { entry(value, "aws_iam_role_policy.production_runtime").change.after.policy = "{}"; },
    value => { value.resource_drift = [{}]; },
  ]) { const value = fixture(); mutate(value); assert.throws(() => inspectRuntimeAccessPlan(value)); }
});
test("runtime bootstrap accepts only the known readback of the corrected SNS child policy", () => {
  const value = fixture(), role = entry(value, "aws_iam_role.production_ci");
  const make = policy => ({ inline_policy: [{ name: "production-foundation", policy: JSON.stringify(policy) }], name: "unchanged" });
  role.change.before = make(productionAlertReadPermissions()); role.change.after = structuredClone(role.change.before);
  value.resource_drift = [{ address: role.address, mode: "managed", provider_name: provider,
    change: { actions: ["update"], before: make(productionFoundationPermissions()), after: structuredClone(role.change.before) } }];
  assert.equal(inspectRuntimeAccessPlan(value).creates.length, 9);
  for (const mutate of [
    value => { value.resource_drift[0].change.after.name = "changed"; },
    value => { value.resource_drift[0].change.after.inline_policy[0].policy = "{}"; },
    value => { value.resource_drift.push(value.resource_drift[0]); },
    value => { value.resource_drift[0].address = "aws_iam_role.ci"; },
  ]) { const copy = structuredClone(value); mutate(copy); assert.throws(() => inspectRuntimeAccessPlan(copy)); }
});
test("runtime access requires its own exact saved review and cannot select arbitrary Terraform operations", () => {
  assert.deepEqual(runtimeAccessArguments(["plan"]), { operation: "plan" });
  assert.equal(runtimeAccessArguments(["apply", "--review=production-runtime-access-ABC123", `--plan-sha256=${"a".repeat(64)}`]).operation, "apply");
  for (const args of [["apply"], ["plan", "-target=x"], ["destroy"], ["apply", "--review=production-alert-access-ABC123", `--plan-sha256=${"a".repeat(64)}`]])
    assert.throws(() => runtimeAccessArguments(args));
});
test("local runtime discovery permits exact collision reads without Production service-key writes", () => {
  for (const kind of RUNTIME_IDENTITIES) {
    assert.doesNotThrow(() => validatePersonalArguments(["iam", kind === "invoker" ? "get-user" : "get-role", kind === "invoker" ? "--user-name" : "--role-name", identityName(kind)]));
    assert.doesNotThrow(() => validatePersonalArguments(["iam", "get-policy", "--policy-arn", identityBoundaryArn(kind)]));
  }
  for (const args of [
    ["iam", "create-access-key", "--user-name", identityName("invoker")],
    ["iam", "list-access-keys", "--user-name", identityName("invoker")],
    ["iam", "get-role", "--role-name", "forever-tee-video-production-other"],
    ["iam", "create-role", "--role-name", identityName("runtime")],
    ["iam", "delete-user", "--user-name", identityName("invoker")],
  ]) assert.throws(() => validatePersonalArguments(args));
});
