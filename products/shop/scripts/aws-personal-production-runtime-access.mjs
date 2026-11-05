import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE } from "./aws-personal-bootstrap.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { EXISTING_BOOTSTRAP, PRODUCTION_BOOTSTRAP_ADDITIONS, verifyProductionGitHub } from "./aws-personal-production-bootstrap.mjs";
import { inspectAlertAccessState } from "./aws-personal-production-alert-access.mjs";
import { productionFoundationPermissions, productionAlertReadPermissions, STATE_BUCKET, STATE_KMS } from "./native-production-permissions.mjs";
import { productionReleasePermissions, productionRuntimeTerraform, RUNTIME_IDENTITIES, identityName, identityArn, identityBoundaryArn } from "./native-production-runtime-permissions.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const check = (value, reason) => {
    if (!value)
        throw new Error(`Production runtime access stopped: ${reason}`);
};
const TARGETS = ["aws_iam_policy.production_ci_boundary", "aws_iam_role_policy.production_ci"];
const EXISTING = [...EXISTING_BOOTSTRAP, ...PRODUCTION_BOOTSTRAP_ADDITIONS].sort();
const CONFIG = productionRuntimeTerraform().resource;
export const RUNTIME_ADDITIONS = Object.entries(CONFIG).flatMap(([type, values]) => Object.keys(values).map(name => `${type}.${name}`)).sort();
const FILES = [".terraform.lock.hcl", "ci.tf", "state.tf", "versions.tf", "development-release-policy.json", "production.tf", "production-foundation-policy.json", "production-release-policy.json", "production-runtime.tf.json"].sort();
const changed = item => !equal(item.before, item.after);
const hasUnknown = value => value === true || (value !== null && typeof value === "object" && Object.values(value).some(hasUnknown));
function verifyRuntimeValue(address, value, unknown = {}) {
    const [type, name] = address.split("."), expected = CONFIG[type][name];
    for (const [key, required] of Object.entries(expected)) {
        if (["lifecycle", "depends_on"].includes(key))
            continue;
        check(!hasUnknown(unknown[key]), `runtime ${key} must be known.`);
        check(equal(["policy", "assume_role_policy"].includes(key) ? JSON.parse(value[key]) : value[key], ["policy", "assume_role_policy"].includes(key) ? JSON.parse(required) : required), `exact runtime ${key}.`);
    }
    check(!value.managed_policy_arns?.length && !value.inline_policy?.length && !value.force_detach_policies, "no extra runtime policy attachments.");
}
export function inspectRuntimeAccessState(state, applied = false, releasePolicy = productionReleasePermissions()) {
    check(applied ? state.serial > 26 : state.serial === 26, "expected remote bootstrap serial.");
    check(state.resources?.every(item => item.instances?.length === 1 && !item.instances[0].status && !item.instances[0].deposed), "untainted single instances required.");
    const expected = applied ? [...EXISTING, ...RUNTIME_ADDITIONS].sort() : EXISTING;
    check(equal(state.resources.filter(item => item.mode === "managed").map(item => `${item.type}.${item.name}`).sort(), expected), "exact resource inventory.");
    const old = structuredClone(state);
    if (applied) {
        for (const resource of old.resources.filter(item => RUNTIME_ADDITIONS.includes(`${item.type}.${item.name}`))) {
            check(resource.provider === 'provider["registry.terraform.io/hashicorp/aws"]', "runtime provider unchanged.");
            const address = `${resource.type}.${resource.name}`, value = resource.instances[0].attributes;
            verifyRuntimeValue(address, value);
            const kind = resource.name.replace(/^production_/, "").replace(/_boundary$/, "");
            if (["aws_iam_role", "aws_iam_user", "aws_iam_policy"].includes(resource.type)) {
                check(value.arn === (resource.type === "aws_iam_policy" ? identityBoundaryArn(kind) : identityArn(kind)), "exact runtime ARN.");
            }
        }
        old.resources = old.resources.filter(item => !RUNTIME_ADDITIONS.includes(`${item.type}.${item.name}`));
        for (const address of TARGETS) {
            const value = old.resources.find(item => `${item.type}.${item.name}` === address).instances[0].attributes;
            check(equal(JSON.parse(value.policy), releasePolicy), "exact applied release ceiling.");
            value.policy = JSON.stringify(productionAlertReadPermissions());
        }
    }
    inspectAlertAccessState(old, true);
    return { lineage: state.lineage, serial: state.serial, managedResources: expected.length };
}
export function inspectRuntimeAccessPlan(plan) {
    check(plan.terraform_version === "1.12.2" && plan.complete === true && plan.applyable === true && plan.errored === false && !plan.deferred_changes?.length, "complete reviewed plan required.");
    check(equal(plan.resource_changes?.map(item => item.address).sort(), [...EXISTING, ...RUNTIME_ADDITIONS].sort()), "only nine runtime additions and existing bootstrap resources.");
    check(Object.values(plan.output_changes ?? {}).every(item => equal(item.actions, ["no-op"]) && !changed(item)), "no output changes.");
    for (const item of plan.resource_changes) {
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" && !item.previous_address && !item.change.importing, "no provider, import or move changes.");
        const { before, after, actions, after_unknown: unknown = {} } = item.change;
        if (RUNTIME_ADDITIONS.includes(item.address)) {
            check(equal(actions, ["create"]) && before === null, "runtime identities must be new; no takeover.");
            verifyRuntimeValue(item.address, after, unknown);
        }
        else if (TARGETS.includes(item.address)) {
            check(equal(actions, ["update"]) && !unknown.policy && equal(JSON.parse(before.policy), productionAlertReadPermissions()) &&
                equal(JSON.parse(after.policy), productionReleasePermissions()) && equal({ ...after, policy: before.policy }, before), "only the reviewed release ceiling may update.");
        }
        else
            check(equal(actions, ["no-op"]) && !changed(item.change), "existing resources, trust and Development permissions remain unchanged.");
    }
    // The SNS correction updated the child, leaving its parent's computed copy
    // at the earlier value. Only that exact, child-backed observation is allowed.
    check((plan.resource_drift ?? []).length <= 1, "unreviewed drift.");
    for (const item of plan.resource_drift ?? []) {
        check(item.address === "aws_iam_role.production_ci" && item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" &&
            !item.previous_address && !item.change.importing && equal(item.change.actions, ["update"]), "unexpected state observation.");
        const { before, after } = item.change;
        const normalize = values => values?.map(value => ({ ...value, policy: JSON.parse(value.policy) }));
        const expected = policy => [{ name: "production-foundation", policy }];
        check(equal(normalize(before.inline_policy), expected(productionFoundationPermissions())) &&
            equal(normalize(after.inline_policy), expected(productionAlertReadPermissions())) && equal({ ...after, inline_policy: before.inline_policy }, before) &&
            equal(plan.resource_changes.find(value => value.address === item.address)?.change.before, after), "only the applied child policy observation.");
    }
    check(JSON.stringify(productionReleasePermissions()).length <= 6144, "managed policy size limit.");
    return { creates: RUNTIME_ADDITIONS, updates: TARGETS, deletes: 0, policyBytes: JSON.stringify(productionReleasePermissions()).length,
        serviceKeysCreated: false, applicationDeployment: false, developmentPermissionsUnchanged: true };
}
export function runtimeAccessArguments(args) {
    if (equal(args, ["plan"]))
        return { operation: "plan" };
    if (args.length === 3 && args[0] === "apply" && /^--review=production-runtime-access-[A-Za-z0-9]{6}$/.test(args[1]) && /^--plan-sha256=[a-f0-9]{64}$/.test(args[2])) {
        return { operation: "apply", review: args[1].slice(9), planHash: args[2].slice(14) };
    }
    throw new Error("Use production-runtime-access plan or apply with its exact saved review/hash.");
}
async function sourceHash() {
    check(equal((await readdir(BOOTSTRAP_DIRECTORY)).filter(name => /\.tf(?:\.json)?$/.test(name)).sort(), FILES.filter(name => /\.tf(?:\.json)?$/.test(name))), "unexpected Terraform file.");
    check(equal(JSON.parse(resolveProtectedTemplate(await readFile(join(BOOTSTRAP_DIRECTORY, "production-runtime.tf.json")))), productionRuntimeTerraform()), "exact runtime source required.");
    check(equal(JSON.parse(resolveProtectedTemplate(await readFile(join(BOOTSTRAP_DIRECTORY, "production-release-policy.json")))), productionReleasePermissions()), "exact release policy source required.");
    const entries = [];
    for (const name of FILES)
        entries.push([name, sha(await readFile(join(BOOTSTRAP_DIRECTORY, name)))]);
    for (const name of ["aws-personal-production-runtime-access.mjs", "native-production-runtime-permissions.mjs", "native-production-permissions.mjs",
        "aws-personal-production-alert-access.mjs", "aws-personal-production-bootstrap.mjs", "aws-personal-guard.mjs", "aws-personal-bootstrap.mjs"])
        entries.push([name, sha(await readFile(new URL(name, import.meta.url)))]);
    return sha(JSON.stringify(entries));
}
async function verifyRuntimeVacancy(dependencies) {
    for (const kind of RUNTIME_IDENTITIES) {
        const user = kind === "invoker";
        for (const [operation, flag, target, api] of [[user ? "get-user" : "get-role", user ? "--user-name" : "--role-name", identityName(kind), user ? "GetUser" : "GetRole"],
            ["get-policy", "--policy-arn", identityBoundaryArn(kind), "GetPolicy"]]) {
            try {
                await guardedPersonalCall(["iam", operation, flag, target], dependencies);
            }
            catch (error) {
                if (typeof error.stderr === "string" && error.stderr.includes(`(NoSuchEntity) when calling the ${api} operation`))
                    continue;
                throw new Error("Production runtime collision check failed; no apply attempted.");
            }
            throw new Error("Production runtime identity already exists; takeover forbidden.");
        }
    }
}
export async function runProductionRuntimeAccess(args, dependencies) {
    const request = runtimeAccessArguments(args), journal = join(BOOTSTRAP_PRIVATE, "production-runtime-access-started.json");
    try {
        await lstat(journal);
        throw new Error("Production runtime access was attempted; preserve the journal and inspect before recovery.");
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
    const remote = await capture(["state", "pull"]), state = inspectRuntimeAccessState(JSON.parse(remote)), source = await sourceHash();
    await verifyRuntimeVacancy(dependencies);
    const directory = request.operation === "plan" ? await mkdtemp(join(BOOTSTRAP_PRIVATE, "production-runtime-access-")) : join(BOOTSTRAP_PRIVATE, request.review);
    const path = join(directory, "access.tfplan");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "remote-before.tfstate"), remote);
        await privateWrite(join(directory, "plan.txt"), await capture(["plan", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", `-out=${path}`]));
    }
    const raw = await capture(["show", "-json", path]);
    if (request.operation === "plan")
        await privateWrite(join(directory, "plan.json"), raw);
    const inspected = inspectRuntimeAccessPlan(JSON.parse(raw)), planHash = sha(await readFile(path));
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
    const verified = inspectRuntimeAccessState(JSON.parse(after), true);
    for (const item of snapshots)
        check(sha(await readFile(join(BOOTSTRAP_PRIVATE, item.name))) === item.sha256, "retained local snapshot changed.");
    const complete = { ...inspected, state: verified, planHash, completedAt: new Date().toISOString() };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(complete));
    return JSON.stringify({ evidenceDirectory: directory, ...complete }) + "\n";
}
