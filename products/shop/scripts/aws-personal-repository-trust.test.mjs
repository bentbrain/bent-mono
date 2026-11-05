import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { protectedConfig } from "./protected-config.mjs";
import { runPersonalTerraform } from "./aws-personal-terraform.mjs";
import { validatePersonalArguments, PERSONAL_CONFIG_PATH } from "./aws-personal-guard.mjs";
import { TRUST_FILES, TRUST_INVENTORY, inspectRepositoryTrustPlan } from "./aws-personal-repository-trust.mjs";
import { verifyTrustGitHub, targetPrefix, trustEnvironments } from "./repository-trust-evidence.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { activateShopWorkflows } from "./activate-workflows.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const account = protectedConfig("awsAccountId"), owner = protectedConfig("githubOwnerId"), repo = protectedConfig("githubRepositoryId");
const source = "a".repeat(40), AWS = "registry.terraform.io/hashicorp/aws";
const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::synthetic-private/state" }] };
const original = { repositoryId: 888001, subjectPrefix: `repo:bentbrain@${owner}/synthetic-previous@888001`,
    lineage: "00000000-0000-4000-8000-000000000001", accountId: account, region: "ap-southeast-2", backendKey: "story-video/bootstrap/terraform.tfstate" };
const oldConfig = process.env.SHOP_PROTECTED_CONFIG_JSON;
// Every new prerequisite is explicit synthetic test data, with no operational default.
const baseConfig = { ...JSON.parse(oldConfig), trustOriginalRepository: "bentbrain/synthetic-previous", trustOriginalReceiptSha256: sha(JSON.stringify(original)),
    trust_development_reviewedCommit: source, trust_production_reviewedCommit: source };
