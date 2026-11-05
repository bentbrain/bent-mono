import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { inspectHealthAccessState, inspectHealthAccessPlan, healthAccessArguments } from "./aws-personal-health-access.mjs";
import { developmentBucketInspectionPermissions, developmentHealthProbePermissions } from "./native-development-permissions.mjs";
const addresses = ["aws_iam_policy.ci_boundary", "aws_iam_role.ci", "aws_iam_role_policy.ci", "aws_kms_alias.state", "aws_kms_key.state",
    "aws_s3_bucket.state", "aws_s3_bucket_ownership_controls.state", "aws_s3_bucket_policy.state", "aws_s3_bucket_public_access_block.state",
    "aws_s3_bucket_server_side_encryption_configuration.state", "aws_s3_bucket_versioning.state"];
function state() {
    return { version: 4, serial: 23, lineage: protectedConfig("resource_7ee824431a13"), resources: [
            ...addresses.map(address => {
                const [type, name] = address.split(".");
                return { type, name, mode: "managed",
                    provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes: { policy: JSON.stringify(developmentBucketInspectionPermissions()) } }] };
            }),
            { type: "aws_iam_openid_connect_provider", name: "github", mode: "data", provider: 'provider["registry.terraform.io/hashicorp/aws"]' },
        ] };
}
test("health permission update uses the current remote bootstrap state and retains a fixed lineage/inventory", () => {
    assert.equal(inspectHealthAccessState(state()).serial, 23);
    for (const change of [value => { value.serial = 22; }, value => { value.lineage = "other"; },
        value => { value.resources.pop(); }, value => { value.resources[0].instances[0].attributes.policy = "{}"; }]) {
        const altered = state();
        change(altered);
        assert.throws(() => inspectHealthAccessState(altered));
    }
    const after = state();
    after.serial = 24;
    for (const item of after.resources.filter(item => ["aws_iam_policy", "aws_iam_role_policy"].includes(item.type))) {
        item.instances[0].attributes.policy = JSON.stringify(developmentHealthProbePermissions());
    }
    assert.equal(inspectHealthAccessState(after, true).serial, 24);
    assert.throws(() => inspectHealthAccessState(after));
});
function plan() {
    const beforePolicy = JSON.stringify(developmentBucketInspectionPermissions()), afterPolicy = JSON.stringify(developmentHealthProbePermissions());
    const role = { permissions_boundary: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":policy/forever-tee-video-development-ci-boundary", assume_role_policy: JSON.stringify({ Version: "2012-10-17",
            Statement: [{ Sid: "ExactPersonalRepositoryPreview", Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
                    Principal: { Federated: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":oidc-provider/token.actions.githubusercontent.com" },
                    Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                            "token.actions.githubusercontent.com:sub": "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview" } } }] }) };
    return { terraform_version: "1.12.2", complete: true, applyable: true, errored: false, output_changes: {},
        resource_changes: addresses.map(address => {
            const before = address === "aws_iam_role.ci" ? role : address === "aws_iam_policy.ci_boundary"
                ? { name: "forever-tee-video-development-ci-boundary", policy: beforePolicy }
                : address === "aws_iam_role_policy.ci" ? { name: "development-state-and-inspection", role: "forever-tee-video-development-ci", policy: beforePolicy } : {};
            const after = before.policy ? { ...before, policy: afterPolicy } : before;
            return { address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws", change: { actions: [before === after ? "no-op" : "update"], before, after } };
        }) };
}
test("saved health-access plans can add only invocation on the two existing Development functions", () => {
    assert.equal(inspectHealthAccessPlan(plan()).addedAction, "lambda:InvokeFunction");
    for (const change of [value => { value.resource_changes[3].address = "foreign"; },
        value => { value.resource_changes[3].change.after = { extra: true }; },
        value => { value.resource_changes[0].change.after.policy = "{}"; },
        value => { value.resource_changes[0].change.actions = ["delete", "create"]; },
        value => { value.resource_changes[0].provider_name = "other"; }, value => { value.deferred_changes = [{}]; }]) {
        const altered = plan();
        change(altered);
        assert.throws(() => inspectHealthAccessPlan(altered));
    }
    assert.equal(healthAccessArguments(["plan"]).operation, "plan");
    assert.equal(healthAccessArguments(["apply", "--review=health-access-ABC123", `--plan-sha256=${"a".repeat(64)}`]).review, "health-access-ABC123");
    for (const args of [["apply"], ["plan", "--production"], ["apply", "--review=bucket-access-ABC123", `--plan-sha256=${"a".repeat(64)}`]])
        assert.throws(() => healthAccessArguments(args));
});
