import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdtemp, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE, sourceDigest } from "./aws-personal-bootstrap.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { inspectHealthProbeAccess } from "./aws-personal-release-access.mjs";
import { developmentBucketInspectionPermissions, developmentHealthProbePermissions } from "./native-development-permissions.mjs";
import { verifyGitHubActivation } from "./aws-personal-ci-activation.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => {
    if (!value)
        throw new Error(`Development health-probe access stopped: ${reason}`);
};
const addresses = ["aws_iam_policy.ci_boundary", "aws_iam_role.ci", "aws_iam_role_policy.ci", "aws_kms_alias.state", "aws_kms_key.state",
    "aws_s3_bucket.state", "aws_s3_bucket_ownership_controls.state", "aws_s3_bucket_policy.state", "aws_s3_bucket_public_access_block.state",
    "aws_s3_bucket_server_side_encryption_configuration.state", "aws_s3_bucket_versioning.state"].sort();
export function inspectHealthAccessState(state, applied = false) {
    check(state.version === 4 && state.lineage === protectedConfig("resource_7ee824431a13") &&
        Number.isSafeInteger(state.serial) && (applied ? state.serial > 23 : state.serial === 23) && state.resources?.length === 12, "remote bootstrap lineage/serial.");
    const managed = state.resources.filter(item => item.mode === "managed");
    check(isDeepStrictEqual(managed.map(item => `${item.type}.${item.name}`).sort(), addresses) &&
        state.resources.every(item => item.provider === 'provider["registry.terraform.io/hashicorp/aws"]'), "remote bootstrap inventory.");
    const data = state.resources.filter(item => item.mode === "data");
    check(data.length === 1 && data[0].type === "aws_iam_openid_connect_provider" && data[0].name === "github", "OIDC data source.");
    const policy = applied ? developmentHealthProbePermissions() : developmentBucketInspectionPermissions();
    for (const address of ["aws_iam_policy.ci_boundary", "aws_iam_role_policy.ci"]) {
        const item = managed.find(item => `${item.type}.${item.name}` === address);
        check(item.instances?.length === 1 && isDeepStrictEqual(JSON.parse(item.instances[0].attributes.policy), policy), "recorded policy differs.");
    }
    return { lineage: state.lineage, serial: state.serial, managedResources: 11 };
}
export function inspectHealthAccessPlan(plan) {
    check(plan.terraform_version === "1.12.2" && !plan.deferred_changes?.length &&
        isDeepStrictEqual(plan.resource_changes?.map(item => item.address).sort(), addresses), "exact reviewed plan inventory.");
    for (const item of plan.resource_changes)
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" &&
            !item.previous_address && !item.change.importing &&
            (!isDeepStrictEqual(item.change.actions, ["no-op"]) || isDeepStrictEqual(item.change.before, item.change.after)), "provider or unexpected no-op change.");
    return inspectHealthProbeAccess(plan);
}
export function healthAccessArguments(args) {
    if (isDeepStrictEqual(args, ["plan"]))
        return { operation: "plan" };
    if (args.length === 3 && args[0] === "apply" && /^--review=health-access-[A-Za-z0-9]{6}$/.test(args[1]) && /^--plan-sha256=[a-f0-9]{64}$/.test(args[2])) {
        return { operation: "apply", review: args[1].slice(9), planHash: args[2].slice(14) };
    }
    throw new Error("Use health-access plan or its exact saved review/hash. Only the reviewed Development startup-probe permission is allowed.");
}
export async function runHealthProbeAccess(args, dependencies) {
    const request = healthAccessArguments(args);
    const journal = join(BOOTSTRAP_PRIVATE, "health-access-started.json");
    try {
        await lstat(journal);
        throw new Error("Health access was already attempted; inspect remote state and the preserved journal.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    await verifyGitHubActivation(await personalGitHub());
    check(isDeepStrictEqual((await readdir(BOOTSTRAP_DIRECTORY)).filter(name => /\.tf(?:\.json)?$/.test(name)).sort(), ["ci.tf", "state.tf", "versions.tf"]), "unexpected Terraform source file.");
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(BOOTSTRAP_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
    const capture = args => dependencies.executeTerraformCapture(args, env, BOOTSTRAP_DIRECTORY);
    const backend = JSON.parse(resolveProtectedTemplate(await readFile(join(BOOTSTRAP_PRIVATE, "providers/terraform.tfstate")))).backend;
    check(backend?.type === "s3" && backend.config.bucket === "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2" &&
        backend.config.key === "story-video/bootstrap/terraform.tfstate" && backend.config.use_lockfile === true && backend.config.encrypt === true &&
        backend.config.kms_key_id === "arn:aws:kms:ap-southeast-2:" + protectedConfig("awsAccountId") + ":key/" + protectedConfig("stateKmsKeyId") &&
        isDeepStrictEqual(backend.config.allowed_account_ids, [protectedConfig("awsAccountId")]), "remote locked KMS backend required.");
    const remote = await capture(["state", "pull"]), state = inspectHealthAccessState(JSON.parse(remote));
    const sourceHash = await sourceDigest();
    const directory = request.operation === "plan" ? await mkdtemp(join(BOOTSTRAP_PRIVATE, "health-access-")) : join(BOOTSTRAP_PRIVATE, request.review);
    const path = join(directory, "access.tfplan");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "remote-before.tfstate"), remote);
        await privateWrite(join(directory, "plan.txt"), await capture(["plan", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", `-out=${path}`]));
    }
    const raw = await capture(["show", "-json", path]);
    if (request.operation === "plan")
        await privateWrite(join(directory, "plan.json"), raw);
    const inspected = inspectHealthAccessPlan(JSON.parse(raw)), planHash = sha(await readFile(path));
    const review = { sourceHash, planHash, state, ...inspected };
    check(sourceHash === await sourceDigest(), "source changed during review.");
    if (request.operation === "plan") {
        await privateWrite(join(directory, "review.json"), JSON.stringify(review));
        return JSON.stringify({ reviewDirectory: directory, ...review }) + "\n";
    }
    check(request.planHash === planHash && isDeepStrictEqual(JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "review.json")))), review) &&
        isDeepStrictEqual(JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "remote-before.tfstate")))), JSON.parse(remote)), "saved review/source/remote state changed.");
    const snapshots = [];
    for (const name of ["terraform.tfstate", "terraform.tfstate.backup"]) {
        const bytes = await readFile(join(BOOTSTRAP_PRIVATE, name));
        snapshots.push({ name, sha256: sha(bytes) });
    }
    await privateWrite(journal, JSON.stringify({ directory, sourceHash, planHash, snapshots, startedAt: new Date().toISOString() }));
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    check(sourceHash === await sourceDigest() && planHash === sha(await readFile(path)) &&
        isDeepStrictEqual(JSON.parse(await capture(["state", "pull"])), JSON.parse(remote)), "state/source changed before apply.");
    await dependencies.executeTerraform(["apply", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", path], env, BOOTSTRAP_DIRECTORY);
    const after = await capture(["state", "pull"]);
    await privateWrite(join(directory, "remote-after.tfstate"), after);
    const verified = inspectHealthAccessState(JSON.parse(after), true);
    for (const snapshot of snapshots)
        check(sha(await readFile(join(BOOTSTRAP_PRIVATE, snapshot.name))) === snapshot.sha256, "retained original local snapshot changed.");
    const complete = { state: verified, completedAt: new Date().toISOString(), planHash, addedAction: "lambda:InvokeFunction",
        scope: "two existing Development functions", productionAccess: false, oldLocalSnapshotsUnchanged: true };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(complete));
    return JSON.stringify({ evidenceDirectory: directory, ...complete }) + "\n";
}
