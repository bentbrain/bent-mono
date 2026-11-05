import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE } from "./aws-personal-bootstrap.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { EXISTING_BOOTSTRAP, PRODUCTION_BOOTSTRAP_ADDITIONS, verifyProductionGitHub } from "./aws-personal-production-bootstrap.mjs";
import { RUNTIME_ADDITIONS, inspectRuntimeAccessState } from "./aws-personal-production-runtime-access.mjs";
import { productionAlertReadPermissions, STATE_BUCKET, STATE_KMS } from "./native-production-permissions.mjs";
import { PREVIOUS_PRODUCTION_CANDIDATE_RESOURCES, PRODUCTION_CANDIDATE_RESOURCES, legacyProductionReleasePermissions, previousProductionReleasePermissions, productionRuntimePermissions, productionReleasePermissions, } from "./native-production-runtime-permissions.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const check = (value, reason) => {
    if (!value)
        throw new Error(`Production candidate access stopped: ${reason}`);
};
const TARGETS = ["aws_iam_policy.production_ci_boundary", "aws_iam_role_policy.production_ci"];
export const PRODUCTION_CANDIDATE_ACCESS_ID = protectedConfig("resource_7acc6e376e5e");
const REVIEW_PREFIX = `production-candidate-access-${PRODUCTION_CANDIDATE_ACCESS_ID}`;
export const CANDIDATE_ACCESS_INVENTORY = [...EXISTING_BOOTSTRAP, ...PRODUCTION_BOOTSTRAP_ADDITIONS, ...RUNTIME_ADDITIONS].sort();
const FILES = [".terraform.lock.hcl", "ci.tf", "state.tf", "versions.tf", "development-release-policy.json", "production.tf",
    "production-foundation-policy.json", "production-release-policy.json", "production-runtime.tf.json"].sort();
