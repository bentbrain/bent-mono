import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, lstat } from "node:fs/promises";
import { join } from "node:path";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE, developmentCIPermissions, sourceDigest } from "./aws-personal-bootstrap.mjs";
import { developmentReleasePermissions, developmentRefreshPermissions, developmentBucketInspectionPermissions, developmentHealthProbePermissions } from "./native-development-permissions.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { verifyGitHubActivation } from "./aws-personal-ci-activation.mjs";
import { personalGitHub } from "./github-personal.mjs";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hash = value => createHash("sha256").update(value).digest("hex");
const check = condition => {
    if (!condition)
        throw new Error("Release access plan differs from the exact Development permissions update.");
};
const STATE = join(BOOTSTRAP_PRIVATE, "terraform.tfstate");
export function inspectReleaseAccess(plan) {
    check(plan?.complete === true && plan.applyable === true && plan.errored !== true && !plan.resource_drift?.length);
    check(plan.resource_changes.length === 11 && Object.values(plan.output_changes).every(change => equal(change.actions, ["no-op"])));
    const changed = plan.resource_changes.filter(resource => !equal(resource.change.actions, ["no-op"]));
    check(equal(changed.map(resource => resource.address).sort(), ["aws_iam_policy.ci_boundary", "aws_iam_role_policy.ci"]));
    const beforePolicy = developmentCIPermissions(), afterPolicy = developmentReleasePermissions();
    check(JSON.stringify(afterPolicy).length <= 6144);
    for (const resource of changed) {
        check(resource.mode === "managed" && resource.provider_name === "registry.terraform.io/hashicorp/aws" &&
            !resource.previous_address && !resource.change.importing && equal(resource.change.actions, ["update"]));
        const { before, after } = resource.change;
        check(equal(JSON.parse(before.policy), beforePolicy) && equal(JSON.parse(after.policy), afterPolicy));
        const restored = { ...after, policy: before.policy };
        if (resource.address === "aws_iam_policy.ci_boundary") {
            check(after.name === "forever-tee-video-development-ci-boundary");
        }
        else
            check(after.name === "development-state-and-inspection" && after.role === "forever-tee-video-development-ci");
        check(equal(before, restored));
    }
    const role = plan.resource_changes.find(resource => resource.address === "aws_iam_role.ci").change.after;
    const trust = JSON.parse(role.assume_role_policy);
    check(role.permissions_boundary === "arn:aws:iam::" + protectedConfig("awsAccountId") + ":policy/forever-tee-video-development-ci-boundary" &&
        equal(trust, { Version: "2012-10-17", Statement: [{ Sid: "ExactPersonalRepositoryPreview", Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity",
                    Principal: { Federated: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":oidc-provider/token.actions.githubusercontent.com" },
                    Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                            "token.actions.githubusercontent.com:sub": "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview" } } }] }));
    return { changes: changed.map(resource => resource.address), permissions: afterPolicy,
        accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", productionAccess: false, iamWrites: false };
}
export function inspectRefreshAccess(plan) {
    return { ...inspectExactPolicyUpdate(plan, developmentReleasePermissions(), developmentRefreshPermissions(), developmentCIPermissions()),
        addedAction: "lambda:ListVersionsByFunction", scope: "two existing Development functions" };
}
export function inspectBucketAccess(plan) {
    return { ...inspectExactPolicyUpdate(plan, developmentRefreshPermissions(), developmentBucketInspectionPermissions(), developmentReleasePermissions()),
        addedActions: ["s3:ListBucket", "s3:GetBucketRequestPayment", "s3:GetBucketLogging"], scope: "existing Development source bucket only" };
}
export function inspectHealthProbeAccess(plan) {
    return { ...inspectExactPolicyUpdate(plan, developmentBucketInspectionPermissions(), developmentHealthProbePermissions(), developmentRefreshPermissions()),
        addedAction: "lambda:InvokeFunction", scope: "two existing Development functions only" };
}
function inspectExactPolicyUpdate(plan, previous, next, observedBefore) {
    check(JSON.stringify(next).length <= 6144);
    const review = structuredClone(plan);
    const observations = [];
    if (review.resource_drift?.length) {
        // The earlier child-policy apply changed the role's read-only inline_policy
        // observation. Accept only that exact already-applied policy, never arbitrary drift.
        check(review.resource_drift.length === 1);
        const drift = review.resource_drift[0];
        check(drift.address === "aws_iam_role.ci" && drift.mode === "managed" &&
            drift.provider_name === "registry.terraform.io/hashicorp/aws" && equal(drift.change.actions, ["update"]));
        const { before, after } = drift.change;
        check(before.inline_policy?.length === 1 && after.inline_policy?.length === 1 &&
            before.inline_policy[0].name === "development-state-and-inspection" && after.inline_policy[0].name === before.inline_policy[0].name &&
            equal(JSON.parse(before.inline_policy[0].policy), observedBefore) && equal(JSON.parse(after.inline_policy[0].policy), previous) &&
            equal({ ...after, inline_policy: before.inline_policy }, before));
        const role = review.resource_changes.find(resource => resource.address === "aws_iam_role.ci");
        check(equal(role.change.actions, ["no-op"]) && equal(role.change.after, after));
        observations.push("role inline-policy observation matches the previously applied child policy; role remains no-op");
        review.resource_drift = [];
    }
    for (const resource of review.resource_changes) {
        if (!["aws_iam_policy.ci_boundary", "aws_iam_role_policy.ci"].includes(resource.address))
            continue;
        check(equal(JSON.parse(resource.change.before.policy), previous) && equal(JSON.parse(resource.change.after.policy), next));
        resource.change.before.policy = JSON.stringify(developmentCIPermissions());
        resource.change.after.policy = JSON.stringify(developmentReleasePermissions());
    }
    const inspected = inspectReleaseAccess(review);
    return { ...inspected, permissions: next, observations };
}
export function releaseAccessArguments(args, kind = "release-access") {
    check(["release-access", "refresh-access", "bucket-access"].includes(kind));
    if (equal(args, ["plan"]))
        return { operation: "plan" };
    if (args.length === 2 && args[0] === "show" && new RegExp(`^--review=${kind}-[A-Za-z0-9]{6}$`).test(args[1])) {
        return { operation: "show", review: args[1].slice(9) };
    }
    if (args.length === 3 && args[0] === "apply" && new RegExp(`^--review=${kind}-[A-Za-z0-9]{6}$`).test(args[1]) && /^--plan-sha256=[0-9a-f]{64}$/.test(args[2])) {
        return { operation: "apply", review: args[1].slice(9), hash: args[2].slice(14) };
    }
    throw new Error("Use release-access plan or apply its exact review/hash. Other targets and overrides are forbidden.");
}
export async function runDevelopmentReleaseAccess(args, dependencies) {
    return runDevelopmentPolicyUpdate("release-access", args, dependencies);
}
export async function runDevelopmentRefreshAccess(args, dependencies) {
    return runDevelopmentPolicyUpdate("refresh-access", args, dependencies);
}
export async function runDevelopmentBucketAccess(args, dependencies) {
    return runDevelopmentPolicyUpdate("bucket-access", args, dependencies);
}
async function runDevelopmentPolicyUpdate(kind, args, dependencies) {
    const request = releaseAccessArguments(args, kind);
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    await verifyGitHubActivation(await personalGitHub());
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(BOOTSTRAP_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
    const capture = args => dependencies.executeTerraformCapture(args, env, BOOTSTRAP_DIRECTORY);
    const directory = request.operation === "plan" ? await mkdtemp(join(BOOTSTRAP_PRIVATE, `${kind}-`)) : join(BOOTSTRAP_PRIVATE, request.review);
    const path = join(directory, "access.tfplan"), sourceHash = await sourceDigest();
    if (request.operation === "plan") {
        await privateWrite(join(directory, "plan.txt"), await capture(["plan", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", `-out=${path}`]));
    }
    const raw = await capture(["show", "-json", path]);
    if (request.operation === "show") {
        await privateWrite(join(directory, "diagnostic-plan.json"), raw);
        const plan = JSON.parse(raw);
        const summarize = item => ({ address: item.address, mode: item.mode, actions: item.change.actions,
            fields: Object.keys(item.change.after ?? {}).filter(key => !equal(item.change.before?.[key], item.change.after[key])) });
        return JSON.stringify({ complete: plan.complete, applyable: plan.applyable, errored: plan.errored,
            drift: plan.resource_drift?.map(summarize), resources: plan.resource_changes.map(summarize),
            outputs: Object.fromEntries(Object.entries(plan.output_changes ?? {}).map(([name, value]) => [name, value.actions])),
            privatePlan: join(directory, "diagnostic-plan.json") }) + "\n";
    }
    const inspect = { "refresh-access": inspectRefreshAccess, "bucket-access": inspectBucketAccess, "release-access": inspectReleaseAccess }[kind];
    const inspected = inspect(JSON.parse(raw));
    check(sourceHash === await sourceDigest());
    const planHash = hash(await readFile(path));
    if (request.operation === "plan") {
        await privateWrite(join(directory, "plan.json"), raw);
        await privateWrite(join(directory, "review.json"), JSON.stringify({ sourceHash, planHash, ...inspected }));
        return JSON.stringify({ reviewDirectory: directory, sourceHash, planHash, changes: inspected.changes, iamWrites: false, productionAccess: false }) + "\n";
    }
    const review = JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "review.json"))));
    check(review.sourceHash === sourceHash && review.planHash === planHash && request.hash === planHash);
    const journal = join(BOOTSTRAP_PRIVATE, `${kind}-started.json`);
    try {
        await lstat(journal);
        throw new Error("Release access already attempted. Inspect state before recovery.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const snapshots = [];
    for (const suffix of ["", ".backup"]) {
        const bytes = await readFile(`${STATE}${suffix}`);
        await privateWrite(join(directory, `bootstrap-before.tfstate${suffix}`), bytes);
        snapshots.push({ path: `${STATE}${suffix}`, hash: hash(bytes) });
    }
    await privateWrite(journal, JSON.stringify({ directory, planHash, sourceHash, snapshots, startedAt: new Date().toISOString() }));
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    check(sourceHash === await sourceDigest() && planHash === hash(await readFile(path)));
    for (const snapshot of snapshots)
        check(hash(await readFile(snapshot.path)) === snapshot.hash);
    await dependencies.executeTerraform(["apply", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", path], env, BOOTSTRAP_DIRECTORY);
    await privateWrite(join(directory, "bootstrap-after.tfstate"), await readFile(STATE));
    const result = { status: "applied", completedAt: new Date().toISOString(), planHash, changes: inspected.changes, iamWrites: false, productionAccess: false };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(result));
    return JSON.stringify({ evidenceDirectory: directory, ...result }) + "\n";
}
