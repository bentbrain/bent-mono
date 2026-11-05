import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { developmentCIPermissions } from "./aws-personal-bootstrap.mjs";
import { developmentReleasePermissions, developmentRefreshPermissions, developmentBucketInspectionPermissions, developmentHealthProbePermissions } from "./native-development-permissions.mjs";
import { inspectReleaseAccess, inspectRefreshAccess, inspectBucketAccess, releaseAccessArguments } from "./aws-personal-release-access.mjs";
test("Development release policy matches Terraform, fits the managed-policy quota, and grants no IAM writes or production", async () => {
    const policy = developmentHealthProbePermissions();
    assert.deepEqual(policy, JSON.parse(resolveProtectedTemplate(await readFile(new URL("../infra/story-video-development-bootstrap/development-release-policy.json", import.meta.url)))));
    assert.ok(JSON.stringify(policy).length <= 6144);
    assert.doesNotMatch(JSON.stringify(policy), /production|iam:(Create|Update|Put|Attach|Delete|Pass)|s3:DeleteObjectVersion/);
    const functions = policy.Statement.find(statement => Array.isArray(statement.Action) && statement.Action.includes("lambda:InvokeFunction"));
    assert.deepEqual(functions.Resource, ["arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development", "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development-failures"]);
    const restored = structuredClone(policy);
    const target = restored.Statement.find(statement => Array.isArray(statement.Action) && statement.Action.includes("lambda:InvokeFunction"));
    target.Action = target.Action.filter(action => action !== "lambda:InvokeFunction");
    assert.deepEqual(restored, developmentBucketInspectionPermissions());
    for (const statement of policy.Statement) {
        if (statement.Resource === "*") {
            assert.deepEqual(statement.Action, ["lambda:GetAccountSettings", "logs:DescribeLogGroups", "cloudwatch:GetMetricStatistics"]);
            assert.equal(statement.Condition.StringEquals["aws:RequestedRegion"], "ap-southeast-2");
        }
    }
});
test("source bucket refresh correction adds only the three documented read actions, without state-bucket expansion", () => {
    const before = developmentRefreshPermissions(), after = developmentBucketInspectionPermissions();
    const restored = structuredClone(after);
    const statement = restored.Statement.find(item => Array.isArray(item.Action) && item.Action.includes("s3:GetBucketAcl"));
    assert.equal(statement.Resource, "arn:aws:s3:::forever-tee-video-development-" + protectedConfig("awsAccountId") + "-ap-southeast-2");
    assert.deepEqual(statement.Action.splice(-3), ["s3:ListBucket", "s3:GetBucketRequestPayment", "s3:GetBucketLogging"]);
    assert.deepEqual(restored, before);
    const plan = fixture();
    for (const resource of plan.resource_changes.slice(0, 2)) {
        resource.change.before.policy = JSON.stringify(before);
        resource.change.after.policy = JSON.stringify(after);
    }
    assert.equal(inspectBucketAccess(plan).addedActions.length, 3);
    const role = plan.resource_changes[2];
    const previous = { ...role.change.after, inline_policy: [{ name: "development-state-and-inspection", policy: JSON.stringify(developmentReleasePermissions()) }] };
    const current = { ...role.change.after, inline_policy: [{ name: "development-state-and-inspection", policy: JSON.stringify(before) }] };
    role.change.before = current;
    role.change.after = current;
    plan.resource_drift = [{ address: role.address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
            change: { actions: ["update"], before: previous, after: current } }];
    assert.equal(inspectBucketAccess(plan).observations.length, 1);
});
test("refresh correction adds only version listing on the existing Development function pair", () => {
    const old = developmentReleasePermissions(), next = developmentRefreshPermissions();
    const adjusted = structuredClone(next);
    const functions = adjusted.Statement.find(statement => statement.Action.includes("lambda:ListVersionsByFunction"));
    assert.deepEqual(functions.Resource, [
        "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development",
        "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:forever-tee-video-development-failures",
    ]);
    functions.Action = functions.Action.filter(action => action !== "lambda:ListVersionsByFunction");
    assert.deepEqual(adjusted, old);
    const plan = fixture();
    for (const resource of plan.resource_changes.slice(0, 2)) {
        resource.change.before.policy = JSON.stringify(old);
        resource.change.after.policy = JSON.stringify(next);
    }
    assert.equal(inspectRefreshAccess(plan).addedAction, "lambda:ListVersionsByFunction");
    const observed = structuredClone(plan);
    const role = observed.resource_changes[2];
    const oldRole = { ...role.change.after, inline_policy: [{ name: "development-state-and-inspection", policy: JSON.stringify(developmentCIPermissions()) }] };
    const liveRole = { ...role.change.after, inline_policy: [{ name: "development-state-and-inspection", policy: JSON.stringify(old) }] };
    role.change.before = liveRole;
    role.change.after = liveRole;
    observed.resource_drift = [{ address: role.address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
            change: { actions: ["update"], before: oldRole, after: liveRole } }];
    assert.equal(inspectRefreshAccess(observed).observations.length, 1);
    const unrelated = structuredClone(observed);
    unrelated.resource_drift[0].change.after.max_session_duration = 7200;
    assert.throws(() => inspectRefreshAccess(unrelated));
    const altered = structuredClone(plan);
    const broader = structuredClone(next);
    broader.Statement[0].Resource = "*";
    altered.resource_changes[0].change.after.policy = JSON.stringify(broader);
    assert.throws(() => inspectRefreshAccess(altered));
    assert.deepEqual(releaseAccessArguments(["apply", "--review=refresh-access-ABC123", `--plan-sha256=${"a".repeat(64)}`], "refresh-access"), { operation: "apply", review: "refresh-access-ABC123", hash: "a".repeat(64) });
    assert.throws(() => releaseAccessArguments(["apply", "--review=release-access-ABC123", `--plan-sha256=${"a".repeat(64)}`], "refresh-access"));
});
function fixture() {
    const resource = (address, before, after = before) => ({ address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
        change: { before, after, actions: [before === after ? "no-op" : "update"] } });
    const policy = JSON.stringify(developmentCIPermissions());
    const changed = JSON.stringify(developmentReleasePermissions());
    const boundary = { name: "forever-tee-video-development-ci-boundary", policy };
    const inline = { name: "development-state-and-inspection", role: "forever-tee-video-development-ci", policy };
    const role = { permissions_boundary: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":policy/forever-tee-video-development-ci-boundary", assume_role_policy: JSON.stringify({ Version: "2012-10-17",
            Statement: [{ Sid: "ExactPersonalRepositoryPreview", Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
                    Principal: { Federated: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":oidc-provider/token.actions.githubusercontent.com" },
                    Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                            "token.actions.githubusercontent.com:sub": "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview" } } }] }) };
    return { complete: true, applyable: true, output_changes: { ci_assumption_enabled: { actions: ["no-op"] } }, resource_changes: [
            resource("aws_iam_policy.ci_boundary", boundary, { ...boundary, policy: changed }),
            resource("aws_iam_role_policy.ci", inline, { ...inline, policy: changed }), resource("aws_iam_role.ci", role),
            ...Array.from({ length: 8 }, (_, index) => resource(`unchanged-${index}`, {})),
        ] };
}
test("release access guard accepts only the paired in-place boundary and inline permission update", () => {
    assert.equal(inspectReleaseAccess(fixture()).productionAccess, false);
    for (const change of [plan => { plan.resource_changes[0].change.actions = ["delete", "create"]; },
        plan => { plan.resource_changes[0].change.after.policy = "{}"; },
        plan => { plan.resource_changes[2].change.actions = ["update"]; },
        plan => { plan.resource_changes[2].change.after.assume_role_policy = JSON.stringify({ Statement: [] }); },
        plan => { plan.resource_drift = [{}]; }, plan => { plan.output_changes.other = { actions: ["create"] }; }]) {
        const plan = fixture();
        change(plan);
        assert.throws(() => inspectReleaseAccess(plan));
    }
    assert.equal(releaseAccessArguments(["plan"]).operation, "plan");
    for (const args of [["apply"], ["plan", "--production"], ["plan", "-target=aws_iam_role.ci"]])
        assert.throws(() => releaseAccessArguments(args));
});
