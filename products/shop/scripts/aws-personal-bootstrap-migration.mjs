import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, lstat } from "node:fs/promises";
import { readRegularFile } from "./read-regular-file.mjs";
import { join } from "node:path";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE, sourceDigest } from "./aws-personal-bootstrap.mjs";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
const BUCKET = "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2", KEY = "story-video/bootstrap/terraform.tfstate";
const KMS = "arn:aws:kms:ap-southeast-2:" + protectedConfig("awsAccountId") + ":key/" + protectedConfig("stateKmsKeyId");
const STATE = join(BOOTSTRAP_PRIVATE, "terraform.tfstate"), BACKEND = join(BOOTSTRAP_PRIVATE, "providers/terraform.tfstate");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const check = (value, reason) => {
    if (!value)
        throw new Error(`Bootstrap migration stopped: ${reason}`);
};
const bucketArgs = ["--bucket", BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId")];
export function inspectBootstrapMigrationState(state) {
    const managed = ["aws_iam_policy.ci_boundary", "aws_iam_role.ci", "aws_iam_role_policy.ci", "aws_kms_alias.state", "aws_kms_key.state",
        "aws_s3_bucket.state", "aws_s3_bucket_ownership_controls.state", "aws_s3_bucket_policy.state", "aws_s3_bucket_public_access_block.state",
        "aws_s3_bucket_server_side_encryption_configuration.state", "aws_s3_bucket_versioning.state"].sort();
    check(state.version === 4 && state.lineage === protectedConfig("resource_7ee824431a13") && state.serial === 23 && state.resources?.length === 12, "exact bootstrap lineage, serial and inventory required.");
    check(equal(state.resources.filter(item => item.mode === "managed").map(item => `${item.type}.${item.name}`).sort(), managed) &&
        state.resources.every(item => item.provider === 'provider["registry.terraform.io/hashicorp/aws"]') &&
        state.resources.filter(item => item.mode === "data").length === 1 &&
        state.resources.filter(item => item.mode === "data").every(item => item.type === "aws_iam_openid_connect_provider" && item.name === "github"), "resource identity.");
    return { lineage: state.lineage, serial: state.serial, managedResources: 11, dataSources: 1 };
}
export function bootstrapMigrationArguments(args) {
    if (equal(args, ["plan"]))
        return { operation: "plan" };
    if (args.length === 3 && args[0] === "apply" && /^--review=bootstrap-migration-[A-Za-z0-9]{6}$/.test(args[1]) && /^--review-sha256=[a-f0-9]{64}$/.test(args[2])) {
        return { operation: "apply", review: args[1].slice(9), hash: args[2].slice(16) };
    }
    throw new Error("Use the exact bootstrap migrate-state plan or saved review/hash; no backend overrides or retries.");
}
async function requireAbsent(call) {
    for (const key of [KEY, `${KEY}.tflock`]) {
        try {
            await call(["s3api", "head-object", ...bucketArgs, "--key", key]);
        }
        catch (error) {
            if (typeof error.stderr === "string" && /\(404\) when calling the HeadObject operation/.test(error.stderr))
                continue;
            throw new Error("Bootstrap state/lock absence could not be confirmed.");
        }
        throw new Error("Bootstrap remote state/lock exists; it will not be overwritten.");
    }
}
export async function runBootstrapStateMigration(args, dependencies) {
    const request = bootstrapMigrationArguments(args), call = args => guardedPersonalCall(args, dependencies);
    await call(["sts", "get-caller-identity"]);
    const journal = join(BOOTSTRAP_PRIVATE, "bootstrap-migration-started.json");
    try {
        await lstat(journal);
        throw new Error("Bootstrap migration already attempted; inspect private and remote evidence.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const local = await readFile(STATE), inspected = inspectBootstrapMigrationState(JSON.parse(local));
    check(sha(local) === sha(await readFile(join(BOOTSTRAP_PRIVATE, "bucket-access-lhdajU/bootstrap-after.tfstate"))), "state differs from the last reviewed apply snapshot.");
    const metadata = JSON.parse(resolveProtectedTemplate(await readFile(BACKEND)));
    check(metadata.backend?.type === "local" && metadata.backend.config.path === "../../.data/terraform-video-bootstrap/terraform.tfstate", "original local backend.");
    const versioning = JSON.parse(await call(["s3api", "get-bucket-versioning", ...bucketArgs]));
    const encryption = JSON.parse(await call(["s3api", "get-bucket-encryption", ...bucketArgs]));
    const access = JSON.parse(await call(["s3api", "get-public-access-block", ...bucketArgs]));
    const rules = encryption.ServerSideEncryptionConfiguration?.Rules;
    check(versioning.Status === "Enabled" && rules?.length === 1 && rules[0].BucketKeyEnabled === false &&
        rules[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "aws:kms" && rules[0].ApplyServerSideEncryptionByDefault?.KMSMasterKeyID === KMS &&
        ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every(key => access.PublicAccessBlockConfiguration?.[key] === true), "reviewed storage protections.");
    await requireAbsent(call);
    const sourceHash = await sourceDigest();
    const snapshots = [];
    for (const path of [STATE, `${STATE}.backup`, BACKEND]) {
        snapshots.push({ path, sha256: sha(await readRegularFile(path)) });
    }
    const review = { ...inspected, sourceHash, snapshots, accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2", bucket: BUCKET, key: KEY, kmsKey: KMS,
        conditionalCreate: true, resourceMutations: false, developmentCIHasAccess: false };
    const directory = request.operation === "plan" ? await mkdtemp(join(BOOTSTRAP_PRIVATE, "bootstrap-migration-")) : join(BOOTSTRAP_PRIVATE, request.review);
    if (request.operation === "plan") {
        await privateWrite(join(directory, "review.json"), JSON.stringify(review));
        return JSON.stringify({ reviewDirectory: directory, reviewSha256: sha(await readFile(join(directory, "review.json"))), ...review }) + "\n";
    }
    const recorded = await readFile(join(directory, "review.json"));
    check(sha(recorded) === request.hash && equal(JSON.parse(recorded), review), "review, source or original state changed.");
    for (const [index, snapshot] of snapshots.entries()) {
        await privateWrite(join(directory, ["bootstrap-before.tfstate", "bootstrap-backup-before.tfstate", "backend-before.json"][index]), await readFile(snapshot.path));
    }
    await privateWrite(journal, JSON.stringify({ directory, reviewSha256: request.hash, startedAt: new Date().toISOString() }));
    await requireAbsent(call);
    check(sourceHash === await sourceDigest(), "source changed before copy.");
    for (const snapshot of snapshots)
        check(sha(await readFile(snapshot.path)) === snapshot.sha256, "state changed before copy.");
    const result = JSON.parse(await call(["s3api", "put-object", ...bucketArgs, "--key", KEY, "--if-none-match", "*", "--server-side-encryption", "aws:kms",
        "--ssekms-key-id", KMS, "--body", join(directory, "bootstrap-before.tfstate"), "--content-md5", createHash("md5").update(local).digest("base64")]));
    check(result.ServerSideEncryption === "aws:kms" && result.SSEKMSKeyId === KMS && result.VersionId && result.VersionId !== "null", "copy acknowledgement uncertain.");
    await privateWrite(join(directory, "copy-acknowledged.json"), JSON.stringify({ versionId: result.VersionId, sha256: sha(local) }));
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(BOOTSTRAP_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
    const capture = args => dependencies.executeTerraformCapture(args, env, BOOTSTRAP_DIRECTORY);
    await privateWrite(join(directory, "init.txt"), await capture(["init", "-reconfigure", "-input=false", "-lockfile=readonly"]));
    const active = JSON.parse(resolveProtectedTemplate(await readFile(BACKEND))).backend;
    check(active?.type === "s3" && active.config.bucket === BUCKET && active.config.key === KEY && active.config.kms_key_id === KMS &&
        active.config.use_lockfile === true && active.config.encrypt === true && equal(active.config.allowed_account_ids, [protectedConfig("awsAccountId")]), "reconfigured backend identity.");
    const remote = await capture(["state", "pull"]);
    await privateWrite(join(directory, "remote-after.tfstate"), remote);
    check(equal(JSON.parse(remote), JSON.parse(local)), "remote state differs from original.");
    for (const snapshot of snapshots.slice(0, 2))
        check(sha(await readFile(snapshot.path)) === snapshot.sha256, "original state/backup changed.");
    const complete = { ...inspected, completedAt: new Date().toISOString(), remoteStateVerified: true, originalBackupsUnchanged: true,
        versionId: result.VersionId, resourceMutations: false, developmentCIHasAccess: false };
    await privateWrite(join(directory, "complete.json"), JSON.stringify(complete));
    return JSON.stringify({ evidenceDirectory: directory, ...complete }) + "\n";
}
