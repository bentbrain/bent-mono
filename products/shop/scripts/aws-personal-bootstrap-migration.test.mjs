import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapMigrationArguments, inspectBootstrapMigrationState } from "./aws-personal-bootstrap-migration.mjs";
import { validatePersonalArguments } from "./aws-personal-guard.mjs";
test("bootstrap migration accepts only its recorded lineage/serial/inventory and fixed review arguments", () => {
    const names = ["aws_iam_policy.ci_boundary", "aws_iam_role.ci", "aws_iam_role_policy.ci", "aws_kms_alias.state", "aws_kms_key.state",
        "aws_s3_bucket.state", "aws_s3_bucket_ownership_controls.state", "aws_s3_bucket_policy.state", "aws_s3_bucket_public_access_block.state",
        "aws_s3_bucket_server_side_encryption_configuration.state", "aws_s3_bucket_versioning.state"];
    const state = { version: 4, lineage: protectedConfig("resource_7ee824431a13"), serial: 23,
        resources: [...names.map(name => { const [type, key] = name.split("."); return { mode: "managed", type, name: key }; }),
            { mode: "data", type: "aws_iam_openid_connect_provider", name: "github" }].map(item => ({ ...item, provider: 'provider["registry.terraform.io/hashicorp/aws"]' })) };
    assert.equal(inspectBootstrapMigrationState(state).managedResources, 11);
    for (const change of [s => { s.serial++; }, s => { s.lineage = "workload"; }, s => { s.resources.pop(); },
        s => { s.resources[0].name = "foreign"; }, s => { s.resources.at(-1).mode = "unknown"; }]) {
        const altered = structuredClone(state);
        change(altered);
        assert.throws(() => inspectBootstrapMigrationState(altered));
    }
    assert.equal(bootstrapMigrationArguments(["plan"]).operation, "plan");
    assert.equal(bootstrapMigrationArguments(["apply", "--review=bootstrap-migration-ABC123", `--review-sha256=${"a".repeat(64)}`]).operation, "apply");
    for (const args of [["apply"], ["plan", "--production"], ["apply", "--review=migration-ABC123", `--review-sha256=${"a".repeat(64)}`]]) {
        assert.throws(() => bootstrapMigrationArguments(args));
    }
});
test("bootstrap state upload cannot target workload/Production state, use another file, overwrite or omit KMS", () => {
    const path = fileURLToPath(new URL("../.data/terraform-video-bootstrap/bootstrap-migration-ABC123/bootstrap-before.tfstate", import.meta.url));
    const args = ["s3api", "put-object", "--bucket", "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2", "--expected-bucket-owner", protectedConfig("awsAccountId"), "--key", "story-video/bootstrap/terraform.tfstate", "--if-none-match", "*", "--server-side-encryption", "aws:kms", "--ssekms-key-id", "arn:aws:kms:ap-southeast-2:" + protectedConfig("awsAccountId") + ":key/" + protectedConfig("stateKmsKeyId"), "--body", path, "--content-md5", "a".repeat(22) + "=="];
    assert.doesNotThrow(() => validatePersonalArguments(args));
    for (const [index, value] of [[7, "story-video/production/terraform.tfstate"], [7, "story-video/development/terraform.tfstate"],
        [15, path.replace("bootstrap-before", "arbitrary")], [8, "--force"], [11, "AES256"], [13, "another-key"]]) {
        const changed = [...args];
        changed[index] = value;
        assert.throws(() => validatePersonalArguments(changed));
    }
});