process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(baseConfig);
const write = (path, data) => writeFile(path, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
function trust(spec, prefix = original.subjectPrefix) {
    return { Version: "2012-10-17", Statement: [{ Sid: `ExactPersonalRepository${spec.environment}`, Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
        Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` },
        Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": `${prefix}:environment:${spec.environment}` } } }] };
}
function fixture(stage = "development") {
    const resources = TRUST_INVENTORY.map(address => {
        const [mode, type, name] = address.startsWith("data.") ? address.split(".") : ["managed", ...address.split(".")];
        return { mode, type, name, provider: `provider["${AWS}"]`, instances: [{ schema_version: 0, attributes: { id: `synthetic-${name}` } }] };
    });
    const state = { version: 4, terraform_version: "1.12.2", lineage: original.lineage, serial: 137, outputs: { ci_assumption_enabled: { value: true, type: "bool" } }, resources };
    const value = address => resources.find(item => `${item.mode === "data" ? "data." : ""}${item.type}.${item.name}` === address).instances[0].attributes;
    Object.assign(value("data.aws_iam_openid_connect_provider.github"), { id: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`, arn: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`, url: "token.actions.githubusercontent.com", client_id_list: ["sts.amazonaws.com"] });
    const permissions = { provider: { Url: "token.actions.githubusercontent.com", ClientIDList: ["sts.amazonaws.com"], ThumbprintList: ["synthetic"] } };
    for (const [key, spec] of Object.entries(trustEnvironments)) {
        const prefix = stage === "production" && key === "development" ? targetPrefix() : original.subjectPrefix;
        const boundaryArn = `arn:aws:iam::${account}:policy/${spec.name}-boundary`;
        const role = { id: spec.name, name: spec.name, arn: `arn:aws:iam::${account}:role/${spec.name}`, unique_id: `SYNTHETIC-${key}`, path: "/", max_session_duration: 3600,
            permissions_boundary: boundaryArn, assume_role_policy: JSON.stringify(trust(spec, prefix)), inline_policy: [{ name: spec.inline, policy: JSON.stringify(policy) }], managed_policy_arns: [], tags: {} };
        Object.assign(value(spec.role), role);
        Object.assign(value(spec.role.replace("aws_iam_role.", "aws_iam_role_policy.")), { name: spec.inline, role: spec.name, policy: JSON.stringify(policy) });
        Object.assign(value(spec.role.replace("aws_iam_role.", "aws_iam_policy.") + "_boundary"), { id: boundaryArn, arn: boundaryArn, policy: JSON.stringify(policy) });
        permissions[key] = { role: { RoleName: spec.name, Arn: role.arn, RoleId: role.unique_id, Path: "/", MaxSessionDuration: 3600, AssumeRolePolicyDocument: trust(spec, prefix),
            PermissionsBoundary: { PermissionsBoundaryType: "Policy", PermissionsBoundaryArn: boundaryArn }, Tags: [] }, inline: policy,
            boundary: { Arn: boundaryArn, DefaultVersionId: "v7", PolicyId: `SYNTHETIC-${key}-BOUNDARY` }, boundaryDocument: policy };
    }
    const now = new Date().toISOString();
    const object = { ServerSideEncryption: "aws:kms", SSEKMSKeyId: `arn:aws:kms:ap-southeast-2:${account}:key/${protectedConfig("stateKmsKeyId")}`,
        VersionId: "synthetic-version", ContentLength: 400, ETag: '"synthetic-etag"', LastModified: "2026-01-01T00:00:00Z" };
    const baseline = { object, sourceCommit: source, observedAt: now, original, state, permissions, parentObservations: [], proofRuns: { development: 1201, production: 1202 },
        window: { observedAt: now, expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), exclusive: true, admissionsFrozen: true, repositoryIds: [original.repositoryId, Number(repo)] } };
    return { baseline, value };
}
function planFor(baseline, stage = "development", noOp = false) {
    const plan = { terraform_version: "1.12.2", complete: true, applyable: !noOp, errored: false, resource_drift: [],
        output_changes: Object.fromEntries(Object.entries(baseline.state.outputs).map(([key, item]) => [key, { actions: ["no-op"], before: item.value, after: item.value }])),
        resource_changes: baseline.state.resources.map(item => ({ address: `${item.mode === "data" ? "data." : ""}${item.type}.${item.name}`, mode: item.mode, provider_name: AWS,
            change: { actions: ["no-op"], before: structuredClone(item.instances[0].attributes), after: structuredClone(item.instances[0].attributes), after_unknown: {} } })) };
    if (!noOp) {
        const change = plan.resource_changes.find(item => item.address === trustEnvironments[stage].role).change;
        change.actions = ["update"];
        const next = JSON.parse(change.after.assume_role_policy);
        next.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] = `${targetPrefix()}:environment:${trustEnvironments[stage].environment}`;
        change.after.assume_role_policy = JSON.stringify(next);
    }
    return plan;
}
function githubFor(baseline, failure) {
    const identity = { id: Number(repo), full_name: "bentbrain/bent-mono", owner: { id: Number(owner) } };
    const workflow = { id: 31, path: ".github/workflows/quality.yml", state: "active" };
    const quality = { id: 400, workflow_id: workflow.id, path: workflow.path, head_sha: source, head_branch: "main", event: "push", run_attempt: 1,
        status: "completed", conclusion: "success", repository: identity, head_repository: identity };
    const runs = Object.fromEntries(Object.entries(trustEnvironments).map(([key, spec], i) => [baseline.proofRuns[key], { id: baseline.proofRuns[key], head_sha: source, head_branch: "main", status: "completed", conclusion: "success",
        event: "workflow_dispatch", run_attempt: 1, workflow_id: 32 + i, path: `.github/workflows/${spec.workflow}`, repository: identity, head_repository: identity, created_at: baseline.observedAt }]));
    if (failure === "failed-whole-run") runs[1201].conclusion = "failure";
    if (failure === "rerun") runs[1201].run_attempt = 2;
    if (failure === "stale-proof") runs[1201].created_at = "2000-01-01T00:00:00Z";
    if (failure === "wrong-source") runs[1201].head_sha = "b".repeat(40);
    return {
        trustRead: async path => {
            const suffix = path.replace(/^\/repos\/bentbrain\/bent-mono/, "");
            if (path === "/repos/bentbrain/synthetic-previous") return { id: original.repositoryId, full_name: "bentbrain/synthetic-previous", owner: identity.owner };
            if (path.startsWith("/repos/bentbrain/synthetic-previous/actions/runs?")) return { total_count: 0, workflow_runs: [] };
            if (!suffix) return identity;
            if (suffix === "/git/ref/heads/main") return { object: { sha: source } };
            if (suffix === "/actions/workflows/quality.yml") return workflow;
            if (suffix.startsWith("/actions/workflows/31/runs?")) return { workflow_runs: [quality] };
            if (suffix === "/actions/runs/400") return quality;
            if (suffix.startsWith("/actions/runs/400/attempts/1/jobs?")) return { jobs: ["lint", "typecheck", "test", "knip", "build", "test:integration", "browser", "shop", "public-source", "secret-scan", "dependencies", "CodeQL", "Release qualification"].map(name => ({ name, head_sha: source, status: "completed", conclusion: "success" })) };
            if (suffix.includes("/pulls?")) return [{ number: 10, merged_at: baseline.observedAt, merge_commit_sha: source, base: { ref: "main", repo: identity }, head: { sha: "c".repeat(40), repo: identity } }];
            if (suffix.includes("/check-runs?")) return { check_runs: [{ name: "CodeQL", app: { slug: "github-advanced-security" }, head_sha: "c".repeat(40), status: "completed", conclusion: "success" }] };
            if (suffix.includes("/statuses?")) return [{ context: "Independent review", state: failure === "no-review" ? "failure" : "success", target_url: "https://github.com/bentbrain/bent-mono/pull/10#review" }];
            if (suffix === "/actions/oidc/customization/sub") return { use_default: true, use_immutable_subject: true, sub_claim_prefix: failure === "wrong-prefix" ? "foreign" : targetPrefix() };
            if (suffix.endsWith("/deployment-branch-policies")) return { total_count: 1, branch_policies: [{ name: failure === "branch" ? "other" : "main", type: "branch" }] };
            if (suffix.startsWith("/environments/")) return { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
            if (suffix.startsWith("/actions/runs?")) return { total_count: failure === "active" ? 1 : 0, workflow_runs: failure === "active" ? [{}] : [] };
            for (const [key, spec] of Object.entries(trustEnvironments)) {
                if (suffix === `/actions/workflows/${spec.workflow}`) return { id: key === "development" ? 32 : 33, state: "active", path: `.github/workflows/${spec.workflow}` };
                const id = baseline.proofRuns[key];
                if (suffix === `/actions/runs/${id}`) return runs[id];
                if (suffix.startsWith(`/actions/runs/${id}/attempts/1/jobs?`)) return { total_count: 1, jobs: [{ id, name: spec.job, head_sha: source, status: "completed", conclusion: "success", steps: [{ name: spec.step, status: "completed", conclusion: failure === "failed-step" ? "failure" : "success" }] }] };
            }
            if (["/actions/runs/1301", "/actions/runs/1302"].includes(suffix)) return { id: Number(suffix.split("/").at(-1)), head_sha: source, head_branch: "main", run_attempt: 1,
                status: "completed", conclusion: "success", repository: identity, head_repository: identity, path: ".github/workflows/native-development.yml", created_at: baseline.observedAt, updated_at: baseline.observedAt, event: "workflow_dispatch" };
            assert.fail(`Unexpected synthetic read ${path}`);
        },
        jobLog: async id => {
            const spec = id === baseline.proofRuns.development ? trustEnvironments.development : trustEnvironments.production;
            return JSON.stringify({ signatureVerified: true, issuer: "https://token.actions.githubusercontent.com", audience: "sts.amazonaws.com", subject: `${failure === "wrong-subject" ? original.subjectPrefix : targetPrefix()}:environment:${spec.environment}`,
                repositoryId: repo, ownerId: owner, runAttempt: "1", environment: spec.environment, ref: "refs/heads/main", sourceCommit: source,
                runId: String(id), workflowRef: `bentbrain/bent-mono/.github/workflows/${spec.workflow}@refs/heads/main`, awsAccessAttempted: false });
        },
    };
}
async function iam(args, permissions) {
    validatePersonalArguments(args);
    if (args[1] === "get-open-id-connect-provider") return permissions.provider;
    const key = args[3].includes("development") ? "development" : "production", evidence = permissions[key], spec = trustEnvironments[key];
    if (args[1] === "get-role") return { Role: evidence.role };
    if (args[1] === "list-role-policies") return { PolicyNames: [spec.inline], IsTruncated: false };
    if (args[1] === "list-attached-role-policies") return { AttachedPolicies: [], IsTruncated: false };
    if (args[1] === "get-role-policy") return { RoleName: spec.name, PolicyName: spec.inline, PolicyDocument: evidence.inline };
    if (args[1] === "get-policy") return { Policy: evidence.boundary };
    if (args[1] === "get-policy-version") return { PolicyVersion: { VersionId: "v7", IsDefaultVersion: true, Document: evidence.boundaryDocument } };
    assert.fail(`Forbidden synthetic IAM operation ${args}`);
}
async function harness(t, { uncertain = false, drift = false, stage = "development" } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "shop-trust-synthetic-"));
    t.after(async () => { process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(baseConfig); await rm(directory, { recursive: true, force: true }); });
    const { baseline } = fixture(stage);
    const currentState = structuredClone(baseline.state), permissions = structuredClone(baseline.permissions), commands = [], events = [];
    const object = structuredClone(baseline.object);
    await write(join(directory, "original-repository-receipt.json"), original);
    const config = { ...baseConfig };
    if (stage === "production") {
        const completed = { planSha256: "e".repeat(64), refreshedNoOp: true };
        await mkdir(join(directory, "development-ABC123"), { mode: 0o700 });
        await write(join(directory, "development-ABC123/complete.json"), completed);
        await write(join(directory, "development-started.json"), { review: "development-ABC123", planSha256: completed.planSha256 });
        config.trust_production_developmentCompleteSha256 = sha(JSON.stringify(completed));
        const qualification = { applicationMutations: false, cloudQualificationVerified: true, cleanupVerified: true, qualificationKind: "full", sourceCommit: source,
            qualificationSourceCommit: source, qualificationRunId: 1301, releaseId: "native-1300", imageDigest: `sha256:${"c".repeat(64)}`, workerVersionId: "00000000-0000-4000-8000-000000000002",
            reference: { key: `source/releases/native-${protectedConfig("resource_8d0190ecec7d")}/qualification-receipt-native-1300-run-1301.json`, version: "synthetic-object-version", sha256: "d".repeat(64) },
            cleanupReference: { key: `source/releases/native-${protectedConfig("resource_8d0190ecec7d")}/qualification-cleanup-complete-native-1300-run-1301.json`, version: "synthetic-cleanup-version", sha256: "e".repeat(64) } };
        const rollback = { rollbackVerified: true, fromReleaseId: "native-1300", releaseId: "native-1302", workerVersion: "00000000-0000-4000-8000-000000000003",
            target: { environment: "development", accountId: account, region: "ap-southeast-2", imageDigest: `sha256:${"f".repeat(64)}`, imageUri: `${account}.dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@sha256:${"f".repeat(64)}`, sourceDigest: "b".repeat(64) } };
        baseline.developmentReadiness = { sourceCommit: source, qualified: true, rollbackVerified: true, verifiedAt: baseline.observedAt,
            qualificationRunId: 1301, rollbackRunId: 1302, qualificationReceiptSha256: sha(JSON.stringify(qualification)), rollbackReceiptSha256: sha(JSON.stringify(rollback)) };
        for (const [kind, receipt] of Object.entries({ qualification, rollback })) {
            await write(join(directory, `development-${kind}-receipt.json`), receipt);
            config[`trust_production_${kind}ReceiptSha256`] = sha(JSON.stringify(receipt));
        }
    }
    await write(join(directory, `${stage}-baseline.json`), baseline);
    config[`trust_${stage}_baselineSha256`] = sha(JSON.stringify(baseline));
    process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(config);
    const backend = { type: "s3", config: { bucket: `forever-tee-terraform-state-${account}-ap-southeast-2`, key: "story-video/bootstrap/terraform.tfstate", region: "ap-southeast-2",
        use_lockfile: true, encrypt: true, kms_key_id: `arn:aws:kms:ap-southeast-2:${account}:key/${protectedConfig("stateKmsKeyId")}`, allowed_account_ids: [account] } };
    let applied = false;
    const dependencies = {
        trustPrivateDirectory: directory, trustGitHub: githubFor(baseline), inspectTrustCheckout: expected => assert.equal(expected, source),
        config: `[profile personal-dev]\nsso_session = personal-dev\nsso_account_id = ${account}\nsso_role_name = AdministratorAccess\nregion = ap-southeast-2\n[sso-session personal-dev]\nsso_start_url = ${protectedConfig("ssoStartUrl")}\nsso_region = ap-southeast-2\nsso_registration_scopes = sso:account:access\n`,
        environment: { HOME: directory, AWS_ACCESS_KEY_ID: "must-strip", TF_CLI_ARGS: "-target=must-strip", NODE_OPTIONS: "must-strip" },
        execute: async (args, env) => {
            assert.equal(env.AWS_ACCESS_KEY_ID, undefined); assert.equal(env.AWS_CONFIG_FILE, PERSONAL_CONFIG_PATH);
            if (args[0] === "sts") return JSON.stringify({ Account: account, Arn: `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_AdministratorAccess_synthetic/session` });
            if (args[0] === "s3api") {
                assert.deepEqual(args.slice(0, -7), ["s3api", "head-object", "--bucket", backend.config.bucket,
                    "--expected-bucket-owner", account, "--key", backend.config.key]);
                events.push("owner-head");
                return JSON.stringify(object);
            }
            return JSON.stringify(await iam(args.slice(0, -7), permissions));
        },
        executeTerraformCapture: async (args, env, cwd) => {
            commands.push(args); events.push(args[0]);
            assert.equal(env.TF_CLI_ARGS, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
            assert.equal(env.TF_WORKSPACE, "default"); assert.equal(env.TF_CLI_CONFIG_FILE, "/dev/null"); assert.equal(basename(cwd), "module");
            if (args[0] === "version") return JSON.stringify({ terraform_version: "1.12.2", provider_selections: { [AWS]: "6.62.0" } });
            if (args[0] === "init") { await mkdir(env.TF_DATA_DIR, { mode: 0o700 }); await write(join(env.TF_DATA_DIR, "terraform.tfstate"), { backend }); return "synthetic init"; }
            if (args[0] === "workspace") return "default\n";
            if (args[0] === "state") return JSON.stringify(currentState);
            if (args[0] === "plan") { await write(args.at(-1).slice(5), "synthetic saved binary"); return "synthetic plan"; }
            if (args[0] === "show") {
                const p = planFor({ ...baseline, state: applied ? currentState : baseline.state }, stage, applied);
                if (drift) p.resource_drift = [{ address: "aws_kms_key.state" }];
                return JSON.stringify(p);
            }
            if (args[0] === "apply") {
                const plan = planFor(baseline, stage);
                currentState.resources.forEach((resource, i) => resource.instances[0].attributes = plan.resource_changes[i].change.after);
                currentState.serial++; object.VersionId = "synthetic-after-version"; object.ETag = '"synthetic-after-etag"';
                permissions[stage].role.AssumeRolePolicyDocument = trust(trustEnvironments[stage], targetPrefix());
                applied = true;
                if (uncertain) throw Object.assign(new Error("synthetic response lost"), { stderr: "synthetic private diagnostics" });
                return "synthetic confirmed apply";
            }
            assert.fail(`Forbidden synthetic command ${args}`);
        },
    };
    return { directory, baseline, dependencies, commands, events, config, backend, currentState, permissions, object,
        invoke: args => runPersonalTerraform(["bootstrap", "repository-trust", ...args], dependencies),
        approve: result => {
            Object.assign(config, { [`trust_${stage}_approvedPlanSha256`]: result.planSha256, [`trust_${stage}_approvedReviewSha256`]: result.reviewSha256, [`trust_${stage}_approvedSourceSha256`]: result.sourceSha256 });
            process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(config);
        } };
}
// Opt in with the exact installed binary. No credentials, provider download or
// backend configuration can run: the deliberately unknown attribute stops init
// during native schema decoding. Every rendered backend argument is decoded too.
test("native Terraform 1.12.2 accepts the rendered S3 backend schema before configuration", { skip: !process.env.SHOP_TRUST_SCHEMA_TERRAFORM }, async t => {
    const h = await harness(t), result = JSON.parse(await h.invoke(["development", "plan"]));
    const probe = join(h.directory, "schema-probe");
    await mkdir(probe, { mode: 0o700 });
    const rendered = await readFile(join(result.reviewDirectory, "module/versions.tf"), "utf8");
    await write(join(probe, "versions.tf"), rendered.replace(JSON.stringify(PERSONAL_CONFIG_PATH), JSON.stringify(join(probe, "no-config")))
        .replace('backend "s3" {', 'backend "s3" {\n    synthetic_schema_stop = true'));
    const env = { PATH: "/usr/bin:/bin", HOME: probe, TF_DATA_DIR: join(probe, "data"), TF_CLI_CONFIG_FILE: "/dev/null",
        TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1", AWS_EC2_METADATA_DISABLED: "true",
        AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" };
    const native = args => spawnSync(process.env.SHOP_TRUST_SCHEMA_TERRAFORM, args, { cwd: probe, env, encoding: "utf8", timeout: 10000 });
    const version = native(["version", "-json"]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(JSON.parse(version.stdout).terraform_version, "1.12.2");
    const output = native(["init", "-input=false", "-no-color"]);
    assert.equal(output.status, 1, output.stderr);
    assert.match(output.stderr, /synthetic_schema_stop/);
    assert.equal((output.stderr.match(/Error:/g) ?? []).length, 1, output.stderr);
    assert.doesNotMatch(output.stderr, /expected_bucket_owner|credential|network|provider registry/i);
});
test("guarded CLI route renders, plans, shows and applies one Development scalar; Production stays unchanged", async t => {
    const h = await harness(t), beforeProduction = structuredClone(h.permissions.production);
    const result = JSON.parse(await h.invoke(["development", "plan"]));
    assert.equal(result.changedResource, "aws_iam_role.ci");
    const options = [`--review=${basename(result.reviewDirectory)}`, `--plan-sha256=${result.planSha256}`];
    assert.equal(JSON.parse(await h.invoke(["development", "show", ...options])).reviewSha256, result.reviewSha256);
    await assert.rejects(h.invoke(["development", "apply", ...options]), /prerequisite|approval/);
    assert.equal(h.commands.some(command => command[0] === "apply"), false);
    h.approve(result);
    const complete = JSON.parse(await h.invoke(["development", "apply", ...options]));
    assert.equal(complete.refreshedNoOp, true); assert.equal(complete.releaseReady, false);
    assert.deepEqual(h.permissions.production, beforeProduction); assert.equal(h.currentState.serial, 138);
    assert.ok(await readFile(join(h.directory, "development-started.json")));
    await assert.rejects(h.invoke(["development", "apply", ...options]), /journal/);
    assert.equal(h.commands.filter(command => command[0] === "apply").length, 1);
    for (const command of h.commands.filter(command => command[0] === "plan")) {
        assert.ok(command.includes("-refresh=true")); assert.ok(command.includes("-lock=true")); assert.ok(command.includes("-parallelism=1"));
        assert.equal(command.some(arg => /target|import|replace|refresh=false/.test(arg)), false);
    }
    assert.ok(h.commands.find(command => command[0] === "init").includes("-lockfile=readonly"));
    const manifest = JSON.parse(await readFile(join(result.reviewDirectory, "manifest.json")));
    assert.deepEqual(manifest.map(item => item.name), TRUST_FILES);
    const rendered = await readFile(join(result.reviewDirectory, "module/versions.tf"), "utf8");
    assert.ok(rendered.includes(JSON.stringify(PERSONAL_CONFIG_PATH))); assert.ok(rendered.includes('required_version = "= 1.12.2"'));
    assert.ok((await readFile(join(result.reviewDirectory, "module/production.tf"), "utf8")).includes(`${original.subjectPrefix}:environment:Production`));
    assert.equal((await stat(result.reviewDirectory)).mode & 0o077, 0); assert.equal((await stat(join(result.reviewDirectory, "review.json"))).mode & 0o077, 0);
});
test("lost apply response leaves synced intent, preserves evidence and forbids blind replay", async t => {
    const h = await harness(t, { uncertain: true }), result = JSON.parse(await h.invoke(["development", "plan"]));
    h.approve(result);
    const options = [`--review=${basename(result.reviewDirectory)}`, `--plan-sha256=${result.planSha256}`];
    await assert.rejects(h.invoke(["development", "apply", ...options]), /response uncertain/);
    assert.equal(h.currentState.serial, 138);
    assert.equal(JSON.parse(await readFile(join(h.directory, "development-started.json"))).planSha256, result.planSha256);
    assert.equal(JSON.parse(await readFile(join(result.reviewDirectory, "apply-uncertain.json"))).responseConfirmed, false);
    await assert.rejects(h.invoke(["development", "apply", ...options]), /journal/);
    await assert.rejects(h.invoke(["development", "plan"]), /journal/);
    assert.equal(h.commands.filter(command => command[0] === "apply").length, 1);
    const discovered = JSON.parse(await h.invoke(["development", "discover"]));
    assert.equal(discovered.recoveryRequired, true);
    assert.ok(await readFile(join(h.directory, "development-started.json")));
});
test("every Terraform remote operation is bracketed by expected-owner HEAD attestations", async t => {
    const h = await harness(t), result = JSON.parse(await h.invoke(["development", "plan"]));
    h.approve(result);
    await h.invoke(["development", "apply", `--review=${basename(result.reviewDirectory)}`, `--plan-sha256=${result.planSha256}`]);
    for (const [index, event] of h.events.entries()) if (["init", "state", "plan", "apply"].includes(event)) {
        assert.equal(h.events[index - 1], "owner-head", `before ${event}`);
        assert.equal(h.events[index + 1], "owner-head", `after ${event}`);
    }
    assert.deepEqual(JSON.parse(await readFile(join(result.reviewDirectory, "review.json"))).object, h.baseline.object);
    assert.deepEqual(JSON.parse(await readFile(join(result.reviewDirectory, "object-after.json"))), h.object);
});
test("owner denial and invalid or unapproved KMS object metadata stop before native initialization", async t => {
    for (const fault of ["owner-denied", "version", "kms", "unversioned", "empty-version", "etag", "modified", "length", "baseline"]) {
        const h = await harness(t);
        if (fault === "owner-denied") {
            const execute = h.dependencies.execute;
            h.dependencies.execute = async (args, ...rest) => {
                if (args[0] === "s3api") throw Object.assign(new Error("synthetic owner denied"), { stderr: "synthetic-private-owner" });
                return execute(args, ...rest);
            };
        }
        if (fault === "version") h.object.VersionId = "another-version";
        if (fault === "kms") h.object.SSEKMSKeyId = "other-key";
        if (fault === "unversioned") h.object.VersionId = "null";
        if (fault === "empty-version") h.object.VersionId = "";
        if (fault === "etag") delete h.object.ETag;
        if (fault === "modified") h.object.LastModified = "invalid";
        if (fault === "length") h.object.ContentLength = "400";
        if (fault === "baseline") {
            delete h.baseline.object;
            await write(join(h.directory, "development-baseline.json"), h.baseline);
            process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify({ ...h.config, trust_development_baselineSha256: sha(JSON.stringify(h.baseline)) });
        }
        await assert.rejects(h.invoke(["development", "plan"]), error => !error.message.includes("synthetic-private-owner"), fault);
        assert.equal(h.commands.length, 0, fault);
    }
});
test("owner/object changes at init, pull, plan and final apply barriers fail closed", async t => {
    for (const barrier of ["init", "state", "plan", "apply"]) for (const timing of ["before", "after"]) {
        const h = await harness(t);
        let options = [];
        if (barrier === "apply") {
            const result = JSON.parse(await h.invoke(["development", "plan"])); h.approve(result);
            options = [`--review=${basename(result.reviewDirectory)}`, `--plan-sha256=${result.planSha256}`];
        }
        const capture = h.dependencies.executeTerraformCapture;
        const execute = h.dependencies.execute;
        let crossed = false;
        if (timing === "before") {
            // Introduce a change just as the HEAD immediately before the target
            // operation runs. It must never reach that native command.
            const preceding = { init: "version", state: "workspace", plan: "state", apply: "state" }[barrier];
            let count = 0;
            h.dependencies.executeTerraformCapture = async (args, ...rest) => {
                const result = await capture(args, ...rest);
                if (args[0] === preceding && ++count === (barrier === "apply" ? 3 : 1)) h.object.VersionId = "unexpected-version";
                if (args[0] === barrier) crossed = true;
                return result;
            };
        } else {
            h.dependencies.executeTerraformCapture = async (args, ...rest) => {
                const result = await capture(args, ...rest);
                if (args[0] === barrier) crossed = true;
                return result;
            };
            h.dependencies.execute = async (args, ...rest) => {
                if (args[0] === "s3api" && crossed) throw new Error("synthetic owner changed during native command");
                return execute(args, ...rest);
            };
        }
        await assert.rejects(h.invoke(["development", barrier === "apply" ? "apply" : "plan", ...options]), undefined, `${timing} ${barrier}`);
        if (timing === "before") assert.equal(crossed, false, barrier);
        if (barrier !== "apply") assert.equal(h.commands.some(command => command[0] === "apply"), false);
        if (barrier === "apply") {
            assert.ok(await readFile(join(h.directory, "development-started.json")));
            if (timing === "after") assert.ok(await readFile(join(h.directory, options[0].slice(9), "apply-uncertain.json")));
            await assert.rejects(h.invoke(["development", "apply", ...options]), /journal/);
        }
    }
});
test("actual CLI requires missing private configuration; IAM writes and argument overrides stay forbidden", async t => {
    const h = await harness(t);
    for (const args of [["development", "plan", "-target=aws_iam_role.ci"], ["both", "plan"], ["production", "apply"], ["development", "plan", "--backend=x"], ["development", "recover"],
        ["development|production", "show", "--review=development-ABC123", `--plan-sha256=${"a".repeat(64)}`],
        ["development", "show", "--review=production-ABC123", `--plan-sha256=${"a".repeat(64)}`],
        ["production", "show", "--review=development-ABC123", `--plan-sha256=${"a".repeat(64)}`]]) await assert.rejects(h.invoke(args));
    for (const args of [["iam", "update-assume-role-policy", "--role-name", "forever-tee-video-development-ci"], ["iam", "list-role-policies", "--role-name", "foreign"],
        ["iam", "get-role-policy", "--role-name", "forever-tee-video-production-ci", "--policy-name", "foreign"], ["iam", "get-policy-version", "--policy-arn", "foreign", "--version-id", "v7"]]) assert.throws(() => validatePersonalArguments(args));
    const cli = spawnSync(process.execPath, ["scripts/aws-personal.mjs", "terraform", "bootstrap", "repository-trust", "development", "plan"], { cwd: new URL("../", import.meta.url), encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: h.directory, SHOP_PROTECTED_CONFIG_JSON: JSON.stringify(baseConfig) } });
    assert.notEqual(cli.status, 0); assert.match(cli.stderr, /ENOENT|protected configuration/); assert.equal(h.commands.length, 0);
});
test("real planning rejects unknown drift; saved apply rejects changed binary, baseline, state, backend or rendering", async t => {
    const drift = await harness(t, { drift: true }); await assert.rejects(drift.invoke(["development", "plan"]), /drift/);
    for (const fault of ["binary", "baseline", "state", "backend", "rendered"]) {
        const h = await harness(t), result = JSON.parse(await h.invoke(["development", "plan"])); h.approve(result);
        if (fault === "binary") await write(join(result.reviewDirectory, "trust.tfplan"), "changed binary");
        if (fault === "baseline") await write(join(h.directory, "development-baseline.json"), { ...h.baseline, observedAt: "2000-01-01" });
        if (fault === "state") h.currentState.serial++;
        if (fault === "backend") await write(join(result.reviewDirectory, "providers/terraform.tfstate"), { backend: { ...h.backend, config: { ...h.backend.config, key: "other.tfstate" } } });
        if (fault === "rendered") await write(join(result.reviewDirectory, "module/production.tf"), "changed");
        await assert.rejects(h.invoke(["development", "apply", `--review=${basename(result.reviewDirectory)}`, `--plan-sha256=${result.planSha256}`]));
        assert.equal(h.commands.some(command => command[0] === "apply"), false, fault);
    }
});
test("plan inspection rejects permissions, boundary, role IDs, dual subjects, unknowns, moves and extra outputs", () => {
    for (const stage of ["development", "production"]) {
        const { baseline } = fixture(stage);
        assert.equal(inspectRepositoryTrustPlan(planFor(baseline, stage), baseline, stage).stage, stage);
        for (const mutate of [
            p => p.resource_changes.find(item => item.address === trustEnvironments[stage].role).change.after.unique_id = "other",
            p => p.resource_changes.find(item => item.address === trustEnvironments[stage].role).change.after.permissions_boundary = "other",
            p => p.resource_changes.find(item => item.address === "aws_iam_role_policy.ci").change.after.policy = "{}",
            p => p.resource_changes.find(item => item.address === trustEnvironments[stage].role).change.after_unknown.assume_role_policy = true,
            p => p.resource_changes.find(item => item.address === trustEnvironments[stage].role).change.after.assume_role_policy = JSON.stringify({ ...trust(trustEnvironments[stage]), Statement: [...trust(trustEnvironments[stage]).Statement, ...trust(trustEnvironments[stage], targetPrefix()).Statement] }),
            p => p.resource_changes.find(item => item.address === trustEnvironments[stage].role).change.actions = ["delete", "create"],
            p => p.resource_changes.find(item => item.address === trustEnvironments[stage].role).previous_address = "other",
            p => p.output_changes.extra = { actions: ["create"], after: true },
            p => p.resource_drift.push({ address: "aws_kms_key.state" }), p => p.resource_changes.pop(),
        ]) { const p = planFor(baseline, stage); mutate(p); assert.throws(() => inspectRepositoryTrustPlan(p, baseline, stage)); }
    }
});
test("saved state requires an audience array containing the exact STS audience", () => {
    for (const audiences of ["sts.amazonaws.com", "https://sts.amazonaws.com.attacker.invalid", ["sts.amazonaws.com.attacker.invalid"], ["prefix-sts.amazonaws.com"], null]) {
        const { baseline, value } = fixture();
        value("data.aws_iam_openid_connect_provider.github").client_id_list = audiences;
        assert.throws(() => inspectRepositoryTrustPlan(planFor(baseline), baseline, "development"), /OIDC/);
    }
});
test("live provider discovery rejects strings and lookalike audience entries before planning", async t => {
    for (const audiences of ["sts.amazonaws.com", "https://sts.amazonaws.com.attacker.invalid", ["sts.amazonaws.com.attacker.invalid"], ["prefix-sts.amazonaws.com"], null]) {
        const h = await harness(t);
        h.permissions.provider.ClientIDList = audiences;
        await assert.rejects(h.invoke(["development", "discover"]), /OIDC/);
        assert.equal(h.commands.some(command => ["plan", "apply"].includes(command[0])), false);
    }
});
test("fresh signed proof gate rejects failed whole runs, reruns, stale/source/subject/protection/window changes and absent review", async () => {
    const { baseline } = fixture();
    assert.equal((await verifyTrustGitHub(githubFor(baseline), baseline, "development")).proofs.development.run, 1201);
    for (const failure of ["failed-whole-run", "rerun", "stale-proof", "wrong-source", "wrong-prefix", "wrong-subject", "branch", "active", "failed-step", "no-review"]) await assert.rejects(verifyTrustGitHub(githubFor(baseline, failure), baseline, "development"), undefined, failure);
    await assert.rejects(verifyTrustGitHub(githubFor(baseline), { ...baseline, window: { ...baseline.window, admissionsFrozen: false } }, "development"));
    await assert.rejects(verifyTrustGitHub(githubFor(baseline), baseline, "production"), /Development qualification/);
});
test("guarded read-only discovery saves full remote state and policy evidence without plan/apply", async t => {
    const h = await harness(t), result = JSON.parse(await h.invoke(["development", "discover"]));
    const discovery = JSON.parse(await readFile(join(result.discoveryDirectory, "discovery.json")));
    assert.deepEqual(discovery.state, h.baseline.state); assert.deepEqual(discovery.permissions, h.baseline.permissions);
    assert.equal(result.trustChanges, false); assert.equal(discovery.independentBaselineReviewRequired, true);
    assert.equal(h.commands.some(command => ["plan", "apply", "import"].includes(command[0])), false);
});
test("workflow proof-only is explicit; default AWS/storage checks depend on proof; root/product copies match", async () => {
    await activateShopWorkflows();
    const workflow = await readFile(new URL("../../../.github/workflows/native-ci-identity.yml", import.meta.url), "utf8");
    const [proof, identity] = workflow.split("  proof:\n")[1].split("  identity:\n");
    assert.match(workflow, /proof_only:[\s\S]*default: false/); assert.match(proof, /environment: Preview/);
    assert.match(proof, /node scripts\/native-ci-identity.mjs/); assert.doesNotMatch(proof, /configure-aws-credentials/);
    assert.match(identity, /needs: proof/); assert.match(identity, /needs.proof.result == 'success' && inputs.proof_only == false/);
    for (const check of ["configure-aws-credentials", "scripts/native-ci-aws.mjs", "scripts/native-ci-lock-check.mjs", "../../scripts/require-release-checks.mjs"]) assert.ok(identity.includes(check));
});
test("Production is a separate approved saved plan after Development completion/readiness; Development remains no-op", async t => {
    const h = await harness(t, { stage: "production" }), beforeDevelopment = structuredClone(h.permissions.development);
    const result = JSON.parse(await h.invoke(["production", "plan"]));
    assert.equal(result.changedResource, "aws_iam_role.production_ci"); h.approve(result);
    const options = [`--review=${basename(result.reviewDirectory)}`, `--plan-sha256=${result.planSha256}`];
    const complete = JSON.parse(await h.invoke(["production", "apply", ...options]));
    assert.equal(complete.refreshedNoOp, true); assert.deepEqual(h.permissions.development, beforeDevelopment);
    assert.ok(await readFile(join(h.directory, "development-started.json"))); assert.ok(await readFile(join(h.directory, "production-started.json")));
});
test("Production rejects fabricated readiness content even with an updated protected hash", async t => {
    const h = await harness(t, { stage: "production" });
    const fake = { cloudQualificationVerified: true };
    await write(join(h.directory, "development-qualification-receipt.json"), fake);
    const baseline = { ...h.baseline, developmentReadiness: { ...h.baseline.developmentReadiness, qualificationReceiptSha256: sha(JSON.stringify(fake)) } };
    await write(join(h.directory, "production-baseline.json"), baseline);
    process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify({ ...h.config, trust_production_baselineSha256: sha(JSON.stringify(baseline)), trust_production_qualificationReceiptSha256: sha(JSON.stringify(fake)) });
    await assert.rejects(h.invoke(["production", "plan"]), /verify-qualification/);
    assert.equal(h.commands.length, 0);
});
test("actual personal GitHub migration reader restricts origin/repositories and always uses GET", async () => {
    process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(baseConfig);
    const calls = [];
    const github = await personalGitHub({ environment: {}, run: async () => ({ stdout: "synthetic-private-token" }), request: async (input, options) => {
        const url = new URL(input); calls.push({ url, options });
        assert.equal(options.method ?? "GET", "GET"); assert.equal(options.redirect, "error");
        if (url.pathname === "/user") return Response.json({ login: "bentbrain", id: Number(owner) });
        if (url.pathname === "/repos/bentbrain/bent-mono") return Response.json({ id: Number(repo), full_name: "bentbrain/bent-mono", owner: { id: Number(owner) } });
        return Response.json({ total_count: 0, workflow_runs: [] });
    } });
    await github.trustRead("/repos/bentbrain/synthetic-previous/actions/runs?status=waiting&per_page=100");
    await github.trustRead("/repos/bentbrain/bent-mono/actions/runs?status=queued");
    const count = calls.length;
    for (const path of ["https://evil.test/repos/bentbrain/bent-mono", "https://user:pass@api.github.com/repos/bentbrain/bent-mono", "/repos/bentbrain/other/actions/runs", "/repos/bentbrain/bent-mono/../other", "/repos/bentbrain/bent-mono/%2e%2e/other"])
        await assert.rejects(github.trustRead(path));
    assert.equal(calls.length, count);
});
test("only an enumerated exact existing child-backed parent observation may be accepted", () => {
    const { baseline, value } = fixture();
    const before = [{ name: "development-state-and-inspection", policy: JSON.stringify({ Version: "2012-10-17", Statement: [] }) }];
    const after = structuredClone(value("aws_iam_role.ci").inline_policy);
    value("aws_iam_role.ci").inline_policy = before;
    baseline.parentObservations = [{ address: "aws_iam_role.ci", before, after }];
    const p = planFor(baseline), resource = p.resource_changes.find(item => item.address === "aws_iam_role.ci");
    const observed = { ...structuredClone(resource.change.before), inline_policy: after };
    p.resource_drift.push({ address: resource.address, mode: "managed", provider_name: AWS, change: { actions: ["update"], before: resource.change.before, after: observed, after_unknown: {} } });
    resource.change.before = observed; resource.change.after.inline_policy = after;
    assert.equal(inspectRepositoryTrustPlan(p, baseline, "development").permissionsChanged, false);
    const changed = structuredClone(p); changed.resource_drift[0].change.after.max_session_duration = 7200;
    assert.throws(() => inspectRepositoryTrustPlan(changed, baseline, "development"));
    const unknownChild = structuredClone(baseline); unknownChild.parentObservations[0].after[0].policy = JSON.stringify({ Version: "2012-10-17", Statement: [] });
    assert.throws(() => inspectRepositoryTrustPlan(p, unknownChild, "development"));
});
