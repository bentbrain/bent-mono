import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE } from "./aws-personal-bootstrap.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
import { developmentHealthProbePermissions, developmentBucketInspectionPermissions } from "./native-development-permissions.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { productionFoundationPermissions, productionTrust, productionStateStatements, PRODUCTION_CI_ARN, PRODUCTION_BOUNDARY_ARN, STATE_BUCKET, STATE_KMS } from "./native-production-permissions.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const check = (value, reason) => {
    if (!value)
        throw new Error(`Production bootstrap stopped: ${reason}`);
};
export const EXISTING_BOOTSTRAP = ["aws_iam_policy.ci_boundary", "aws_iam_role.ci", "aws_iam_role_policy.ci", "aws_kms_alias.state", "aws_kms_key.state",
    "aws_s3_bucket.state", "aws_s3_bucket_ownership_controls.state", "aws_s3_bucket_policy.state", "aws_s3_bucket_public_access_block.state",
    "aws_s3_bucket_server_side_encryption_configuration.state", "aws_s3_bucket_versioning.state"].sort();
export const PRODUCTION_BOOTSTRAP_ADDITIONS = ["aws_iam_policy.production_ci_boundary", "aws_iam_role.production_ci", "aws_iam_role_policy.production_ci"].sort();
const FILES = [".terraform.lock.hcl", "ci.tf", "state.tf", "versions.tf", "development-release-policy.json", "production.tf", "production-foundation-policy.json"].sort();
const IDENTITY_RUN = Number(protectedConfig("resource_930389e560c7"));
const IDENTITY_SHA = "13091a19a048f97b74eed0b0ed783445c0da2796";
export function inspectProductionBootstrapState(state, applied = false) {
    check(state.version === 4 && state.lineage === protectedConfig("resource_7ee824431a13") && Number.isSafeInteger(state.serial) &&
        (applied ? state.serial > 24 : state.serial === 24), "current remote bootstrap lineage/serial.");
    const addresses = applied ? [...EXISTING_BOOTSTRAP, ...PRODUCTION_BOOTSTRAP_ADDITIONS].sort() : EXISTING_BOOTSTRAP;
    check(equal(state.resources?.filter(item => item.mode === "managed").map(item => `${item.type}.${item.name}`).sort(), addresses) &&
        state.resources.every(item => item.provider === 'provider["registry.terraform.io/hashicorp/aws"]' && item.instances?.length === 1), "exact resource inventory.");
    const data = state.resources.filter(item => item.mode === "data");
    check(data.length === 1 && data[0].type === "aws_iam_openid_connect_provider" && data[0].name === "github", "existing OIDC provider.");
    const value = address => state.resources.find(item => `${item.type}.${item.name}` === address).instances[0].attributes;
    for (const address of ["aws_iam_policy.ci_boundary", "aws_iam_role_policy.ci"]) {
        check(equal(JSON.parse(value(address).policy), developmentHealthProbePermissions()), "Development permissions changed.");
    }
    if (applied) {
        verifyProductionResources(value);
        const statements = JSON.parse(value("aws_s3_bucket_policy.state").policy).Statement;
        for (const required of productionStateStatements())
            check(equal(statements.find(item => item.Sid === required.Sid), required), "Production state isolation/retention readback.");
    }
    return { lineage: state.lineage, serial: state.serial, managedResources: addresses.length };
}
function verifyProductionResources(value) {
    const boundary = value("aws_iam_policy.production_ci_boundary"), role = value("aws_iam_role.production_ci"), policy = value("aws_iam_role_policy.production_ci");
    check(boundary.name === "forever-tee-video-production-ci-boundary" && equal(JSON.parse(boundary.policy), productionFoundationPermissions()), "exact Production boundary.");
    check(role.name === "forever-tee-video-production-ci" && role.max_session_duration === 3600 &&
        role.permissions_boundary === PRODUCTION_BOUNDARY_ARN && equal(JSON.parse(role.assume_role_policy), productionTrust()), "exact Production role/trust.");
    check(policy.name === "production-foundation" && policy.role === "forever-tee-video-production-ci" &&
        equal(JSON.parse(policy.policy), productionFoundationPermissions()), "exact Production inline policy.");
}
export function inspectProductionBootstrapPlan(plan) {
    check(plan.terraform_version === "1.12.2" && plan.complete === true && plan.applyable === true && plan.errored === false &&
        !plan.deferred_changes?.length, "complete plan required.");
    // The prior policy resource update left the role parent's computed copy at
    // its previous value. Accept only that exact already-applied observation.
    check((plan.resource_drift ?? []).length <= 1, "unexpected drift.");
    for (const drift of plan.resource_drift ?? []) {
        check(drift.address === "aws_iam_role.ci" && drift.mode === "managed" && drift.provider_name === "registry.terraform.io/hashicorp/aws" &&
            !drift.previous_address && !drift.change.importing && equal(drift.change.actions, ["update"]), "unexpected drift target.");
        const { before, after } = drift.change;
        const expected = permissions => [{ name: "development-state-and-inspection", policy: permissions }];
        const normalize = entries => entries?.map(item => ({ ...item, policy: JSON.parse(item.policy) }));
        check(equal(normalize(before.inline_policy), expected(developmentBucketInspectionPermissions())) &&
            equal(normalize(after.inline_policy), expected(developmentHealthProbePermissions())) &&
            equal({ ...after, inline_policy: before.inline_policy }, before) &&
            equal(plan.resource_changes.find(item => item.address === drift.address)?.change.before, after), "only known parent-policy refresh accepted.");
    }
    check(equal(plan.resource_changes?.map(item => item.address).sort(), [...EXISTING_BOOTSTRAP, ...PRODUCTION_BOOTSTRAP_ADDITIONS].sort()), "only three IAM additions and existing bootstrap resources.");
    check(Object.values(plan.output_changes ?? {}).every(item => equal(item.actions, ["no-op"]) && equal(item.before, item.after)), "existing outputs must not change.");
    const value = address => plan.resource_changes.find(item => item.address === address).change.after;
    verifyProductionResources(value);
    for (const item of plan.resource_changes) {
        const { before, after, actions, after_unknown: unknown = {} } = item.change;
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" && !item.previous_address && !item.change.importing, "provider, move or import.");
        if (PRODUCTION_BOOTSTRAP_ADDITIONS.includes(item.address)) {
            check(equal(actions, ["create"]) && before === null, "Production identities must be new, never adopted.");
            for (const field of ["name", "policy", "assume_role_policy", "permissions_boundary", "role", "max_session_duration"]) {
                check(unknown[field] !== true, "identity/policy must resolve during review.");
            }
            check(!after.managed_policy_arns?.length && !after.inline_policy?.length && (after.path === undefined || after.path === "/"), "unreviewed role attachment/path.");
        }
        else if (item.address === "aws_s3_bucket_policy.state") {
            check(equal(actions, ["update"]) && equal({ ...after, policy: before.policy }, before) && unknown.policy !== true, "only the state bucket policy may update.");
            const previous = JSON.parse(before.policy), next = JSON.parse(after.policy);
            check(!previous.Statement.some(item => productionStateStatements().some(added => added.Sid === item.Sid)), "Production policy already exists.");
            check(equal(next, { ...previous, Statement: [...previous.Statement, ...productionStateStatements()] }), "preserve every existing state permission; add only Production isolation and retention.");
        }
        else
            check(equal(actions, ["no-op"]) && equal(before, after), "existing Development resources must remain unchanged.");
    }
    for (const address of ["aws_iam_policy.ci_boundary", "aws_iam_role_policy.ci"])
        check(equal(JSON.parse(value(address).policy), developmentHealthProbePermissions()), "Development boundary changed.");
    check(JSON.stringify(productionFoundationPermissions()).length <= 6144, "managed policy size limit.");
    return { creates: PRODUCTION_BOOTSTRAP_ADDITIONS, updates: ["aws_s3_bucket_policy.state"], deletes: 0,
        ciRole: PRODUCTION_CI_ARN, policyBytes: JSON.stringify(productionFoundationPermissions()).length,
        workloadDeployment: false, ciCanWriteIAM: false, developmentPermissionsUnchanged: true };
}
export async function verifyProductionGitHub(github) {
    const base = "/repos/bentbrain/bent-mono";
    const environment = await github.api(`${base}/environments/Production`);
    check(equal(environment.deployment_branch_policy, { protected_branches: false, custom_branch_policies: true }), "Production environment must use explicit branch rules.");
    const rules = await github.api(`${base}/environments/Production/deployment-branch-policies`);
    check(rules.total_count === 1 && rules.branch_policies.length === 1 && rules.branch_policies[0].name === "main" && rules.branch_policies[0].type === "branch", "only main, no tags or feature branches.");
    const run = await github.api(`${base}/actions/runs/${IDENTITY_RUN}`);
    check(run.head_sha === IDENTITY_SHA && run.head_branch === "main" && run.conclusion === "success" && run.status === "completed" &&
        run.event === "workflow_dispatch" && run.run_attempt === 1 && run.path === ".github/workflows/native-production-identity.yml" &&
        run.repository?.id === Number(protectedConfig("githubRepositoryId")) && run.head_repository?.id === Number(protectedConfig("githubRepositoryId")), "original signed identity run.");
    const jobs = await github.api(`${base}/actions/runs/${IDENTITY_RUN}/jobs`);
    check(jobs.total_count === 1 && jobs.jobs.length === 1 && jobs.jobs[0].conclusion === "success", "original identity job.");
    const records = (await github.jobLog(jobs.jobs[0].id)).split("\n").filter(line => line.includes('"signatureVerified":true')).map(line => JSON.parse(line.slice(line.indexOf("{"))));
    check(records.length === 1 && records[0].subject === productionTrust().Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] &&
        records[0].signatureVerified === true && records[0].awsAccessAttempted === false && records[0].sourceCommit === IDENTITY_SHA &&
        records[0].ref === "refs/heads/main" && records[0].runId === String(IDENTITY_RUN), "verified signed Production subject.");
    return { identityRun: IDENTITY_RUN, sourceCommit: IDENTITY_SHA, environment: "Production", branch: "main" };
}
export function productionBootstrapArguments(args) {
    if (equal(args, ["plan"]))
        return { operation: "plan" };
    if (args.length === 3 && args[0] === "apply" && /^--review=production-foundation-[A-Za-z0-9]{6}$/.test(args[1]) && /^--plan-sha256=[a-f0-9]{64}$/.test(args[2])) {
        return { operation: "apply", review: args[1].slice(9), planHash: args[2].slice(14) };
    }
    throw new Error("Use production-foundation plan or apply with the exact saved review/hash. No deployment or arbitrary Terraform overrides.");
}
async function sourceHash() {
    const entries = [];
    check(equal((await readdir(BOOTSTRAP_DIRECTORY)).filter(name => /\.tf(?:\.json)?$/.test(name)).sort(), FILES.filter(name => name.endsWith(".tf"))), "unexpected Terraform file.");
    for (const name of FILES)
        entries.push([name, sha(await readFile(join(BOOTSTRAP_DIRECTORY, name)))]);
    for (const name of ["aws-personal-production-bootstrap.mjs", "native-production-permissions.mjs"])
        entries.push([name, sha(await readFile(new URL(name, import.meta.url)))]);
    return sha(JSON.stringify(entries));
}
export async function runProductionBootstrap(args, dependencies) {
    const request = productionBootstrapArguments(args), journal = join(BOOTSTRAP_PRIVATE, "production-foundation-started.json");
    try {
        await lstat(journal);
        throw new Error("Production bootstrap was attempted. Preserve the journal and inspect remote state; never retry automatically.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    const github = await verifyProductionGitHub(await personalGitHub());
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(BOOTSTRAP_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1", GOMAXPROCS: "1" };
    const capture = args => dependencies.executeTerraformCapture(args, env, BOOTSTRAP_DIRECTORY);
    const backend = JSON.parse(resolveProtectedTemplate(await readFile(join(BOOTSTRAP_PRIVATE, "providers/terraform.tfstate")))).backend;
    check(backend?.type === "s3" && backend.config.bucket === STATE_BUCKET && backend.config.key === "story-video/bootstrap/terraform.tfstate" &&
        backend.config.use_lockfile === true && backend.config.encrypt === true && backend.config.kms_key_id === STATE_KMS &&
        backend.config.region === "ap-southeast-2" && equal(backend.config.allowed_account_ids, [protectedConfig("awsAccountId")]), "remote locked KMS backend required.");
    const remote = await capture(["state", "pull"]), state = inspectProductionBootstrapState(JSON.parse(remote));
    const source = await sourceHash();
    const directory = request.operation === "plan" ? await mkdtemp(join(BOOTSTRAP_PRIVATE, "production-foundation-")) : join(BOOTSTRAP_PRIVATE, request.review);
    const planPath = join(directory, "bootstrap.tfplan");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "remote-before.tfstate"), remote);
        await privateWrite(join(directory, "plan.txt"), await capture(["plan", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", `-out=${planPath}`]));
    }
    const raw = await capture(["show", "-json", planPath]);
    if (request.operation === "plan")
        await privateWrite(join(directory, "plan.json"), raw);
    const inspected = inspectProductionBootstrapPlan(JSON.parse(raw)), planHash = sha(await readFile(planPath));
    const review = { sourceHash: source, planHash, state, github, ...inspected };
    check(source === await sourceHash(), "source changed during review.");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "review.json"), JSON.stringify(review));
        return JSON.stringify({ reviewDirectory: directory, ...review }) + "\n";
    }
    check(request.planHash === planHash && equal(JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "review.json")))), review) &&
        equal(JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "remote-before.tfstate")))), JSON.parse(remote)), "saved review/source/state changed.");
    // Only exact NoSuchEntity is absence. Access denial/expiry/network errors stop.
    for (const [operation, flag, target, api] of [["get-role", "--role-name", "forever-tee-video-production-ci", "GetRole"],
        ["get-policy", "--policy-arn", PRODUCTION_BOUNDARY_ARN, "GetPolicy"]]) {
        try {
            await guardedPersonalCall(["iam", operation, flag, target], dependencies);
        }
        catch (error) {
            if (typeof error.stderr === "string" && error.stderr.includes(`(NoSuchEntity) when calling the ${api} operation`))
                continue;
            throw new Error("Production bootstrap collision check failed; no apply attempted.");
        }
        throw new Error("Production identity already exists; takeover forbidden.");
    }
    const snapshots = [];
    for (const name of ["terraform.tfstate", "terraform.tfstate.backup"]) {
        const bytes = await readFile(join(BOOTSTRAP_PRIVATE, name));
        await privateWrite(join(directory, `retained-${name}`), bytes);
        snapshots.push({ name, sha256: sha(bytes) });
    }
    await privateWrite(journal, JSON.stringify({ directory, source, planHash, snapshots, startedAt: new Date().toISOString() }));
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    await verifyProductionGitHub(await personalGitHub());
    check(source === await sourceHash() && planHash === sha(await readFile(planPath)) &&
        equal(JSON.parse(await capture(["state", "pull"])), JSON.parse(remote)), "state/source changed before apply.");
    await dependencies.executeTerraform(["apply", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", planPath], env, BOOTSTRAP_DIRECTORY);
    const after = await capture(["state", "pull"]);
    await privateWrite(join(directory, "remote-after.tfstate"), after);
    const verified = inspectProductionBootstrapState(JSON.parse(after), true);
    for (const snapshot of snapshots)
        check(sha(await readFile(join(BOOTSTRAP_PRIVATE, snapshot.name))) === snapshot.sha256, "retained local snapshot changed.");
    const complete = { ...inspected, state: verified, planHash, completedAt: new Date().toISOString() };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(complete));
    return JSON.stringify({ evidenceDirectory: directory, ...complete }) + "\n";
}
