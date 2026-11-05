import { resolveProtectedTemplate } from "./protected-config.mjs";
import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { terraformArguments, runPersonalTerraform } from "./aws-personal-terraform.mjs";
import { bootstrapArguments, developmentCIPermissions, inspectBootstrapPlan, runPersonalBootstrap, verifyBootstrapReview } from "./aws-personal-bootstrap.mjs";
import { verifyBootstrapReadback } from "./aws-personal-bootstrap-verification.mjs";
import { activationArguments, inspectCIActivation, verifyGitHubActivation } from "./aws-personal-ci-activation.mjs";
test("Terraform accepts only the fixed development module workflow", () => {
    assert.equal(terraformArguments(["init"])[0], "init");
    assert.deepEqual(terraformArguments(["lock-provider"]), ["providers", "lock", "-platform=darwin_arm64", "-platform=linux_amd64"]);
    assert.throws(() => terraformArguments(["lock-provider", "-platform=other"]));
    assert.equal(terraformArguments(["plan"])[0], "plan");
    for (const args of [["destroy"], ["apply", "other.tfplan"], ["init", "-backend-config=work"], ["plan", "--profile=work"],
        ["plan", "--api-origin=https://evil.test"], ["plan", `--build-id=${"a".repeat(64)}`], ["plan", "-target=work"]]) {
        assert.throws(() => terraformArguments(args));
    }
});
test("wrong personal configuration stops before STS or Terraform", async () => {
    let calls = 0;
    await assert.rejects(runPersonalTerraform(["plan"], { config: "work", environment: {},
        execute: async () => { calls++; }, executeTerraform: async () => { calls++; } }));
    assert.equal(calls, 0);
});
test("Terraform discards inherited work credentials and Terraform overrides", async () => {
    const config = "[profile personal-dev]\nsso_session = personal-dev\nsso_account_id = " + protectedConfig("awsAccountId") + "\nsso_role_name = AdministratorAccess\nregion = ap-southeast-2\n[sso-session personal-dev]\nsso_start_url = " + protectedConfig("ssoStartUrl") + "\nsso_region = ap-southeast-2\nsso_registration_scopes = sso:account:access";
    let calls = 0;
    await runPersonalTerraform(["validate"], { config,
        environment: { AWS_PROFILE: "work", AWS_ACCESS_KEY_ID: "work-key", TF_CLI_ARGS: "-var=work", TF_VAR_profile: "work" },
        execute: async () => JSON.stringify({ Account: protectedConfig("awsAccountId"), Arn: "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/AWSReservedSSO_AdministratorAccess_test/personal" }),
        executeTerraform: async (command, env, cwd) => {
            calls++;
            assert.deepEqual(command, ["validate"]);
            assert.equal(env.AWS_PROFILE, "personal-dev");
            assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
            assert.equal(env.TF_CLI_ARGS, undefined);
            assert.equal(env.TF_VAR_profile, undefined);
            assert.equal(env.TF_CLI_CONFIG_FILE, "/dev/null");
            assert.ok(cwd.endsWith("infra/story-video-lambda/"));
        } });
    assert.equal(calls, 1);
});
test("Terraform module pins personal account, never stores access keys or provides public Lambda access", async () => {
    const versions = await readFile(new URL("../infra/story-video-lambda/versions.tf", import.meta.url), "utf8");
    const main = await readFile(new URL("../infra/story-video-lambda/main.tf", import.meta.url), "utf8");
    assert.match(resolveProtectedTemplate(versions), new RegExp(`allowed_account_ids\\s*=\\s*\\["${protectedConfig("awsAccountId")}"\\]`));
    assert.match(resolveProtectedTemplate(versions), /shared_credentials_files\s*=\s*\["\/dev\/null"\]/);
    assert.doesNotMatch(main, /resource "aws_iam_access_key"|resource "aws_lambda_function_url"|provisioned_concurrency/);
    assert.match(main, /memory_size\s*=\s*3008/);
});
test("bootstrap planning cannot apply, switch modules/backends or overwrite a named plan", () => {
    for (const operation of ["init", "validate", "fmt", "plan"])
        assert.equal(bootstrapArguments([operation]).operation, operation);
    assert.deepEqual(bootstrapArguments(["show", "--review=review-ABC123"]), { operation: "show", review: "review-ABC123" });
    for (const args of [["apply"], ["destroy"], ["import"], ["state", "push"], ["plan", "-out=old.tfplan"],
        ["init", "-backend-config=other"], ["show", "--review=../../other"], ["plan", "--environment=production"]]) {
        assert.throws(() => bootstrapArguments(args));
    }
});
test("bootstrap uses isolated credentials and rejects invalid configuration before Terraform", async () => {
    let calls = 0;
    const dependencies = { config: "work", environment: {}, execute: () => { calls++; }, executeTerraform: () => { calls++; } };
    await assert.rejects(runPersonalTerraform(["bootstrap", "plan"], dependencies));
    assert.equal(calls, 0);
    const config = "[profile personal-dev]\nsso_session = personal-dev\nsso_account_id = " + protectedConfig("awsAccountId") + "\nsso_role_name = AdministratorAccess\nregion = ap-southeast-2\n[sso-session personal-dev]\nsso_start_url = " + protectedConfig("ssoStartUrl") + "\nsso_region = ap-southeast-2\nsso_registration_scopes = sso:account:access";
    await runPersonalBootstrap(["validate"], { ...dependencies, config,
        environment: { AWS_ACCESS_KEY_ID: "work", TF_CLI_ARGS: "-destroy", TF_VAR_enable_ci: "true" },
        execute: () => JSON.stringify({ Account: protectedConfig("awsAccountId"), Arn: "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/AWSReservedSSO_AdministratorAccess_test/personal" }),
        executeTerraform: (command, env, cwd) => {
            assert.deepEqual(command, ["validate"]);
            assert.ok(cwd.endsWith("/infra/story-video-development-bootstrap/"));
            assert.ok(env.TF_DATA_DIR.endsWith("/.data/terraform-video-bootstrap/providers"));
            assert.equal(env.AWS_PROFILE, "personal-dev");
            for (const key of ["AWS_ACCESS_KEY_ID", "TF_CLI_ARGS", "TF_VAR_enable_ci"])
                assert.equal(env[key], undefined);
        }, });
});
function bootstrapPlan() {
    const principal = { Federated: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":oidc-provider/token.actions.githubusercontent.com" };
    const policy = JSON.stringify(developmentCIPermissions());
    const values = {
        "aws_kms_key.state": { enable_key_rotation: true, deletion_window_in_days: 30, multi_region: false, policy: "{}" },
        "aws_kms_alias.state": {},
        "aws_s3_bucket.state": { bucket: "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2", force_destroy: false },
        "aws_s3_bucket_public_access_block.state": { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true },
        "aws_s3_bucket_ownership_controls.state": {},
        "aws_s3_bucket_versioning.state": { versioning_configuration: [{ status: "Enabled" }] },
        "aws_s3_bucket_server_side_encryption_configuration.state": { rule: [{ bucket_key_enabled: false, apply_server_side_encryption_by_default: [{ sse_algorithm: "aws:kms" }] }] },
        "aws_s3_bucket_policy.state": {},
        "aws_iam_policy.ci_boundary": { name: "forever-tee-video-development-ci-boundary", policy },
        "aws_iam_role.ci": { name: "forever-tee-video-development-ci", max_session_duration: 3600, assume_role_policy: JSON.stringify({ Statement: [
                    { Sid: "ExactPersonalRepositoryPreview", Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity", Principal: principal,
                        Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                                "token.actions.githubusercontent.com:sub": "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview" } } },
                    { Sid: "DisabledPendingPreviewProtection", Effect: "Deny", Action: "sts:AssumeRoleWithWebIdentity", Principal: principal },
                ] }) },
        "aws_iam_role_policy.ci": { policy },
    };
    return {
        resource_changes: Object.entries(values).map(([address, after]) => ({ address, mode: "managed",
            provider_name: "registry.terraform.io/hashicorp/aws", change: { actions: ["create"], after } })),
        planned_values: { outputs: { ci_assumption_enabled: { value: false } } },
        configuration: { root_module: { resources: [{ address: "aws_iam_role.ci", expressions: {
                            permissions_boundary: { references: ["aws_iam_policy.ci_boundary.arn"] },
                        } }] } },
    };
}
test("CI activation changes only the exact trust and rejects permission expansion, deletion and overrides", () => {
    const plan = bootstrapPlan();
    plan.complete = true;
    plan.applyable = true;
    for (const resource of plan.resource_changes) {
        resource.change.actions = ["no-op"];
        resource.change.before = structuredClone(resource.change.after);
    }
    const role = plan.resource_changes.find(resource => resource.address === "aws_iam_role.ci");
    role.change.actions = ["update"];
    const trust = JSON.parse(role.change.after.assume_role_policy);
    trust.Statement.pop();
    role.change.after.assume_role_policy = JSON.stringify(trust);
    role.change.after.description = "Protected Preview with verified personal repository OIDC; state and inspection only";
    plan.output_changes = { ci_assumption_enabled: { actions: ["update"], before: false, after: true } };
    plan.planned_values.outputs.ci_assumption_enabled.value = true;
    assert.equal(inspectCIActivation(plan).permissionsChanged, false);
    const mutate = change => { const altered = structuredClone(plan); change(altered); assert.throws(() => inspectCIActivation(altered)); };
    mutate(value => { value.resource_changes[0].change.actions = ["delete"]; });
    mutate(value => { value.resource_changes.find(item => item.address === role.address).change.after.max_session_duration = 7200; });
    mutate(value => { value.resource_changes.find(item => item.address === role.address).change.after.assume_role_policy = JSON.stringify({ Statement: [] }); });
    mutate(value => { value.output_changes.production = { actions: ["create"], after: true }; });
    mutate(value => { value.resource_changes.find(item => item.address === "aws_iam_policy.ci_boundary").change.after.policy = "{}"; });
    mutate(value => { value.complete = false; });
    assert.equal(activationArguments(["plan"]).operation, "plan");
    assert.deepEqual(activationArguments(["apply", "--review=activation-ABC123", `--plan-sha256=${"a".repeat(64)}`]), { operation: "apply", review: "activation-ABC123", planSha256: "a".repeat(64) });
    for (const args of [["apply"], ["plan", "-target=aws_iam_role.ci"], ["plan", "--environment=production"]])
        assert.throws(() => activationArguments(args));
});
test("activation requires live exact branch protections and the successful verified identity run", async () => {
    const subject = "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview";
    const github = {
        api: async (path) => {
            if (path.endsWith("/jobs"))
                return { total_count: 1, jobs: [{ id: 1, conclusion: "success" }] };
            if (path.includes("/actions/runs/"))
                return { head_sha: "3dfcf57d498373dcc0bde5e4200aba8e6a68a6d2", conclusion: "success", event: "push",
                    path: ".github/workflows/native-ci-identity.yml", repository: { id: Number(protectedConfig("githubRepositoryId")) }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) } };
            if (path.endsWith("/deployment-branch-policies")) {
                const branches = path.includes("/Preview/") ? ["main", "perf/story-video-family-experiments"] : ["main"];
                return { total_count: branches.length, branch_policies: branches.map(name => ({ type: "branch", name })) };
            }
            return { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
        },
        jobLog: async () => `timestamp ${JSON.stringify({ signatureVerified: true, subject, awsAccessAttempted: false })}`,
    };
    assert.equal((await verifyGitHubActivation(github)).subject, subject);
    await assert.rejects(verifyGitHubActivation({ ...github, api: async (path) => path.includes("/environments/") ? {} : github.api(path) }));
    await assert.rejects(verifyGitHubActivation({ ...github, jobLog: async () => '{"signatureVerified":true,"subject":"wrong","awsAccessAttempted":false}' }));
});
test("bootstrap review rejects destructive changes, existing-resource takeover and unrelated resources", () => {
    assert.equal(inspectBootstrapPlan(bootstrapPlan()).ciEnabled, false);
    for (const actions of [["delete"], ["update"], ["delete", "create"]]) {
        const plan = bootstrapPlan();
        plan.resource_changes[0].change.actions = actions;
        assert.throws(() => inspectBootstrapPlan(plan), /updates, replacements or deletions/);
    }
    const foreign = bootstrapPlan();
    foreign.resource_changes.push({ ...foreign.resource_changes[0], address: "aws_lambda_function.production" });
    assert.throws(() => inspectBootstrapPlan(foreign), /outside bootstrap/);
    const imported = bootstrapPlan();
    imported.resource_changes[0].change.importing = { id: "existing-key" };
    assert.throws(() => inspectBootstrapPlan(imported), /imports and moves/);
});
test("bootstrap review rejects an enabled CI role or broader permissions even when its boundary matches", () => {
    const enabled = bootstrapPlan();
    const role = enabled.resource_changes.find(resource => resource.address === "aws_iam_role.ci");
    const trust = JSON.parse(role.change.after.assume_role_policy);
    trust.Statement[1].Effect = "Allow";
    role.change.after.assume_role_policy = JSON.stringify(trust);
    assert.throws(() => inspectBootstrapPlan(enabled), /remain disabled/);
    const broad = bootstrapPlan();
    const policy = developmentCIPermissions();
    policy.Statement.push({ Effect: "Allow", Action: "lambda:UpdateFunctionCode", Resource: "*" });
    for (const address of ["aws_iam_policy.ci_boundary", "aws_iam_role_policy.ci"]) {
        broad.resource_changes.find(resource => resource.address === address).change.after.policy = JSON.stringify(policy);
    }
    assert.throws(() => inspectBootstrapPlan(broad), /exceed the Development/);
});
test("Terraform policy JSON formatting cannot reject semantically identical boundaries", () => {
    const plan = bootstrapPlan();
    const policy = plan.resource_changes.find(resource => resource.address === "aws_iam_role_policy.ci");
    policy.change.after.policy = JSON.stringify(JSON.parse(policy.change.after.policy), null, 2);
    assert.equal(inspectBootstrapPlan(plan).ciEnabled, false);
});
test("CodeBuild inspection uses the IAM project resource type and cannot start builds", () => {
    const policy = developmentCIPermissions();
    const statement = policy.Statement.find(value => value.Sid === "InspectDevelopmentBuilds");
    assert.equal(statement.Action, "codebuild:BatchGetBuilds");
    assert.equal(statement.Resource, "arn:aws:codebuild:ap-southeast-2:" + protectedConfig("awsAccountId") + ":project/forever-tee-video-development");
    assert.doesNotMatch(JSON.stringify(policy), /codebuild:Start|codebuild:Retry|iam:PassRole/);
});
test("saved review must match re-extracted binary contents and hashes", () => {
    const plan = bootstrapPlan();
    const review = { ...inspectBootstrapPlan(plan), planSha256: "a".repeat(64), sourceSha256: "b".repeat(64), createdAt: "2026-08-28T00:00:00Z" };
    assert.deepEqual(verifyBootstrapReview(review, plan, review.planSha256, review.sourceSha256), review);
    for (const changed of [{ ...review, changes: [] }, { ...review, ciEnabled: true }, { ...review, policies: {} }]) {
        assert.throws(() => verifyBootstrapReview(changed, plan, review.planSha256, review.sourceSha256), /does not describe the binary/);
    }
    assert.throws(() => verifyBootstrapReview(review, plan, "c".repeat(64), review.sourceSha256), /saved plan or source/);
    assert.throws(() => verifyBootstrapReview(review, plan, review.planSha256, "c".repeat(64)), /saved plan or source/);
});
test("readback accepts only reviewed post-create observations and never authorizes apply", () => {
    const plan = bootstrapPlan();
    plan.complete = true;
    for (const resource of plan.resource_changes)
        resource.change.actions = ["no-op"];
    const key = plan.resource_changes.find(resource => resource.address === "aws_kms_key.state");
    key.change.after.tags = {};
    plan.resource_drift = [{ ...key, change: { actions: ["update"], before: { ...key.change.after, tags: null }, after: key.change.after } }];
    assert.equal(verifyBootstrapReadback(plan).applyAuthorized, false);
    assert.throws(() => inspectBootstrapPlan(plan), /resource drift/);
    const unexpected = structuredClone(plan);
    unexpected.resource_drift[0].change.before.enable_key_rotation = false;
    assert.throws(() => verifyBootstrapReadback(unexpected), /unexpected changes/);
    const update = structuredClone(plan);
    update.resource_changes[0].change.actions = ["update"];
    assert.throws(() => verifyBootstrapReadback(update), /unexpected changes/);
    const inline = structuredClone(plan);
    const role = inline.resource_changes.find(resource => resource.address === "aws_iam_role.ci");
    const child = inline.resource_changes.find(resource => resource.address === "aws_iam_role_policy.ci");
    child.change.after.name = "development-state-and-inspection";
    role.change.after.inline_policy = [{ name: child.change.after.name, policy: child.change.after.policy }];
    inline.resource_drift = [{ ...role, change: { actions: ["update"], before: { ...role.change.after, inline_policy: [] }, after: role.change.after } }];
    assert.equal(verifyBootstrapReadback(inline).ciEnabled, false);
    role.change.after.inline_policy.push({ name: "extra", policy: "{}" });
    assert.throws(() => verifyBootstrapReadback(inline), /unexpected changes/);
    const encryption = structuredClone(plan);
    const bucket = encryption.resource_changes.find(resource => resource.address === "aws_s3_bucket.state");
    const configuration = encryption.resource_changes.find(resource => resource.address === "aws_s3_bucket_server_side_encryption_configuration.state");
    const rule = { apply_server_side_encryption_by_default: [{ kms_master_key_id: "reviewed-key", sse_algorithm: "aws:kms" }], bucket_key_enabled: false };
    configuration.change.after.rule = [{ ...rule, blocked_encryption_types: ["SSE-C"] }];
    bucket.change.after.server_side_encryption_configuration = [{ rule: [rule] }];
    encryption.resource_drift = [{ ...bucket, change: { actions: ["update"], before: { ...bucket.change.after,
                    server_side_encryption_configuration: [{ rule: [{ apply_server_side_encryption_by_default: [{ kms_master_key_id: "", sse_algorithm: "AES256" }], bucket_key_enabled: false }] }],
                }, after: bucket.change.after } }];
    assert.equal(verifyBootstrapReadback(encryption).infrastructureChanges, 0);
    bucket.change.after.server_side_encryption_configuration = [{ rule: [{ ...rule, bucket_key_enabled: true }] }];
    assert.throws(() => verifyBootstrapReadback(encryption), /unexpected changes/);
});
