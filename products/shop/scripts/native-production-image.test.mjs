import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeProductionImageStartup, inspectProductionImagePlan, summarizeProductionImagePlan, verifyProductionImageObservations, } from "./native-production-image.mjs";
import { PREVIOUS_PRODUCTION_IMAGE_DIGEST, PREVIOUS_PRODUCTION_SOURCE_DIGEST, PRODUCTION_IMAGE_DIGEST, PRODUCTION_SOURCE_DIGEST, PRODUCTION_ORIGIN, productionImagePair, } from "./native-production-runtime.mjs";
const name = "forever-tee-video-production";
const target = productionImagePair();
const previous = productionImagePair(PREVIOUS_PRODUCTION_IMAGE_DIGEST, PREVIOUS_PRODUCTION_SOURCE_DIGEST);
test("API releases invoke and validate both real startup handlers without image writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "api-startup-test-")), calls = [];
    try {
        const call = async (args) => {
            calls.push(args);
            assert.deepEqual(args.slice(0, 3), ["lambda", "invoke", "--function-name"]);
            assert.ok([name, `${name}-failures`].includes(args[3]));
            const failure = args[3].endsWith("-failures");
            await writeFile(args.at(-1), JSON.stringify({ errorType: "Error",
                errorMessage: failure ? "Expected the personal failure-queue Lambda." : "Invalid app job." }));
            return { StatusCode: 200, FunctionError: "Unhandled", ExecutedVersion: "$LATEST" };
        };
        const results = await probeProductionImageStartup(call, { RUNNER_TEMP: directory });
        assert.equal(calls.length, 2);
        assert.ok(results.every(result => result.realRuntimeStarted));
        await assert.rejects(probeProductionImageStartup(async (args) => {
            await call(args);
            return { StatusCode: 202 };
        }, { RUNNER_TEMP: directory }));
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
const addresses = [
    "aws_cloudwatch_log_group.failures", "aws_cloudwatch_log_group.renderer",
    ...["async_age", "dead_letters", "delivery_failures", "failure_errors", "failure_queue_age", "renderer_errors", "renderer_throttles"]
        .map(value => `aws_cloudwatch_metric_alarm.runtime[\"${value}\"]`),
    "aws_lambda_event_source_mapping.failures", "aws_lambda_function.failures", "aws_lambda_function.renderer",
    "aws_lambda_function_event_invoke_config.renderer", "aws_s3_bucket.releases", "aws_s3_bucket_ownership_controls.releases",
    "aws_s3_bucket_policy.releases", "aws_s3_bucket_public_access_block.releases",
    "aws_s3_bucket_server_side_encryption_configuration.releases", "aws_s3_bucket_versioning.releases",
    "aws_sns_topic.alerts[0]", "aws_sns_topic_subscription.email[0]", "aws_sqs_queue.failure_dead_letter", "aws_sqs_queue.failures",
];
function functionValue(failure, pair) {
    return { function_name: `${name}${failure ? "-failures" : ""}`, package_type: "Image", image_uri: pair.imageUri,
        role: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":role/" + (name) + "-" + (failure ? "failures" : "runtime"), memory_size: failure ? 128 : 3008,
        environment: [{ variables: { STORY_API_ORIGIN: PRODUCTION_ORIGIN, STORY_DEPLOYMENT_ENV: "production",
                    ...(failure ? {} : { STORY_BUILD_ID: pair.sourceDigest }) } }], source_code_hash: pair.imageDigest };
}
function plan({ current = previous, update = true } = {}) {
    return { terraform_version: "1.12.2", complete: true, applyable: update, errored: false, deferred_changes: [], resource_drift: [], output_changes: {},
        resource_changes: addresses.map(address => {
            const failure = address === "aws_lambda_function.failures", renderer = address === "aws_lambda_function.renderer";
            const before = failure || renderer ? functionValue(failure, current) : { address };
            const after = failure || renderer ? functionValue(failure, target) : structuredClone(before);
            return { address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
                change: { actions: failure || renderer ? update ? ["update"] : ["no-op"] : ["no-op"], before, after, after_unknown: {} } };
        }),
    };
}
function withFirstRefreshObservations(value = plan()) {
    const observations = [
        ["aws_lambda_event_source_mapping.failures", { queues: [], tags: {}, topics: [] }],
        ["aws_lambda_function.failures", { layers: [], tags: {}, image_config: [{ command: ["aws-lambda/failure-entry.handler"], entry_point: [], working_directory: "" }] }],
        ["aws_lambda_function.renderer", { layers: [], tags: {} }],
    ];
    for (const [address, fields] of observations) {
        const resource = value.resource_changes.find(item => item.address === address);
        Object.assign(resource.change.before, structuredClone(fields));
        Object.assign(resource.change.after, structuredClone(fields));
        const before = structuredClone(resource.change.before), after = structuredClone(resource.change.before);
        for (const field of Object.keys(fields))
            before[field] = null;
        if (address === "aws_lambda_function.failures")
            before.image_config = [{ command: ["aws-lambda/failure-entry.handler"], entry_point: null, working_directory: "" }];
        value.resource_drift.push({ address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
            change: { actions: ["update"], before, after } });
    }
    return value;
}
test("Production image plan moves both functions from the recorded pair to the qualified immutable pair", () => {
    const result = inspectProductionImagePlan(plan());
    assert.deepEqual(result.updated.sort(), ["aws_lambda_function.failures", "aws_lambda_function.renderer"]);
    assert.equal(result.previousImageDigest, PREVIOUS_PRODUCTION_IMAGE_DIGEST);
    assert.equal(result.imageDigest, PRODUCTION_IMAGE_DIGEST);
    assert.equal(result.sourceDigest, PRODUCTION_SOURCE_DIGEST);
    const noOp = inspectProductionImagePlan(plan({ current: target, update: false }));
    assert.equal(noOp.updateCount, 0);
    const falselyApplyable = plan({ current: target, update: false });
    falselyApplyable.applyable = true;
    assert.throws(() => inspectProductionImagePlan(falselyApplyable));
});
test("Production image plan accepts only the exact first-refresh empty-value observations", () => {
    const value = withFirstRefreshObservations();
    assert.equal(verifyProductionImageObservations(value).length, 3);
    assert.equal(inspectProductionImagePlan(value).observations.length, 3);
    for (const mutate of [
        copy => { copy.resource_drift.pop(); },
        copy => { copy.resource_drift[0].change.actions = ["delete"]; },
        copy => { copy.resource_drift[0].change.after.tags = { Unexpected: "tag" }; },
        copy => { copy.resource_drift[1].change.before.image_config[0].command = ["other"]; },
        copy => { copy.resource_drift[2].change.after.layers = ["unexpected-layer"]; },
        copy => { copy.resource_changes.find(item => item.address === copy.resource_drift[0].address).change.before.tags = null; },
    ]) {
        const copy = withFirstRefreshObservations();
        mutate(copy);
        assert.throws(() => inspectProductionImagePlan(copy));
    }
});
test("Production image plan rejects drift, partial updates, unknown pairs and unrelated changes", () => {
    const item = (value, address) => value.resource_changes.find(change => change.address === address);
    for (const mutate of [
        value => { value.complete = false; }, value => { value.applyable = false; }, value => { value.resource_drift = [{}]; },
        value => { value.resource_changes.pop(); }, value => { item(value, "aws_s3_bucket.releases").change.actions = ["update"]; },
        value => { item(value, "aws_lambda_function.renderer").change.actions = ["no-op"]; },
        value => { item(value, "aws_lambda_function.renderer").change.after.image_uri = "other"; },
        value => { item(value, "aws_lambda_function.renderer").change.before.image_uri = "other"; },
        value => { item(value, "aws_lambda_function.renderer").change.before.environment[0].variables.STORY_BUILD_ID = "f".repeat(64); },
        value => { item(value, "aws_lambda_function.renderer").change.after.role = "other"; },
        value => { item(value, "aws_lambda_function.renderer").change.after_unknown.role = true; },
    ]) {
        const value = plan();
        mutate(value);
        assert.throws(() => inspectProductionImagePlan(value));
    }
});
test("Production image diagnostics expose only bounded plan structure", () => {
    const value = plan(), before = { address: "private-before", policy: "private-policy" }, after = { address: "private-after", policy: "other-private-policy" };
    value.resource_drift = [{ address: "aws_lambda_function.renderer", change: { actions: ["update"], before, after } }];
    const result = summarizeProductionImagePlan(value), text = JSON.stringify(result);
    assert.deepEqual(result.drift, [{ address: "aws_lambda_function.renderer", actions: ["update"], changedKeys: ["address", "policy"] }]);
    assert.equal(text.includes("private-before"), false);
    assert.equal(text.includes("private-policy"), false);
    assert.deepEqual(result.changes.map(item => item.address).sort(), ["aws_lambda_function.failures", "aws_lambda_function.renderer"]);
});
