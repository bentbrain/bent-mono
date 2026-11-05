import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { inspectProductionBootstrapPlan, productionBootstrapArguments, EXISTING_BOOTSTRAP, PRODUCTION_BOOTSTRAP_ADDITIONS, inspectProductionBootstrapState, verifyProductionGitHub } from "./aws-personal-production-bootstrap.mjs";
import { productionFoundationPermissions, productionAlertReadPermissions, productionTrust, productionStateStatements, PRODUCTION_BOUNDARY_ARN } from "./native-production-permissions.mjs";
import { developmentHealthProbePermissions, developmentBucketInspectionPermissions } from "./native-development-permissions.mjs";
import { validatePersonalArguments } from "./aws-personal-guard.mjs";
function values() {
    return {
        "aws_iam_policy.production_ci_boundary": { name: "forever-tee-video-production-ci-boundary", policy: JSON.stringify(productionFoundationPermissions()), path: "/" },
        "aws_iam_role.production_ci": { name: "forever-tee-video-production-ci", max_session_duration: 3600, permissions_boundary: PRODUCTION_BOUNDARY_ARN, assume_role_policy: JSON.stringify(productionTrust()), path: "/" },
        "aws_iam_role_policy.production_ci": { name: "production-foundation", role: "forever-tee-video-production-ci", policy: JSON.stringify(productionFoundationPermissions()) },
        "aws_iam_policy.ci_boundary": { policy: JSON.stringify(developmentHealthProbePermissions()) },
        "aws_iam_role_policy.ci": { policy: JSON.stringify(developmentHealthProbePermissions()) },
        "aws_s3_bucket_policy.state": { policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "ExistingPolicyMustSurvive" }] }) },
    };
}
function plan() {
    const attributes = values();
    return { terraform_version: "1.12.2", complete: true, applyable: true, errored: false, output_changes: {}, resource_changes: [...EXISTING_BOOTSTRAP, ...PRODUCTION_BOOTSTRAP_ADDITIONS].map(address => {
            const after = attributes[address] ?? {};
            const added = PRODUCTION_BOOTSTRAP_ADDITIONS.includes(address);
            const before = added ? null : structuredClone(after);
            const policy = address === "aws_s3_bucket_policy.state";
            if (policy)
                after.policy = JSON.stringify({ Version: "2012-10-17", Statement: [...JSON.parse(before.policy).Statement, ...productionStateStatements()] });
            return { address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws", change: { actions: [added ? "create" : policy ? "update" : "no-op"], before, after } };
        }) };
}
function state(applied = false) {
    const input = plan();
    return { version: 4, lineage: protectedConfig("resource_7ee824431a13"), serial: applied ? 25 : 24, resources: [
            ...input.resource_changes.filter(item => applied || !PRODUCTION_BOOTSTRAP_ADDITIONS.includes(item.address)).map(item => {
                const [type, name] = item.address.split(".");
                return { type, name, mode: "managed", provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes: applied ? item.change.after : item.change.before }] };
            }), { type: "aws_iam_openid_connect_provider", name: "github", mode: "data", provider: 'provider["registry.terraform.io/hashicorp/aws"]', instances: [{ attributes: {} }] },
        ] };
}
test("Production bootstrap creates only its separate foundation identity and adds isolated state retention", () => {
    assert.equal(inspectProductionBootstrapPlan(plan()).ciCanWriteIAM, false);
    assert.equal(inspectProductionBootstrapState(state()).serial, 24);
    assert.equal(inspectProductionBootstrapState(state(true), true).managedResources, 14);
    const mutated = state();
    mutated.serial = 23;
    assert.throws(() => inspectProductionBootstrapState(mutated));
    assert.throws(() => inspectProductionBootstrapState(state(true)));
});
test("Production review rejects identity escalation, destructive plans and mutations of Development", () => {
    const item = (value, address) => value.resource_changes.find(item => item.address === address);
    for (const mutate of [
        value => { value.resource_changes.pop(); },
        value => { value.resource_drift = [{}]; },
        value => { value.complete = false; },
        value => { value.deferred_changes = [{}]; },
        value => { value.output_changes = { ci: { actions: ["update"] } }; },
        value => { item(value, "aws_iam_role.production_ci").change.after.permissions_boundary = "other"; },
        value => { item(value, "aws_iam_role.production_ci").change.after.assume_role_policy = "{}"; },
        value => { item(value, "aws_iam_role.production_ci").change.after.managed_policy_arns = ["AdministratorAccess"]; },
        value => { item(value, "aws_iam_role.production_ci").change.after.inline_policy = [{ policy: "{}" }]; },
        value => { item(value, "aws_iam_role.production_ci").change.after.path = "/different/"; },
        value => { item(value, "aws_iam_role.production_ci").change.after_unknown = { assume_role_policy: true }; },
        value => { item(value, "aws_iam_policy.production_ci_boundary").change.after.policy = "{}"; },
        value => { item(value, "aws_iam_policy.production_ci_boundary").change.actions = ["delete", "create"]; },
        value => { item(value, "aws_iam_role_policy.production_ci").change.before = {}; },
        value => { item(value, "aws_s3_bucket_policy.state").change.after.policy = JSON.stringify({ Statement: productionStateStatements() }); },
        value => { item(value, "aws_s3_bucket_policy.state").change.after.bucket = "other"; },
        value => { item(value, "aws_iam_role.ci").change.after = { altered: true }; },
        value => { item(value, "aws_iam_policy.ci_boundary").change.after.policy = "{}"; },
        value => { value.resource_changes[0].provider_name = "other"; },
        value => { value.resource_changes[0].change.importing = {}; },
    ]) {
        const altered = plan();
        mutate(altered);
        assert.throws(() => inspectProductionBootstrapPlan(altered));
    }
});
test("refresh accepts only the recorded parent-role observation of the already-applied Development health policy", () => {
    const value = plan(), resource = value.resource_changes.find(item => item.address === "aws_iam_role.ci");
    const after = { inline_policy: [{ name: "development-state-and-inspection", policy: JSON.stringify(developmentHealthProbePermissions()) }] };
    resource.change.before = structuredClone(after);
    resource.change.after = structuredClone(after);
    value.resource_drift = [{ address: resource.address, mode: "managed", provider_name: resource.provider_name, change: { actions: ["update"],
                before: { inline_policy: [{ name: "development-state-and-inspection", policy: JSON.stringify(developmentBucketInspectionPermissions()) }] }, after } }];
    assert.equal(inspectProductionBootstrapPlan(value).developmentPermissionsUnchanged, true);
    const corrupted = structuredClone(value);
    corrupted.resource_drift[0].change.after.inline_policy[0].policy = "{}";
    assert.throws(() => inspectProductionBootstrapPlan(corrupted));
    const extra = structuredClone(value);
    extra.resource_drift[0].change.after.assume_role_policy = "{}";
    assert.throws(() => inspectProductionBootstrapPlan(extra));
});
test("foundation policy has no IAM, deployment, deletion or Development access and matches Terraform bytes", async () => {
    const policy = productionAlertReadPermissions();
    assert.deepEqual(JSON.parse(resolveProtectedTemplate(await readFile(new URL("../infra/story-video-development-bootstrap/production-foundation-policy.json", import.meta.url)))), policy);
    assert.ok(JSON.stringify(policy).length < 6144);
    for (const item of policy.Statement) {
        const actions = Array.isArray(item.Action) ? item.Action : [item.Action];
        assert.ok(actions.every(action => !action.startsWith("iam:") && !/^(sts:|lambda:(?!GetAccountSettings)|ecr:|codebuild:)/.test(action)));
        assert.ok(actions.every(action => !action.includes("Delete") || (action === "s3:DeleteObject" && item.Resource.endsWith("production/terraform.tfstate.tflock"))));
        assert.ok(!JSON.stringify(item.Resource).includes("development"));
    }
    assert.deepEqual(policy.Statement.find(item => item.Action === "sns:Subscribe").Condition, { StringEquals: { "sns:Protocol": "email" } });
});
test("SNS subscription reads authorize against the topic resource, not a subscription ARN", async () => {
    const policy = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../infra/story-video-development-bootstrap/production-foundation-policy.json", import.meta.url))));
    const statement = policy.Statement.find(item => [item.Action].flat().includes("sns:GetSubscriptionAttributes"));
    assert.equal(statement.Resource, "arn:aws:sns:ap-southeast-2:" + protectedConfig("awsAccountId") + ":forever-tee-video-production-alerts");
});
test("guard accepts only new Production collision reads and exact review arguments", () => {
    for (const args of [["iam", "get-role", "--role-name", "forever-tee-video-production-ci"], ["iam", "get-policy", "--policy-arn", PRODUCTION_BOUNDARY_ARN]])
        assert.doesNotThrow(() => validatePersonalArguments(args));
    for (const args of [["iam", "get-user", "--user-name", "forever-tee-video-production-other"], ["iam", "get-role", "--role-name", "forever-tee-video-production-other"], ["iam", "create-access-key", "--user-name", "forever-tee-video-production-ci"]])
        assert.throws(() => validatePersonalArguments(args));
    assert.deepEqual(productionBootstrapArguments(["plan"]), { operation: "plan" });
    assert.equal(productionBootstrapArguments(["apply", "--review=production-foundation-ABC123", `--plan-sha256=${"a".repeat(64)}`]).review, "production-foundation-ABC123");
    for (const args of [["apply"], ["plan", "--target=anything"], ["apply", "--review=health-access-ABC123", `--plan-sha256=${"a".repeat(64)}`]])
        assert.throws(() => productionBootstrapArguments(args));
});
function github() {
    return { api: async (path) => path.endsWith("deployment-branch-policies") ? { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] }
            : path.endsWith("/Production") ? { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }
                : path.endsWith("/jobs") ? { total_count: 1, jobs: [{ id: 1, conclusion: "success" }] }
                    : { head_sha: "13091a19a048f97b74eed0b0ed783445c0da2796", head_branch: "main", conclusion: "success", status: "completed", event: "workflow_dispatch", run_attempt: 1,
                        path: ".github/workflows/native-production-identity.yml", repository: { id: Number(protectedConfig("githubRepositoryId")) }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) } },
        jobLog: async () => JSON.stringify({ signatureVerified: true, awsAccessAttempted: false, ref: "refs/heads/main", sourceCommit: "13091a19a048f97b74eed0b0ed783445c0da2796",
            subject: productionTrust().Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"], runId: protectedConfig("resource_930389e560c7") }) };
}
test("bootstrap activation requires live main-only protection and the exact successful signed Production run", async () => {
    assert.equal((await verifyProductionGitHub(github())).identityRun, Number(protectedConfig("resource_930389e560c7")));
    for (const change of [value => { value.jobLog = async () => ""; }, value => {
            const original = value.api;
            value.api = async (path) => {
                const result = await original(path);
                if (path.endsWith("deployment-branch-policies"))
                    result.branch_policies[0].type = "tag";
                return result;
            };
        }, value => { const original = value.api; value.api = async (path) => ({ ...await original(path), head_sha: "b".repeat(40) }); }]) {
        const altered = github();
        change(altered);
        await assert.rejects(verifyProductionGitHub(altered));
    }
});
