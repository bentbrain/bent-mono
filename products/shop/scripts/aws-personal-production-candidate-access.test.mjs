import test from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_ACCESS_INVENTORY,
  PRODUCTION_CANDIDATE_ACCESS_ID,
  candidateAccessArguments,
  hashCandidateAccessEvidence,
  inspectCandidateAccessPlan,
  normalizeCandidateParentObservations,
} from "./aws-personal-production-candidate-access.mjs";
import {
  legacyProductionReleasePermissions,
  productionRuntimePermissions,
  previousProductionReleasePermissions,
  productionReleasePermissions,
} from "./native-production-runtime-permissions.mjs";
import { productionAlertReadPermissions } from "./native-production-permissions.mjs";

const targets = new Set(["aws_iam_policy.production_ci_boundary", "aws_iam_role_policy.production_ci"]);
function plan() {
  const value = { terraform_version: "1.12.2", complete: true, applyable: true, errored: false, deferred_changes: [], resource_drift: [], output_changes: {},
    resource_changes: CANDIDATE_ACCESS_INVENTORY.map(address => {
      const before = targets.has(address) ? { address, policy: JSON.stringify(previousProductionReleasePermissions()) } : { address };
      const after = targets.has(address) ? { ...before, policy: JSON.stringify(productionReleasePermissions()) } : structuredClone(before);
      return { address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: targets.has(address) ? ["update"] : ["no-op"], before, after, after_unknown: {} } };
    }),
  };
  const observations = [["aws_iam_role.production_ci", [{ name: "production-foundation", policy: legacyProductionReleasePermissions() }],
    [{ name: "production-foundation", policy: previousProductionReleasePermissions() }]]];
  for (const [address, beforeInline, afterInline] of observations) {
    const encode = values => values.map(item => ({ ...item, policy: JSON.stringify(item.policy) }));
    const before = { address, inline_policy: encode(beforeInline) }, after = { address, inline_policy: encode(afterInline) };
    value.resource_drift.push({ address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
      change: { actions: ["update"], before, after } });
    const resource = value.resource_changes.find(item => item.address === address);
    resource.change.before = structuredClone(after); resource.change.after = structuredClone(after);
  }
  for (const kind of ["failures", "runtime"]) {
    const address = `aws_iam_role.production_${kind}`, inlinePolicy = [{ name: "production-runtime", policy: JSON.stringify(productionRuntimePermissions(kind)) }];
    const resource = value.resource_changes.find(item => item.address === address);
    resource.change.before = { address, inline_policy: inlinePolicy };
    resource.change.after = structuredClone(resource.change.before);
  }
  return value;
}

test("candidate access updates only both Production policy copies from the retired candidate to the accepted candidate", () => {
  const result = inspectCandidateAccessPlan(plan());
  assert.deepEqual(result.updates.sort(), [...targets].sort());
  assert.equal(result.grantedResources.length, 2);
  assert.equal(result.retiredResources.length, 2);
  assert.equal(result.applicationDeployment, false);
});

test("candidate access requires and normalizes the exact prior child-backed parent observations", () => {
  const role = (name, inlinePolicy) => ({ type: "aws_iam_role", name, instances: [{ attributes: { inline_policy: inlinePolicy } }] });
  const encode = (name, policy) => [{ name, policy: JSON.stringify(policy) }];
  const state = { resources: [
    role("production_ci", encode("production-foundation", legacyProductionReleasePermissions())),
    ...["failures", "runtime"].map(kind => role(`production_${kind}`, encode("production-runtime", productionRuntimePermissions(kind)))),
  ] };
  const normalized = normalizeCandidateParentObservations(state);
  assert.deepEqual(normalized.resources[0].instances[0].attributes.inline_policy,
    [{ name: "production-foundation", policy: JSON.stringify(productionAlertReadPermissions()) }]);
  assert.deepEqual(normalized.resources.slice(1).map(item => item.instances[0].attributes.inline_policy), [[], []]);
  assert.notDeepEqual(normalized, state);
  const applied = structuredClone(state);
  applied.resources[0].instances[0].attributes.inline_policy = encode("production-foundation", previousProductionReleasePermissions());
  assert.deepEqual(normalizeCandidateParentObservations(applied, true).resources[0].instances[0].attributes.inline_policy,
    [{ name: "production-foundation", policy: JSON.stringify(productionAlertReadPermissions()) }]);
  for (const mutate of [
    value => { value.resources[1].instances[0].attributes.inline_policy[0].policy = "{}"; },
    value => { value.resources.pop(); },
    value => { value.resources[1].instances[0].status = "tainted"; },
  ]) { const altered = structuredClone(state); mutate(altered); assert.throws(() => normalizeCandidateParentObservations(altered)); }
});

test("candidate apply journals the saved remote review instead of historical local state caches", async () => {
  const reads = [];
  const evidence = await hashCandidateAccessEvidence("/private/review", async path => {
    reads.push(path);
    return Buffer.from(path);
  });
  assert.deepEqual(reads, ["remote-before.tfstate", "review.json", "access.tfplan"].map(name => `/private/review/${name}`));
  assert.deepEqual(evidence.map(item => item.name), ["remote-before.tfstate", "review.json", "access.tfplan"]);
  assert.ok(evidence.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
});

test("candidate access rejects drift, partial policy changes, other resources and unreviewed arguments", () => {
  const item = (value, address) => value.resource_changes.find(change => change.address === address);
  for (const mutate of [
    value => { value.applyable = false; }, value => { value.resource_drift.pop(); }, value => { value.resource_changes.pop(); },
    value => { value.resource_drift.push({ ...value.resource_drift[0], address: "aws_iam_role.production_runtime" }); },
    value => { value.resource_drift[0].change.after.inline_policy[0].policy = JSON.stringify(productionReleasePermissions()); },
    value => { item(value, "aws_iam_policy.production_ci_boundary").change.after.policy = JSON.stringify(previousProductionReleasePermissions()); },
    value => { item(value, "aws_iam_role.production_ci").change.actions = ["update"]; },
    value => { item(value, "aws_iam_role_policy.production_ci").change.after.extra = true; },
  ]) { const value = plan(); mutate(value); assert.throws(() => inspectCandidateAccessPlan(value)); }
  assert.deepEqual(candidateAccessArguments(["plan"]), { operation: "plan" });
  assert.deepEqual(candidateAccessArguments(["apply", `--review=production-candidate-access-${PRODUCTION_CANDIDATE_ACCESS_ID}-Ab12Cd`,
    `--plan-sha256=${"a".repeat(64)}`]), { operation: "apply",
    review: `production-candidate-access-${PRODUCTION_CANDIDATE_ACCESS_ID}-Ab12Cd`, planHash: "a".repeat(64) });
  assert.throws(() => candidateAccessArguments(["apply", "--review=production-candidate-access-mOvYdE", `--plan-sha256=${"a".repeat(64)}`]));
  assert.throws(() => candidateAccessArguments(["apply"]));
  assert.throws(() => candidateAccessArguments(["plan", "--target=anything"]));
});
