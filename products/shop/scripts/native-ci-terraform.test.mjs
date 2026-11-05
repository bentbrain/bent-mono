import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { DEVELOPMENT_RESOURCES, inspectDevelopmentImagePlan, terraformFailureSummary } from "./native-ci-terraform.mjs";
test("Terraform diagnostics expose only operation categories, including wrapped permission errors", () => {
    const summary = terraformFailureSummary({ code: 1, stderr: "secret-value operation error S3: ListObjectsV2, api error AccessDenied: not authorized to perform:\n s3:ListBucket secret-value" });
    assert.deepEqual(summary.deniedActions, ["s3:ListBucket"]);
    assert.deepEqual(summary.operations, ["S3:ListObjectsV2"]);
    assert.deepEqual(summary.serviceErrors, ["AccessDenied"]);
    assert.ok(!JSON.stringify(summary).includes("secret-value"));
});
const candidate = { environment: "development", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2",
    sourceDigest: "a".repeat(64), imageDigest: `sha256:${"b".repeat(64)}` };
candidate.imageUri = protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@" + (candidate.imageDigest);
function fixture() {
    const resource = (address, before, after = before) => ({ address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
        change: { before, after, actions: [before === after ? "no-op" : "update"], after_unknown: {} } });
    return { terraform_version: "1.12.2", complete: true, errored: false, resource_changes: [
            ...["renderer", "failure"].map(kind => {
                const name = `forever-tee-video-development${kind === "failure" ? "-failures" : ""}`;
                const before = { function_name: name, role: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":role/" + (name), package_type: "Image",
                    memory_size: kind === "renderer" ? 3008 : 128, image_uri: "previous-immutable-image", environment: [{ variables: {} }] };
                const after = { ...before, image_uri: candidate.imageUri, environment: [{ variables: {
                                STORY_API_ORIGIN: "https://forever-tee-api-development.socialqueue.workers.dev",
                                ...(kind === "renderer" ? { STORY_BUILD_ID: candidate.sourceDigest } : {}),
                            } }] };
                return resource(`aws_lambda_function.${kind}[0]`, before, after);
            }),
            ...DEVELOPMENT_RESOURCES.filter(address => !address.startsWith("aws_lambda_function.")).map(address => resource(address, {})),
        ], output_changes: { function_arn: { actions: ["no-op"] } } };
}
test("the image plan permits only the reviewed existing Development function pair", () => {
    assert.equal(inspectDevelopmentImagePlan(fixture(), candidate).updateCount, 2);
    for (const change of [
        plan => { plan.resource_changes[0].change.actions = ["delete", "create"]; },
        plan => { plan.resource_changes[2].change.actions = ["update"]; },
        plan => { plan.resource_changes[0].change.after.role = "work"; },
        plan => { plan.resource_changes[0].change.after.memory_size = 10000; },
        plan => { plan.resource_changes[0].change.after.image_uri = "mutable:latest"; },
        plan => { plan.resource_changes[1].change.after.environment[0].variables.STORY_API_ORIGIN = "https://other.example"; },
        plan => { plan.resource_changes[1].change.after_unknown.role = true; },
        plan => { plan.resource_changes[1].change.after_unknown.architectures = [true]; },
        plan => { plan.resource_changes[1].change.actions = ["no-op"]; plan.resource_changes[1].change.after.image_uri = "wrong"; },
        plan => { plan.resource_changes[2].address = "other-inventory"; },
        plan => { plan.resource_changes[0].previous_address = "imported"; },
        plan => { plan.resource_changes.pop(); },
        plan => { plan.resource_drift = [{}]; },
        plan => { plan.complete = false; },
        plan => { plan.deferred_changes = [{}]; },
        plan => { plan.output_changes.unreviewed = { actions: ["create"] }; },
    ]) {
        const plan = fixture();
        change(plan);
        assert.throws(() => inspectDevelopmentImagePlan(plan, candidate));
    }
    assert.throws(() => inspectDevelopmentImagePlan(fixture(), { ...candidate, environment: "production" }));
    assert.throws(() => inspectDevelopmentImagePlan(fixture(), { ...candidate, imageUri: "other" }));
    const nestedKnown = fixture();
    nestedKnown.resource_changes[0].change.after_unknown.environment = [{ variables: {} }];
    nestedKnown.resource_changes[0].change.after_unknown.architectures = [false];
    assert.equal(inspectDevelopmentImagePlan(nestedKnown, candidate).updateCount, 2);
});
test("interrupted rollback permits only image observations between the two recorded immutable pairs", () => {
    const other = { ...candidate, imageDigest: `sha256:${"c".repeat(64)}`, sourceDigest: "d".repeat(64) };
    other.imageUri = protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@" + (other.imageDigest);
    const plan = fixture(), item = plan.resource_changes[0];
    item.change.before = structuredClone(item.change.after);
    const before = { ...item.change.before, image_uri: other.imageUri, environment: [{ variables: {
                    STORY_API_ORIGIN: "https://forever-tee-api-development.socialqueue.workers.dev", STORY_BUILD_ID: other.sourceDigest,
                } }] };
    plan.resource_drift = [{ address: item.address, mode: item.mode, provider_name: item.provider_name,
            change: { actions: ["update"], before, after: structuredClone(item.change.before) } }];
    assert.throws(() => inspectDevelopmentImagePlan(plan, candidate));
    assert.equal(inspectDevelopmentImagePlan(plan, candidate, [candidate, other]).observations[0].recordedPairImageObservation, true);
    for (const change of [
        p => { p.resource_drift[0].change.before.image_uri = "unrecorded"; },
        p => { p.resource_drift[0].change.before.environment[0].variables.STORY_BUILD_ID = "unrecorded"; },
        p => { p.resource_drift[0].change.before.memory_size = 10240; },
        p => { p.resource_drift[0].change.actions = ["delete"]; },
    ]) {
        const altered = structuredClone(plan);
        change(altered);
        assert.throws(() => inspectDevelopmentImagePlan(altered, candidate, [candidate, other]));
    }
});
