import { isDeepStrictEqual as equal } from "node:util";

const check = value => { if (!value) throw new Error("Native Terraform review failed: unreviewed state observation."); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const policyEqual = (a, b) => equal(canonical(JSON.parse(a)), canonical(JSON.parse(b)));
const emptyFields = {
  "aws_cloudwatch_log_group.failure": { tags: {} },
  "aws_iam_role.failure": { tags: {} },
  "aws_lambda_event_source_mapping.failures[0]": { queues: [], tags: {}, topics: [] },
  "aws_lambda_function.failure[0]": { layers: [], tags: {} },
  "aws_sqs_queue.failure_dead_letter": { tags: {} },
  "aws_sqs_queue.failures": { tags: {} },
  "aws_lambda_event_source_mapping.failures": { queues: [], tags: {}, topics: [] },
  "aws_lambda_function.failures": { layers: [], tags: {} },
  "aws_lambda_function.renderer": { layers: [], tags: {} },
};
const roleChildren = { "aws_iam_role.runtime": ["aws_iam_role_policy.runtime", "aws_iam_role_policy.failure_destination"],
  "aws_iam_role.failure": ["aws_iam_role_policy.failure"] };

function isFailureImageConfigNormalization(address, field, before, after) {
  return field === "image_config" && ["aws_lambda_function.failure[0]", "aws_lambda_function.failures"].includes(address) &&
    equal(before, [{ command: ["aws-lambda/failure-entry.handler"], entry_point: null, working_directory: "" }]) &&
    equal(after, [{ command: ["aws-lambda/failure-entry.handler"], entry_point: [], working_directory: "" }]);
}

// Terraform providers commonly read an unset collection back as an empty
// collection. Keep that compatibility rule in one place, while requiring an
// exact address, field and before/after value for every accepted observation.
export function normalizeTerraformObservation(address, before, after) {
  const restored = structuredClone(after), fields = Object.keys(after).filter(key => !equal(before[key], after[key]));
  for (const field of fields) {
    if (field === "inline_policy" && Object.hasOwn(roleChildren, address)) {
      restored[field] = before[field];
      continue;
    }
    const expected = emptyFields[address]?.[field];
    check((expected !== undefined && before[field] === null && equal(after[field], expected)) ||
      isFailureImageConfigNormalization(address, field, before[field], after[field]));
    restored[field] = before[field];
  }
  return { restored, fields };
}

// First-refresh observations from the existing, independently managed child
// resources. This does not allow drift in permissions, tags, code or settings.
export function verifyDevelopmentObservations(plan) {
  const seen = new Set();
  const reviewed = [];
  for (const drift of plan.resource_drift ?? []) {
    check(!seen.has(drift.address) && drift.mode === "managed" && drift.provider_name === "registry.terraform.io/hashicorp/aws" &&
      equal(drift.change.actions, ["update"]) && !drift.previous_address && !drift.change.importing);
    seen.add(drift.address);
    const resource = plan.resource_changes.find(item => item.address === drift.address);
    check(resource && equal(resource.change.before, drift.change.after));
    const { before, after } = drift.change;
    const normalized = normalizeTerraformObservation(drift.address, before, after);
    const restored = normalized.restored;
    const fields = normalized.fields;
    for (const field of fields) {
      if (field === "inline_policy" && Object.hasOwn(roleChildren, drift.address)) {
        // Parent role inline policies are read back from separately managed
        // child resources. This is a relationship check, not a normalisation.
        check(equal(resource.change.actions, ["no-op"]));
        const children = roleChildren[drift.address].map(address => plan.resource_changes.find(item => item.address === address));
        check(children.every(child => child && equal(child.change.actions, ["no-op"]) && child.change.after.role === after.name));
        check(after.inline_policy.length === children.length && new Set(after.inline_policy.map(item => item.name)).size === children.length);
        for (const policy of after.inline_policy) {
          const child = children.find(item => item.change.after.name === policy.name);
          check(child && policyEqual(policy.policy, child.change.after.policy));
        }
        check(before.inline_policy.every(policy => after.inline_policy.some(item => item.name === policy.name && policyEqual(item.policy, policy.policy))));
      } else if (!Object.hasOwn(emptyFields[drift.address] ?? {}, field) && !isFailureImageConfigNormalization(drift.address, field, before[field], after[field])) {
        check(false);
      }
    }
    check(equal(restored, before));
    reviewed.push({ address: drift.address, fields });
  }
  return reviewed;
}
