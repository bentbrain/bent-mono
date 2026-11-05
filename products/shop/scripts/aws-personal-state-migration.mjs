import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, lstat } from "node:fs/promises";
import { join } from "node:path";
import { TERRAFORM_DIRECTORY, TERRAFORM_PRIVATE } from "./aws-personal-terraform.mjs";
import { guardedPersonalCall, personalEnvironment, PERSONAL_ACCOUNT } from "./aws-personal-guard.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
const BUCKET = "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2";
const KEY = "story-video/development/terraform.tfstate";
const KMS = "arn:aws:kms:ap-southeast-2:" + protectedConfig("awsAccountId") + ":key/" + protectedConfig("stateKmsKeyId");
const STATE = join(TERRAFORM_PRIVATE, "terraform.tfstate");
const BACKEND = join(TERRAFORM_PRIVATE, "providers/terraform.tfstate");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const check = (condition, message) => {
    if (!condition)
        throw new Error(`State migration stopped: ${message}`);
};
const bucketArgs = ["--bucket", BUCKET, "--expected-bucket-owner", PERSONAL_ACCOUNT];
export function inspectMigrationState(state) {
    check(state?.version === 4 && state.lineage === protectedConfig("resource_7a26fb703a23") && state.serial === 28 &&
        state.resources?.length === 25, "expected Development lineage, serial and resource count required.");
    check(state.resources.every(resource => resource.mode === "managed" && resource.provider === 'provider["registry.terraform.io/hashicorp/aws"]'), "unexpected resource provider or data source.");
    return { lineage: state.lineage, serial: state.serial, resources: state.resources.length };
}
export async function requireEmptyDestination(call) {
    for (const key of [KEY, `${KEY}.tflock`]) {
        try {
            await call(["s3api", "head-object", ...bucketArgs, "--key", key]);
        }
        catch (error) {
            if (typeof error.stderr === "string" && /\(404\) when calling the HeadObject operation/.test(error.stderr))
                continue;
            throw new Error("State destination absence could not be verified. No copy attempted.");
        }
        throw new Error("Remote state or lock already exists. Overwrite, force-unlock and automatic recovery are forbidden.");
    }
}
export function migrationArguments(args) {
    // Explicit task-reviewed recovery from the old CLI rejecting the option
    // before sending any S3 request. The original journal/evidence stays intact.
    if (equal(args, ["resume-cli-rejection", "--review=migration-ZKdVgY", "--review-sha256=" + protectedConfig("resource_5d7c568077cc")])) {
        return { operation: "resume", review: "migration-ZKdVgY", hash: protectedConfig("resource_5d7c568077cc") };
    }
    if (equal(args, ["plan"]))
        return { operation: "plan" };
    if (args.length === 3 && args[0] === "apply" && /^--review=migration-[A-Za-z0-9]{6}$/.test(args[1]) && /^--review-sha256=[a-f0-9]{64}$/.test(args[2])) {
        return { operation: "apply", review: args[1].slice(9), hash: args[2].slice(16) };
    }
    throw new Error("Use migrate-state plan, then apply its exact review/hash. Backend and state overrides are forbidden.");
}
async function optionalBytes(path) {
    try {
        check((await lstat(path)).isFile(), "state/backup must be an ordinary file.");
        return await readFile(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
export async function runStateMigration(args, dependencies) {
    const request = migrationArguments(args);
    const call = args => guardedPersonalCall(args, dependencies);
    await call(["sts", "get-caller-identity"]);
    const originalJournal = await optionalBytes(join(TERRAFORM_PRIVATE, "migration-started.json"));
    if (request.operation === "resume") {
        check(originalJournal && JSON.parse(originalJournal).reviewSha256 === request.hash &&
            JSON.parse(originalJournal).directory === join(TERRAFORM_PRIVATE, request.review) &&
            !(await optionalBytes(join(TERRAFORM_PRIVATE, "migration-resume-started.json"))) &&
            !(await optionalBytes(join(TERRAFORM_PRIVATE, request.review, "copy-acknowledged.json"))), "recovery evidence differs or recovery already attempted.");
    }
    else
        check(!originalJournal, "migration already attempted; inspect private evidence and remote state.");
    const local = await readFile(STATE);
    const inspected = inspectMigrationState(JSON.parse(local));
    const metadata = JSON.parse(resolveProtectedTemplate(await readFile(BACKEND)));
    check(metadata.backend?.type === "local" && metadata.backend.config.path === "../../.data/terraform-story-video/terraform.tfstate", "local backend mismatch.");
    const versioning = JSON.parse(await call(["s3api", "get-bucket-versioning", ...bucketArgs]));
    const encryption = JSON.parse(await call(["s3api", "get-bucket-encryption", ...bucketArgs]));
    const access = JSON.parse(await call(["s3api", "get-public-access-block", ...bucketArgs]));
    const rules = encryption.ServerSideEncryptionConfiguration?.Rules;
    check(versioning.Status === "Enabled" && rules?.length === 1 && rules[0].BucketKeyEnabled === false &&
        rules[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "aws:kms" && rules[0].ApplyServerSideEncryptionByDefault?.KMSMasterKeyID === KMS &&
        ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every(key => access.PublicAccessBlockConfiguration?.[key] === true), "storage security differs from the reviewed backend.");
    await requireEmptyDestination(call);
    const files = ["versions.tf", "main.tf", "failure-delivery.tf", "outputs.tf", ".terraform.lock.hcl"];
    const sourceHashes = await Promise.all(files.map(async (file) => [file, sha(await readFile(join(TERRAFORM_DIRECTORY, file)))]));
    const snapshots = [];
    for (const path of [STATE, `${STATE}.backup`, BACKEND]) {
        const bytes = await optionalBytes(path);
        snapshots.push({ path, sha256: bytes ? sha(bytes) : null });
    }
    const directory = request.operation === "plan" ? await mkdtemp(join(TERRAFORM_PRIVATE, "migration-")) : join(TERRAFORM_PRIVATE, request.review);
    const review = { ...inspected, accountId: PERSONAL_ACCOUNT, bucket: BUCKET, key: KEY, kmsKey: KMS, sourceHashes, snapshots,
        operation: "conditional-create-then-reconfigure", resourceMutations: false };
    if (request.operation === "plan") {
        await privateWrite(join(directory, "review.json"), JSON.stringify(review));
        return JSON.stringify({ reviewDirectory: directory, reviewSha256: sha(await readFile(join(directory, "review.json"))), ...inspected,
            destinationAbsent: true, lockAbsent: true, resourceMutations: false }) + "\n";
    }
    const reviewBytes = await readFile(join(directory, "review.json"));
    check(sha(reviewBytes) === request.hash && equal(JSON.parse(reviewBytes), review), "review or source/state changed.");
    for (const [index, snapshot] of snapshots.entries()) {
        const bytes = await optionalBytes(snapshot.path);
        check((bytes ? sha(bytes) : null) === snapshot.sha256, "state changed during preflight.");
        if (bytes) {
            const target = join(directory, ["renderer-before.tfstate", "renderer-backup-before.tfstate", "backend-before.json"][index]);
            if (request.operation === "resume")
                check(sha(await readFile(target)) === sha(bytes), "original preserved snapshot differs.");
            else
                await privateWrite(target, bytes);
        }
    }
    await privateWrite(join(TERRAFORM_PRIVATE, request.operation === "resume" ? "migration-resume-started.json" : "migration-started.json"), JSON.stringify({ directory, reviewSha256: request.hash, startedAt: new Date().toISOString(), recovery: request.operation === "resume" }));
    // An S3 conditional create closes the destination race without -force-copy,
    // state push, overwriting an existing object or modifying the old backend.
    await requireEmptyDestination(call);
    const result = JSON.parse(await call(["s3api", "put-object", ...bucketArgs, "--key", KEY, "--if-none-match", "*",
        "--server-side-encryption", "aws:kms", "--ssekms-key-id", KMS, "--body", join(directory, "renderer-before.tfstate"),
        "--content-md5", createHash("md5").update(local).digest("base64")]));
    check(result.ServerSideEncryption === "aws:kms" && result.SSEKMSKeyId === KMS && result.VersionId && result.VersionId !== "null", "copy acknowledgement needs investigation.");
    await privateWrite(join(directory, "copy-acknowledged.json"), JSON.stringify({ versionId: result.VersionId, stateSha256: sha(local) }));
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(TERRAFORM_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
    const capture = args => dependencies.executeTerraformCapture(args, env, TERRAFORM_DIRECTORY);
    const init = await capture(["init", "-reconfigure", "-input=false", "-lockfile=readonly"]);
    await privateWrite(join(directory, "init.txt"), init);
    const active = JSON.parse(resolveProtectedTemplate(await readFile(BACKEND))).backend;
    check(active?.type === "s3" && active.config.bucket === BUCKET && active.config.key === KEY && active.config.kms_key_id === KMS &&
        active.config.use_lockfile === true && active.config.encrypt === true && equal(active.config.allowed_account_ids, [PERSONAL_ACCOUNT]), "initialized backend differs.");
    const pulled = await capture(["state", "pull"]);
    await privateWrite(join(directory, "remote-after.tfstate"), pulled);
    check(equal(JSON.parse(pulled), JSON.parse(local)), "remote state content does not exactly match the original.");
    for (const snapshot of snapshots.slice(0, 2)) {
        const bytes = await optionalBytes(snapshot.path);
        check((bytes ? sha(bytes) : null) === snapshot.sha256, "original state/backup changed.");
    }
    const complete = { ...inspected, completedAt: new Date().toISOString(), remoteStateVerified: true,
        versionId: result.VersionId, originalStateAndBackupUnchanged: true, resourceMutations: false };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(complete));
    return JSON.stringify({ evidenceDirectory: directory, ...complete }) + "\n";
}