export function normalizeCandidateParentObservations(state, applied = false) {
    const current = structuredClone(state);
    const normalize = (address, expected, replacement) => {
        const role = current.resources?.find(item => `${item.type}.${item.name}` === address);
        check(role?.instances?.length === 1 && !role.instances[0].status && !role.instances[0].deposed, "exact observed parent role state.");
        const value = role.instances[0].attributes, inline = value.inline_policy?.map(item => ({ ...item, policy: JSON.parse(item.policy) }));
        check(equal(inline, expected), `exact child-backed parent role observation for ${address}.`);
        value.inline_policy = replacement;
    };
    for (const kind of ["failures", "runtime"])
        normalize(`aws_iam_role.production_${kind}`, [{ name: "production-runtime", policy: productionRuntimePermissions(kind) }], []);
    normalize("aws_iam_role.production_ci", [{ name: "production-foundation",
            policy: applied ? previousProductionReleasePermissions() : legacyProductionReleasePermissions() }], [{ name: "production-foundation", policy: JSON.stringify(productionAlertReadPermissions()) }]);
    return current;
}
function inspectCandidateAccessState(state, applied = false) {
    const current = normalizeCandidateParentObservations(state, applied);
    const verified = inspectRuntimeAccessState(current, true, applied ? productionReleasePermissions() : previousProductionReleasePermissions());
    return { ...verified, candidateAccessApplied: applied };
}
export function inspectCandidateAccessPlan(plan) {
    check(plan.terraform_version === "1.12.2" && plan.complete === true && plan.applyable === true && plan.errored === false &&
        !plan.deferred_changes?.length, "complete reviewed plan required.");
    check(equal(plan.resource_changes?.map(item => item.address).sort(), CANDIDATE_ACCESS_INVENTORY), "exact existing bootstrap and runtime inventory.");
    check(Object.values(plan.output_changes ?? {}).every(item => equal(item.actions, ["no-op"]) && equal(item.before, item.after)), "no output changes.");
    for (const item of plan.resource_changes) {
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" && !item.previous_address && !item.change.importing, "no provider, import or move changes.");
        const { before, after, actions, after_unknown: unknown = {} } = item.change;
        if (TARGETS.includes(item.address)) {
            check(equal(actions, ["update"]) && unknown.policy !== true && equal(JSON.parse(before.policy), previousProductionReleasePermissions()) &&
                equal(JSON.parse(after.policy), productionReleasePermissions()) && equal({ ...after, policy: before.policy }, before), "only the exact candidate S3 reads may change in both Production policies.");
        }
        else
            check(equal(actions, ["no-op"]) && equal(before, after), "existing resources, trust and runtime permissions must stay unchanged.");
    }
    const expectedDrift = new Map([["aws_iam_role.production_ci", {
                before: [{ name: "production-foundation", policy: legacyProductionReleasePermissions() }],
                after: [{ name: "production-foundation", policy: previousProductionReleasePermissions() }],
            }]]);
    check(plan.resource_drift?.length === expectedDrift.size &&
        equal(plan.resource_drift.map(item => item.address).sort(), [...expectedDrift.keys()].sort()), "only exact child-policy parent observations are permitted.");
    for (const item of plan.resource_drift) {
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" && !item.previous_address && !item.change.importing &&
            equal(item.change.actions, ["update"]), "exact parent role observation shape.");
        const { before, after } = item.change, expected = expectedDrift.get(item.address);
        const normalize = values => values?.map(value => ({ ...value, policy: JSON.parse(value.policy) }));
        check(equal(normalize(before.inline_policy), expected.before) && equal(normalize(after.inline_policy), expected.after) &&
            equal({ ...after, inline_policy: before.inline_policy }, before), "only the expected child-backed inline policy may be observed.");
        const resource = plan.resource_changes.find(value => value.address === item.address);
        check(equal(resource?.change.actions, ["no-op"]) && equal(resource.change.before, after) && equal(resource.change.after, after), "observed parent role must remain unchanged by the plan.");
    }
    check(JSON.stringify(productionReleasePermissions()).length <= 6144, "managed policy size limit.");
    return { updates: TARGETS, creates: 0, deletes: 0,
        grantedResources: PRODUCTION_CANDIDATE_RESOURCES.filter(value => !PREVIOUS_PRODUCTION_CANDIDATE_RESOURCES.includes(value)),
        retiredResources: PREVIOUS_PRODUCTION_CANDIDATE_RESOURCES.filter(value => !PRODUCTION_CANDIDATE_RESOURCES.includes(value)),
        policyBytes: JSON.stringify(productionReleasePermissions()).length, applicationDeployment: false, otherPermissionsUnchanged: true };
}
export function candidateAccessArguments(args) {
    if (equal(args, ["plan"]))
        return { operation: "plan" };
    if (args.length === 3 && args[0] === "apply" && new RegExp(`^--review=${REVIEW_PREFIX}-[A-Za-z0-9]{6}$`).test(args[1]) &&
        /^--plan-sha256=[a-f0-9]{64}$/.test(args[2]))
        return { operation: "apply", review: args[1].slice(9), planHash: args[2].slice(14) };
    throw new Error("Use production-candidate-access plan or apply with its exact saved review/hash.");
}
export async function hashCandidateAccessEvidence(directory, reader = readFile) {
    const evidence = [];
    for (const name of ["remote-before.tfstate", "review.json", "access.tfplan"]) {
        evidence.push({ name, sha256: sha(await reader(join(directory, name))) });
    }
    return evidence;
}
async function sourceHash() {
    check(equal((await readdir(BOOTSTRAP_DIRECTORY)).filter(name => /\.tf(?:\.json)?$/.test(name)).sort(), FILES.filter(name => /\.tf(?:\.json)?$/.test(name))), "unexpected Terraform file.");
    check(equal(JSON.parse(resolveProtectedTemplate(await readFile(join(BOOTSTRAP_DIRECTORY, "production-release-policy.json")))), productionReleasePermissions()), "exact release policy source required.");
    const entries = [];
    for (const name of FILES)
        entries.push([name, sha(await readFile(join(BOOTSTRAP_DIRECTORY, name)))]);
    for (const name of ["aws-personal-production-candidate-access.mjs", "aws-personal-production-runtime-access.mjs",
        "native-production-runtime-permissions.mjs", "native-production-permissions.mjs", "aws-personal-production-bootstrap.mjs",
        "aws-personal-guard.mjs", "aws-personal-bootstrap.mjs"])
        entries.push([name, sha(await readFile(new URL(name, import.meta.url)))]);
    return sha(JSON.stringify(entries));
}
export async function runProductionCandidateAccess(args, dependencies) {
    const request = candidateAccessArguments(args), journal = join(BOOTSTRAP_PRIVATE, `${REVIEW_PREFIX}-started.json`);
    try {
        await lstat(journal);
        throw new Error("Production candidate access was attempted; preserve the journal and inspect before recovery.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    const github = await verifyProductionGitHub(await personalGitHub());
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(BOOTSTRAP_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", TF_WORKSPACE: "default", CHECKPOINT_DISABLE: "1", GOMAXPROCS: "1" };
    const capture = command => dependencies.executeTerraformCapture(command, env, BOOTSTRAP_DIRECTORY);
    const backend = JSON.parse(resolveProtectedTemplate(await readFile(join(BOOTSTRAP_PRIVATE, "providers/terraform.tfstate")))).backend;
    check(backend?.type === "s3" && backend.config.bucket === STATE_BUCKET && backend.config.key === "story-video/bootstrap/terraform.tfstate" &&
        backend.config.use_lockfile === true && backend.config.encrypt === true && backend.config.kms_key_id === STATE_KMS &&
        backend.config.region === "ap-southeast-2" && equal(backend.config.allowed_account_ids, [protectedConfig("awsAccountId")]), "fixed remote locked KMS backend.");
    const remote = await capture(["state", "pull"]), state = inspectCandidateAccessState(JSON.parse(remote)), source = await sourceHash();
    const directory = request.operation === "plan" ? await mkdtemp(join(BOOTSTRAP_PRIVATE, `${REVIEW_PREFIX}-`)) : join(BOOTSTRAP_PRIVATE, request.review);
    const path = join(directory, "access.tfplan");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "remote-before.tfstate"), remote);
        await privateWrite(join(directory, "plan.txt"), await capture(["plan", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", `-out=${path}`]));
    }
    const raw = await capture(["show", "-json", path]);
    if (request.operation === "plan")
        await privateWrite(join(directory, "plan.json"), raw);
    const inspected = inspectCandidateAccessPlan(JSON.parse(raw)), planHash = sha(await readFile(path));
    const review = { sourceHash: source, planHash, state, github, ...inspected };
    check(source === await sourceHash(), "source changed during review.");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "review.json"), JSON.stringify(review));
        return JSON.stringify({ reviewDirectory: directory, ...review }) + "\n";
    }
    check(request.planHash === planHash && equal(JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "review.json")))), review) &&
        equal(JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "remote-before.tfstate")))), JSON.parse(remote)), "saved plan/review/source/state changed.");
    const evidence = await hashCandidateAccessEvidence(directory);
    await privateWrite(journal, JSON.stringify({ directory, source, planHash, evidence, startedAt: new Date().toISOString() }));
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    await verifyProductionGitHub(await personalGitHub());
    check(source === await sourceHash() && planHash === sha(await readFile(path)) &&
        equal(JSON.parse(await capture(["state", "pull"])), JSON.parse(remote)), "source/state changed before apply.");
    await dependencies.executeTerraform(["apply", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", path], env, BOOTSTRAP_DIRECTORY);
    const after = await capture(["state", "pull"]);
    await privateWrite(join(directory, "remote-after.tfstate"), after);
    const verified = inspectCandidateAccessState(JSON.parse(after), true);
    check(verified.serial > state.serial, "remote state did not advance.");
    for (const item of evidence)
        check(sha(await readFile(join(directory, item.name))) === item.sha256, "saved apply evidence changed.");
    const complete = { ...inspected, state: verified, planHash, completedAt: new Date().toISOString() };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(complete));
    return JSON.stringify({ evidenceDirectory: directory, ...complete }) + "\n";
}
