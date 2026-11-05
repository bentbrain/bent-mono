import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardedPersonalCall, personalEnvironment, PERSONAL_ACCOUNT, PERSONAL_REGION } from "./aws-personal-guard.mjs";
export const BOOTSTRAP_DIRECTORY = fileURLToPath(new URL("../infra/story-video-development-bootstrap/", import.meta.url));
export const BOOTSTRAP_PRIVATE = fileURLToPath(new URL("../.data/terraform-video-bootstrap/", import.meta.url));
const BUCKET = "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2";
const ROLE = "forever-tee-video-development-ci";
const SUBJECT = "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview";
const OIDC = `arn:aws:iam::${PERSONAL_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
const MANAGED = ["aws_kms_key.state", "aws_kms_alias.state", "aws_s3_bucket.state", "aws_s3_bucket_public_access_block.state",
    "aws_s3_bucket_ownership_controls.state", "aws_s3_bucket_versioning.state", "aws_s3_bucket_server_side_encryption_configuration.state",
    "aws_s3_bucket_policy.state", "aws_iam_policy.ci_boundary", "aws_iam_role.ci", "aws_iam_role_policy.ci"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// Owner reviewed this plan, then explicitly approved its one-time local apply.
// This is not a generic deployment authorization or a caller-supplied receipt.
export const APPROVED_BOOTSTRAP = Object.freeze({
    review: "review-Lo7eUC",
    planSha256: protectedConfig("resource_e33674e069be"),
    sourceSha256: protectedConfig("resource_edffb9f9d833"),
});
export function developmentCIPermissions() {
    const stateKey = "story-video/development/terraform.tfstate";
    const bucket = `arn:aws:s3:::${BUCKET}`;
    const state = `${bucket}/${stateKey}`;
    const lock = `${state}.tflock`;
    const allow = (Sid, Action, Resource, Condition) => ({ Sid, Effect: "Allow", Action, Resource, ...(Condition ? { Condition } : {}) });
    return { Version: "2012-10-17", Statement: [
            allow("ListExactDevelopmentStateAndLock", "s3:ListBucket", bucket, { StringEquals: { "s3:prefix": [stateKey, `${stateKey}.tflock`] } }),
            allow("ReadStateBucketConfiguration", ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:GetBucketPublicAccessBlock"], bucket),
            allow("DevelopmentStateOnly", ["s3:GetObject", "s3:PutObject"], state),
            allow("DevelopmentLockOnly", ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], lock),
            allow("StateEncryptionThroughSydneyS3Only", ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], `arn:aws:kms:${PERSONAL_REGION}:${PERSONAL_ACCOUNT}:key/*`, {
                StringEquals: { "kms:ViaService": `s3.${PERSONAL_REGION}.amazonaws.com`, "kms:CallerAccount": PERSONAL_ACCOUNT,
                    "kms:EncryptionContext:aws:s3:arn": [state, lock] },
                "ForAnyValue:StringEquals": { "kms:ResourceAliases": "alias/forever-tee-video-development-state" },
            }),
            allow("InspectDevelopmentFunctions", ["lambda:GetFunctionConfiguration", "lambda:GetFunctionConcurrency", "lambda:GetFunctionEventInvokeConfig"], ["forever-tee-video-development", "forever-tee-video-development-failures"].map(name => `arn:aws:lambda:${PERSONAL_REGION}:${PERSONAL_ACCOUNT}:function:${name}`)),
            allow("InspectDevelopmentImages", ["ecr:DescribeImages", "ecr:DescribeRepositories"], `arn:aws:ecr:${PERSONAL_REGION}:${PERSONAL_ACCOUNT}:repository/forever-tee-video-development`),
            allow("InspectDevelopmentBuilds", "codebuild:BatchGetBuilds", `arn:aws:codebuild:${PERSONAL_REGION}:${PERSONAL_ACCOUNT}:project/forever-tee-video-development`),
        ] };
}
function canonical(value) {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === "object")
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const policyJSON = value => JSON.stringify(canonical(JSON.parse(value)));
export function verifyBootstrapReview(review, plan, planHash, sourceHash) {
    requirePlan(review.planSha256 === planHash && review.sourceSha256 === sourceHash, "saved plan or source has changed; make a new plan.");
    const inspected = inspectBootstrapPlan(plan);
    for (const [key, value] of Object.entries(inspected)) {
        requirePlan(JSON.stringify(canonical(review[key])) === JSON.stringify(canonical(value)), "saved review does not describe the binary plan.");
    }
    return { ...inspected, createdAt: review.createdAt, planSha256: planHash, sourceSha256: sourceHash };
}
export function bootstrapArguments(args) {
    const [operation, ...options] = args;
    if (["init", "validate", "fmt", "plan"].includes(operation) && options.length === 0)
        return { operation };
    if (["show", "verify"].includes(operation) && options.length === 1 && /^--review=review-[A-Za-z0-9]{6}$/.test(options[0])) {
        return { operation, review: options[0].slice("--review=".length) };
    }
    if (operation === "apply" && options.length === 2 &&
        options[0] === `--review=${APPROVED_BOOTSTRAP.review}` && options[1] === `--plan-sha256=${APPROVED_BOOTSTRAP.planSha256}`) {
        return { operation, ...APPROVED_BOOTSTRAP };
    }
    throw new Error("Bootstrap permits planning/inspection and only the exact owner-approved one-time apply. Overrides are forbidden.");
}
function requirePlan(condition, message) {
    if (!condition)
        throw new Error(`Bootstrap plan rejected: ${message}`);
}
export function inspectBootstrapPlan(plan) {
    requirePlan(plan && plan.errored !== true && Array.isArray(plan.resource_changes), "missing or errored plan.");
    requirePlan(!plan.resource_drift?.length, "resource drift needs operator review.");
    const resources = new Map();
    for (const change of plan.resource_changes) {
        const data = change.mode === "data" && change.address === "data.aws_iam_openid_connect_provider.github";
        requirePlan(change.provider_name === "registry.terraform.io/hashicorp/aws" &&
            (data || (change.mode === "managed" && MANAGED.includes(change.address))), "resource outside bootstrap scope.");
        requirePlan(!change.previous_address && !change.change?.importing, "imports and moves are not bootstrap creation.");
        requirePlan(change.change?.actions?.length === 1 &&
            (data ? ["read", "no-op"] : ["create", "no-op"]).includes(change.change.actions[0]), "updates, replacements or deletions are forbidden.");
        requirePlan(!resources.has(change.address), "duplicate resource.");
        resources.set(change.address, change.change.after);
    }
    requirePlan(MANAGED.every(address => resources.has(address)), "incomplete bootstrap plan.");
    const value = address => resources.get(address);
    const role = value("aws_iam_role.ci");
    const trust = JSON.parse(role.assume_role_policy);
    requirePlan(role.name === ROLE && role.max_session_duration === 3600, "unexpected CI role.");
    requirePlan(Array.isArray(trust.Statement) && trust.Statement.length === 2, "unexpected trust policy.");
    const allow = trust.Statement.find(statement => statement.Sid === "ExactPersonalRepositoryPreview");
    const deny = trust.Statement.find(statement => statement.Sid === "DisabledPendingPreviewProtection");
    requirePlan(allow?.Effect === "Allow" && allow.Action === "sts:AssumeRoleWithWebIdentity" &&
        allow.Principal?.Federated === OIDC && allow.Condition?.StringEquals?.["token.actions.githubusercontent.com:aud"] === "sts.amazonaws.com" &&
        allow.Condition?.StringEquals?.["token.actions.githubusercontent.com:sub"] === SUBJECT, "unexpected OIDC scope.");
    requirePlan(deny?.Effect === "Deny" && deny.Action === "sts:AssumeRoleWithWebIdentity" &&
        deny.Principal?.Federated === OIDC && !deny.Condition, "CI assumption must remain disabled.");
    requirePlan(value("aws_s3_bucket.state").bucket === BUCKET && value("aws_s3_bucket.state").force_destroy === false, "unexpected state bucket.");
    requirePlan(value("aws_s3_bucket_versioning.state").versioning_configuration?.[0]?.status === "Enabled", "state must be versioned.");
    const publicAccess = value("aws_s3_bucket_public_access_block.state");
    requirePlan(["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"].every(key => publicAccess[key] === true), "state must be private.");
    const kms = value("aws_kms_key.state");
    requirePlan(kms.enable_key_rotation === true && kms.deletion_window_in_days === 30 && kms.multi_region === false, "unexpected KMS settings.");
    const rule = value("aws_s3_bucket_server_side_encryption_configuration.state").rule?.[0];
    requirePlan(rule?.bucket_key_enabled === false && rule.apply_server_side_encryption_by_default?.[0]?.sse_algorithm === "aws:kms", "state must use KMS object encryption.");
    const boundary = value("aws_iam_policy.ci_boundary");
    requirePlan(boundary.name === `${ROLE}-boundary` && policyJSON(boundary.policy) === policyJSON(value("aws_iam_role_policy.ci").policy), "CI permissions and boundary must match.");
    requirePlan(policyJSON(boundary.policy) === JSON.stringify(canonical(developmentCIPermissions())), "CI permissions exceed the Development state/inspection scope.");
    const configuredRole = plan.configuration?.root_module?.resources?.find(resource => resource.address === "aws_iam_role.ci");
    requirePlan(configuredRole?.expressions?.permissions_boundary?.references?.includes("aws_iam_policy.ci_boundary.arn"), "CI role must attach the reviewed boundary.");
    requirePlan(plan.planned_values?.outputs?.ci_assumption_enabled?.value === false, "CI activation is out of scope.");
    return {
        accountId: PERSONAL_ACCOUNT, region: PERSONAL_REGION, bucket: BUCKET, ciRole: ROLE, ciEnabled: false,
        changes: plan.resource_changes.map(change => ({ address: change.address, action: change.change.actions[0] })),
        policies: { trust, permissions: JSON.parse(boundary.policy), kms: JSON.parse(kms.policy) },
        // The KMS ARN and therefore the complete bucket policy resolve on creation.
        // Its exact template is reviewed in state.tf alongside this saved plan.
        bucketPolicyTemplate: "infra/story-video-development-bootstrap/state.tf",
        requiresHumanReview: true,
    };
}
export async function sourceDigest() {
    const paths = ["versions.tf", "state.tf", "ci.tf", ".terraform.lock.hcl", "development-release-policy.json"];
    const files = [];
    for (const path of paths)
        files.push([path, sha256(await readFile(join(BOOTSTRAP_DIRECTORY, path)))]);
    return sha256(JSON.stringify(files));
}
export async function runPersonalBootstrap(args, dependencies) {
    if (args[0] === "repository-trust") {
        const { runRepositoryTrust } = await import("./aws-personal-repository-trust.mjs");
        return runRepositoryTrust(args.slice(1), dependencies);
    }
    if (args[0] === "production-candidate-access") {
        const { runProductionCandidateAccess } = await import("./aws-personal-production-candidate-access.mjs");
        return runProductionCandidateAccess(args.slice(1), dependencies);
    }
    if (args[0] === "production-runtime-access") {
        const { runProductionRuntimeAccess } = await import("./aws-personal-production-runtime-access.mjs");
        return runProductionRuntimeAccess(args.slice(1), dependencies);
    }
    if (args[0] === "production-alert-access") {
        const { runProductionAlertAccess } = await import("./aws-personal-production-alert-access.mjs");
        return runProductionAlertAccess(args.slice(1), dependencies);
    }
    if (args[0] === "production-foundation") {
        const { runProductionBootstrap } = await import("./aws-personal-production-bootstrap.mjs");
        return runProductionBootstrap(args.slice(1), dependencies);
    }
    if (args[0] === "health-access") {
        const { runHealthProbeAccess } = await import("./aws-personal-health-access.mjs");
        return runHealthProbeAccess(args.slice(1), dependencies);
    }
    if (args[0] === "migrate-state") {
        const { runBootstrapStateMigration } = await import("./aws-personal-bootstrap-migration.mjs");
        return runBootstrapStateMigration(args.slice(1), dependencies);
    }
    if (args[0] === "bucket-access") {
        const { runDevelopmentBucketAccess } = await import("./aws-personal-release-access.mjs");
        return runDevelopmentBucketAccess(args.slice(1), dependencies);
    }
    if (args[0] === "refresh-access") {
        const { runDevelopmentRefreshAccess } = await import("./aws-personal-release-access.mjs");
        return runDevelopmentRefreshAccess(args.slice(1), dependencies);
    }
    if (args[0] === "release-access") {
        const { runDevelopmentReleaseAccess } = await import("./aws-personal-release-access.mjs");
        return runDevelopmentReleaseAccess(args.slice(1), dependencies);
    }
    if (args[0] === "activate-ci") {
        const { runCIActivation } = await import("./aws-personal-ci-activation.mjs");
        return runCIActivation(args.slice(1), dependencies);
    }
    const request = bootstrapArguments(args);
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(BOOTSTRAP_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
    await mkdir(BOOTSTRAP_PRIVATE, { recursive: true, mode: 0o700 });
    await chmod(BOOTSTRAP_PRIVATE, 0o700);
    const execute = args => dependencies.executeTerraform(args, env, BOOTSTRAP_DIRECTORY);
    if (request.operation === "apply") {
        const { applyApprovedBootstrap } = await import("./aws-personal-bootstrap-apply.mjs");
        return applyApprovedBootstrap({ dependencies, env, sourceDigest });
    }
    if (request.operation === "verify") {
        // Readback only. This cannot authorize an apply or alter the creation gate.
        const { verifyBootstrapReadback } = await import("./aws-personal-bootstrap-verification.mjs");
        const path = join(BOOTSTRAP_PRIVATE, request.review, "bootstrap.tfplan");
        requirePlan(await sourceDigest() === APPROVED_BOOTSTRAP.sourceSha256, "bootstrap source changed since approval.");
        const raw = await dependencies.executeTerraformCapture(["show", "-json", path], env, BOOTSTRAP_DIRECTORY);
        return JSON.stringify({ ...verifyBootstrapReadback(JSON.parse(raw)), planSha256: sha256(await readFile(path)) }, null, 2) + "\n";
    }
    if (request.operation === "init")
        return execute(["init", "-input=false"]);
    if (request.operation === "validate")
        return execute(["validate"]);
    if (request.operation === "fmt")
        return execute(["fmt", "-check", "-diff"]);
    if (request.operation === "show") {
        const directory = join(BOOTSTRAP_PRIVATE, request.review);
        const review = JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "review.json"), "utf8")));
        requirePlan(review.planSha256 === sha256(await readFile(join(directory, "bootstrap.tfplan"))) &&
            review.sourceSha256 === await sourceDigest(), "saved plan or source has changed; make a new plan.");
        // Re-extract from the binary. A hand-edited review is not plan evidence.
        const raw = await dependencies.executeTerraformCapture(["show", "-json", join(directory, "bootstrap.tfplan")], env, BOOTSTRAP_DIRECTORY);
        const verified = verifyBootstrapReview(review, JSON.parse(raw), sha256(await readFile(join(directory, "bootstrap.tfplan"))), await sourceDigest());
        return JSON.stringify(verified, null, 2) + "\n";
    }
    const directory = await mkdtemp(join(BOOTSTRAP_PRIVATE, "review-"));
    const path = join(directory, "bootstrap.tfplan");
    const sourceSha256 = await sourceDigest();
    const planText = await dependencies.executeTerraformCapture(["plan", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", `-out=${path}`], env, BOOTSTRAP_DIRECTORY);
    await writeFile(join(directory, "plan.txt"), planText, { flag: "wx", mode: 0o600 });
    requirePlan(sourceSha256 === await sourceDigest(), "source changed while planning.");
    const raw = await dependencies.executeTerraformCapture(["show", "-json", path], env, BOOTSTRAP_DIRECTORY);
    // Keep full plan JSON private even if a later module accidentally adds secrets.
    await writeFile(join(directory, "plan.json"), raw, { flag: "wx", mode: 0o600 });
    const review = { ...inspectBootstrapPlan(JSON.parse(raw)), createdAt: new Date().toISOString(),
        planSha256: sha256(await readFile(path)), sourceSha256 };
    await writeFile(join(directory, "review.json"), JSON.stringify(review, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return JSON.stringify({ reviewDirectory: directory, planSha256: review.planSha256,
        resources: review.changes, ciEnabled: false, requiresHumanReview: true }, null, 2) + "\n";
}
