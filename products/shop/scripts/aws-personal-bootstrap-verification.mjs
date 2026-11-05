import { inspectBootstrapPlan } from "./aws-personal-bootstrap.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const policyEqual = (left, right) => typeof left === "string" && typeof right === "string" && equal(JSON.parse(left), JSON.parse(right));
function requireReadback(condition) {
  if (!condition) throw new Error("Bootstrap readback has unexpected changes; manual investigation required, no apply authorized.");
}

export function verifyBootstrapReadback(plan) {
  requireReadback(plan?.complete === true && plan.errored !== true && Array.isArray(plan.resource_changes));
  requireReadback(plan.resource_changes.every(resource => equal(resource.change?.actions, ["no-op"])));
  const resources = new Map(plan.resource_changes.map(resource => [resource.address, resource.change.after]));
  const observations = [];
  const seen = new Set();
  for (const drift of plan.resource_drift ?? []) {
    requireReadback(!seen.has(drift.address) && drift.mode === "managed" &&
      drift.provider_name === "registry.terraform.io/hashicorp/aws" && equal(drift.change?.actions, ["update"]));
    seen.add(drift.address);
    requireReadback(["aws_iam_policy.ci_boundary", "aws_iam_role.ci", "aws_kms_key.state", "aws_s3_bucket.state"].includes(drift.address));
    const { before, after } = drift.change;
    requireReadback(before && after && equal(after, resources.get(drift.address)));
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !equal(before[key], after[key]));
    for (const key of keys) {
      let allowed = key === "tags" && before[key] === null && equal(after[key], {});
      if (drift.address === "aws_iam_role.ci" && key === "inline_policy") {
        const child = resources.get("aws_iam_role_policy.ci");
        allowed = equal(before[key], []) && after[key]?.length === 1 &&
          after[key][0].name === child?.name && policyEqual(after[key][0].policy, child?.policy);
      }
      if (drift.address === "aws_s3_bucket.state") {
        if (key === "policy") allowed = before[key] === "" && policyEqual(after[key], resources.get("aws_s3_bucket_policy.state")?.policy);
        if (key === "server_side_encryption_configuration") {
          const rules = resources.get("aws_s3_bucket_server_side_encryption_configuration.state")?.rule;
          // The legacy parent-bucket readback omits the child's SSE-C block
          // setting. Compare only fields that the parent actually exposes.
          allowed = Array.isArray(rules) && equal(before[key], [{ rule: [{
            apply_server_side_encryption_by_default: [{ kms_master_key_id: "", sse_algorithm: "AES256" }], bucket_key_enabled: false,
          }] }]) && equal(after[key], [{ rule: rules.map(rule => ({
            apply_server_side_encryption_by_default: rule.apply_server_side_encryption_by_default,
            bucket_key_enabled: rule.bucket_key_enabled,
          })) }]);
        }
        if (key === "versioning") allowed = equal(before[key], [{ enabled: false, mfa_delete: false }]) &&
          equal(after[key], [{ enabled: true, mfa_delete: false }]) &&
          resources.get("aws_s3_bucket_versioning.state")?.versioning_configuration?.[0]?.status === "Enabled";
      }
      requireReadback(allowed);
    }
    observations.push({ address: drift.address, fields: keys });
  }
  // These are verified observations of separately managed child resources, not
  // changes to apply. The creation-plan guard still rejects all resource drift.
  const inspected = inspectBootstrapPlan({ ...plan, resource_drift: [] });
  return { status: "live-configuration-matches", accountId: inspected.accountId, region: inspected.region,
    resources: inspected.changes.length, infrastructureChanges: 0, ciEnabled: false,
    readAfterCreateObservations: observations, applyAuthorized: false, remoteStateMigrated: false, lockContentionTested: false };
}
