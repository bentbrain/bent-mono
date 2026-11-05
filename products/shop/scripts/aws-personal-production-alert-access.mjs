import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE } from "./aws-personal-bootstrap.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { EXISTING_BOOTSTRAP, PRODUCTION_BOOTSTRAP_ADDITIONS, inspectProductionBootstrapState, verifyProductionGitHub } from "./aws-personal-production-bootstrap.mjs";
import { productionFoundationPermissions, productionAlertReadPermissions, productionStateStatements, STATE_BUCKET, STATE_KMS } from "./native-production-permissions.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const check = (value, reason) => {
    if (!value)
        throw new Error(`Production alert access stopped: ${reason}`);
};
const TARGETS = ["aws_iam_policy.production_ci_boundary", "aws_iam_role_policy.production_ci"];
const INVENTORY = [...EXISTING_BOOTSTRAP, ...PRODUCTION_BOOTSTRAP_ADDITIONS].sort();
const FILES = [".terraform.lock.hcl", "ci.tf", "state.tf", "versions.tf", "development-release-policy.json", "production.tf", "production-foundation-policy.json"].sort();
export function inspectAlertAccessState(state, applied = false) {
    check(applied ? state.serial > 25 : state.serial === 25, "expected current remote bootstrap serial.");
    const previous = structuredClone(state);
    for (const address of TARGETS) {
        const resource = previous.resources?.find(item => `${item.type}.${item.name}` === address);
        check(resource?.instances?.length === 1 && !resource.instances[0].status, "exact untainted policy instance.");
        const value = resource.instances[0].attributes;
        check(equal(JSON.parse(value.policy), applied ? productionAlertReadPermissions() : productionFoundationPermissions()), "exact recorded policy.");
        value.policy = JSON.stringify(productionFoundationPermissions());
    }
    return inspectProductionBootstrapState(previous, true);
}
export function inspectAlertAccessPlan(plan) {
    check(plan.terraform_version === "1.12.2" && plan.complete === true && plan.applyable === true && plan.errored === false &&
        !plan.deferred_changes?.length && equal(plan.resource_changes?.map(item => item.address).sort(), INVENTORY), "complete exact bootstrap plan.");
    check(Object.values(plan.output_changes ?? {}).every(item => equal(item.actions, ["no-op"]) && equal(item.before, item.after)), "no output changes.");
    for (const item of plan.resource_changes) {
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" && !item.previous_address && !item.change.importing, "no provider, import or move changes.");
        const { before, after, actions } = item.change;
        if (TARGETS.includes(item.address)) {
            check(equal(actions, ["update"]) && item.change.after_unknown?.policy !== true &&
                equal(JSON.parse(before.policy), productionFoundationPermissions()) && equal(JSON.parse(after.policy), productionAlertReadPermissions()) &&
                equal({ ...after, policy: before.policy }, before), "only the exact SNS read resource may change in both policies.");
        }
        else
            check(equal(actions, ["no-op"]) && equal(before, after), "existing resources and trust must stay unchanged.");
    }
    const seen = new Set();
    for (const item of plan.resource_drift ?? []) {
        check(!seen.has(item.address) && item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" &&
            !item.previous_address && !item.change.importing && equal(item.change.actions, ["update"]), "unexpected or duplicate state observation.");
        seen.add(item.address);
        const { before, after } = item.change;
        const resource = plan.resource_changes.find(value => value.address === item.address);
        check(equal(resource?.change.actions, ["no-op"]) && equal(resource.change.before, after), "observed resource must remain unchanged.");
        if (item.address === "aws_iam_role.production_ci") {
            const policies = after.inline_policy?.map(value => ({ ...value, policy: JSON.parse(value.policy) }));
            check(equal(before.inline_policy, []) && equal(policies, [{ name: "production-foundation", policy: productionFoundationPermissions() }]) &&
                equal({ ...after, inline_policy: before.inline_policy }, before), "only the existing Production child policy observation.");
        }
        else if (item.address === "aws_s3_bucket.state") {
            const oldPolicy = JSON.parse(before.policy), next = JSON.parse(after.policy);
            const child = plan.resource_changes.find(value => value.address === "aws_s3_bucket_policy.state");
            check(equal(next, { ...oldPolicy, Statement: [...oldPolicy.Statement, ...productionStateStatements()] }) &&
                equal(JSON.parse(child.change.after.policy), next) && equal({ ...after, policy: before.policy }, before), "only the already-applied Production state isolation observation.");
        }
        else
            check(false, "unreviewed observation.");
    }
    return { updates: TARGETS, creates: 0, deletes: 0, action: "sns:GetSubscriptionAttributes", resource: productionAlertReadPermissions().Statement.find(item => item.Sid === "P12").Resource,
        policyBytes: JSON.stringify(productionAlertReadPermissions()).length, developmentPermissionsUnchanged: true, applicationDeployment: false };
}
export function alertAccessArguments(args) {
    if (equal(args, ["plan"]))
        return { operation: "plan" };
    if (args.length === 3 && args[0] === "apply" && /^--review=production-alert-access-[A-Za-z0-9]{6}$/.test(args[1]) && /^--plan-sha256=[a-f0-9]{64}$/.test(args[2])) {
        return { operation: "apply", review: args[1].slice(9), planHash: args[2].slice(14) };
    }
    throw new Error("Use production-alert-access plan or apply with its exact saved review/hash.");
}
async function sourceHash() {
    check(equal((await readdir(BOOTSTRAP_DIRECTORY)).filter(name => /\.tf(?:\.json)?$/.test(name)).sort(), FILES.filter(name => name.endsWith(".tf"))), "unexpected Terraform file.");
    const entries = [];
    for (const name of FILES)
        entries.push([name, sha(await readFile(join(BOOTSTRAP_DIRECTORY, name)))]);
    for (const name of ["aws-personal-production-alert-access.mjs", "native-production-permissions.mjs", "aws-personal-production-bootstrap.mjs"])
        entries.push([name, sha(await readFile(new URL(name, import.meta.url)))]);
    return sha(JSON.stringify(entries));
}
export async function runProductionAlertAccess(args, dependencies) {
    const request = alertAccessArguments(args), journal = join(BOOTSTRAP_PRIVATE, "production-alert-access-started.json");
    try {
        await lstat(journal);
        throw new Error("Production alert access was attempted; preserve the journal and inspect before recovery.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    const github = await verifyProductionGitHub(await personalGitHub());
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(BOOTSTRAP_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", TF_WORKSPACE: "default", CHECKPOINT_DISABLE: "1", GOMAXPROCS: "1" };
    const capture = args => dependencies.executeTerraformCapture(args, env, BOOTSTRAP_DIRECTORY);
    const backend = JSON.parse(resolveProtectedTemplate(await readFile(join(BOOTSTRAP_PRIVATE, "providers/terraform.tfstate")))).backend;
    check(backend?.type === "s3" && backend.config.bucket === STATE_BUCKET && backend.config.key === "story-video/bootstrap/terraform.tfstate" &&
        backend.config.use_lockfile === true && backend.config.encrypt === true && backend.config.kms_key_id === STATE_KMS &&
        backend.config.region === "ap-southeast-2" && equal(backend.config.allowed_account_ids, [protectedConfig("awsAccountId")]), "fixed remote locked KMS backend.");
    const remote = await capture(["state", "pull"]), state = inspectAlertAccessState(JSON.parse(remote)), source = await sourceHash();
    const directory = request.operation === "plan" ? await mkdtemp(join(BOOTSTRAP_PRIVATE, "production-alert-access-")) : join(BOOTSTRAP_PRIVATE, request.review);
    const path = join(directory, "access.tfplan");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "remote-before.tfstate"), remote);
        await privateWrite(join(directory, "plan.txt"), await capture(["plan", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", `-out=${path}`]));
    }
    const raw = await capture(["show", "-json", path]);
    if (request.operation === "plan")
        await privateWrite(join(directory, "plan.json"), raw);
    const inspected = inspectAlertAccessPlan(JSON.parse(raw)), planHash = sha(await readFile(path));
    const review = { sourceHash: source, planHash, state, github, ...inspected };
    check(source === await sourceHash(), "source changed during review.");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "review.json"), JSON.stringify(review));
        return JSON.stringify({ reviewDirectory: directory, ...review }) + "\n";
    }
    check(request.planHash === planHash && equal(JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "review.json")))), review) &&
        equal(JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "remote-before.tfstate")))), JSON.parse(remote)), "saved plan/review/source/state changed.");
    const snapshots = [];
    for (const name of ["terraform.tfstate", "terraform.tfstate.backup"]) {
        const bytes = await readFile(join(BOOTSTRAP_PRIVATE, name));
        await privateWrite(join(directory, `retained-${name}`), bytes);
        snapshots.push({ name, sha256: sha(bytes) });
    }
    await privateWrite(journal, JSON.stringify({ directory, source, planHash, snapshots, startedAt: new Date().toISOString() }));
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    await verifyProductionGitHub(await personalGitHub());
    check(source === await sourceHash() && planHash === sha(await readFile(path)) && equal(JSON.parse(await capture(["state", "pull"])), JSON.parse(remote)), "source/state changed before apply.");
    await dependencies.executeTerraform(["apply", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", path], env, BOOTSTRAP_DIRECTORY);
    const after = await capture(["state", "pull"]);
    await privateWrite(join(directory, "remote-after.tfstate"), after);
    const verified = inspectAlertAccessState(JSON.parse(after), true);
    for (const item of snapshots)
        check(sha(await readFile(join(BOOTSTRAP_PRIVATE, item.name))) === item.sha256, "retained local snapshot changed.");
    const complete = { ...inspected, state: verified, planHash, completedAt: new Date().toISOString() };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(complete));
    return JSON.stringify({ evidenceDirectory: directory, ...complete }) + "\n";
}
