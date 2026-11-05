import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { migrationArguments, inspectMigrationState, requireEmptyDestination } from "./aws-personal-state-migration.mjs";
import { validatePersonalArguments } from "./aws-personal-guard.mjs";
test("state migration accepts only the reviewed Development lineage, serial and complete resource set", () => {
    const fixture = { version: 4, lineage: protectedConfig("resource_7a26fb703a23"), serial: 28,
        resources: Array.from({ length: 25 }, () => ({ mode: "managed", provider: 'provider["registry.terraform.io/hashicorp/aws"]' })) };
    assert.equal(inspectMigrationState(fixture).resources, 25);
    for (const changed of [{ ...fixture, serial: 29 }, { ...fixture, lineage: "foreign" }, { ...fixture, resources: [] },
        { ...fixture, resources: fixture.resources.map(item => ({ ...item, provider: "work" })) }])
        assert.throws(() => inspectMigrationState(changed));
});
test("destination and lock must both return exact not-found responses; denied and uncertain reads stop migration", async () => {
    const absent = Object.assign(new Error(), { stderr: "An error occurred (404) when calling the HeadObject operation: Not Found" });
    let calls = 0;
    await requireEmptyDestination(async (args) => { validatePersonalArguments(args); calls++; throw absent; });
    assert.equal(calls, 2);
    for (const result of [null, new Error("expired"), Object.assign(new Error(), { stderr: "(403) when calling the HeadObject operation" })]) {
        await assert.rejects(requireEmptyDestination(async () => { if (result)
            throw result; return "{}"; }));
    }
});
test("state upload requires exact owner, state key, KMS key, private snapshot, checksum and conditional creation", () => {
    const path = fileURLToPath(new URL("../.data/terraform-story-video/migration-ABC123/renderer-before.tfstate", import.meta.url));
    const args = ["s3api", "put-object", "--bucket", "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2", "--expected-bucket-owner", protectedConfig("awsAccountId"), "--key", "story-video/development/terraform.tfstate", "--if-none-match", "*", "--server-side-encryption", "aws:kms", "--ssekms-key-id", "arn:aws:kms:ap-southeast-2:" + protectedConfig("awsAccountId") + ":key/" + protectedConfig("stateKmsKeyId"), "--body", path, "--content-md5", `${"a".repeat(22)}==`];
    validatePersonalArguments(args);
    for (const index of [3, 5, 7, 8, 9, 11, 13, 15, 17]) {
        const modified = [...args];
        modified[index] = "other";
        assert.throws(() => validatePersonalArguments(modified));
    }
    assert.throws(() => validatePersonalArguments([...args, "--metadata", "arbitrary"]));
    for (const operation of ["get-bucket-encryption", "get-bucket-versioning", "get-public-access-block"]) {
        validatePersonalArguments(["s3api", operation, "--bucket", args[3], "--expected-bucket-owner", args[5]]);
        assert.throws(() => validatePersonalArguments(["s3api", operation, "--bucket", "wrong"]));
    }
});
test("migration argument parser refuses force-copy, alternate state, production and unreviewed apply", () => {
    assert.equal(migrationArguments(["plan"]).operation, "plan");
    assert.deepEqual(migrationArguments(["apply", "--review=migration-ABC123", `--review-sha256=${"a".repeat(64)}`]), { operation: "apply", review: "migration-ABC123", hash: "a".repeat(64) });
    for (const args of [["apply"], ["plan", "--environment=production"], ["plan", "-force-copy"], ["apply", "-state=other"]]) {
        assert.throws(() => migrationArguments(args));
    }
    assert.equal(migrationArguments(["resume-cli-rejection", "--review=migration-ZKdVgY", "--review-sha256=" + protectedConfig("resource_5d7c568077cc")]).operation, "resume");
    assert.throws(() => migrationArguments(["resume-cli-rejection", "--review=migration-ABC123", `--review-sha256=${"a".repeat(64)}`]));
});
