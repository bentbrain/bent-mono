import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support/production-foundation-fixture.mjs";
import { FAILED_ALERT_RUN } from "./native-production-alert-recovery.mjs";
import { inspectProductionRuntimePlan, verifyProductionFunction, PRODUCTION_IMAGE_URI, PRODUCTION_SOURCE_DIGEST, PRODUCTION_ORIGIN } from "./native-production-runtime.mjs";
import { verifyNoProductionRuntime, verifyRuntimeStateUnchanged } from "./native-production-provision.mjs";
const name = "forever-tee-video-production", arn = suffix => "arn:aws:lambda:ap-southeast-2:" + protectedConfig("awsAccountId") + ":function:" + (name) + (suffix);
const queue = "arn:aws:sqs:ap-southeast-2:" + protectedConfig("awsAccountId") + ":" + (name) + "-failures";
test("runtime pre-intent state comparison accepts reordered checks but rejects every changed value", () => {
    const before = { serial: 5, resources: [{ value: "unchanged" }], check_results: [
            { config_addr: "var.alert_email", status: "pass" }, { config_addr: "var.enable_alerts", status: "pass" }
        ] };
    const after = structuredClone(before);
    after.check_results.reverse();
    assert.doesNotThrow(() => verifyRuntimeStateUnchanged(before, after));
    for (const mutate of [value => { value.serial++; }, value => { value.check_results[0].status = "fail"; },
        value => { value.resources[0].value = "different"; }, value => { value.check_results.pop(); }]) {
        const copy = structuredClone(after);
        mutate(copy);
        assert.throws(() => verifyRuntimeStateUnchanged(before, copy));
    }
});
function runtimeValue(failure) {
    const suffix = failure ? "-failures" : "";
    return { function_name: name + suffix, role: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":role/" + (name) + "-" + (failure ? "failures" : "runtime"),
        package_type: "Image", image_uri: PRODUCTION_IMAGE_URI, architectures: ["x86_64"], memory_size: failure ? 128 : 3008, timeout: failure ? 30 : 120,
        reserved_concurrent_executions: failure ? 2 : 8, ephemeral_storage: [{ size: failure ? 512 : 1024 }],
        environment: [{ variables: { STORY_API_ORIGIN: PRODUCTION_ORIGIN, STORY_DEPLOYMENT_ENV: "production", ...(failure ? {} : { STORY_BUILD_ID: PRODUCTION_SOURCE_DIGEST }) } }],
        publish: false, logging_config: [{ log_group: `/aws/lambda/${name}${suffix}`, log_format: "Text" }],
        image_config: failure ? [{ command: ["aws-lambda/failure-entry.handler"], entry_point: [], working_directory: "" }] : [] };
}
function plan() {
    const value = fixture(true);
    value.applyable = true;
    for (const item of value.resource_changes) {
        if (item.address === FAILED_ALERT_RUN.address)
            Object.assign(item.change.after, { id: FAILED_ALERT_RUN.subscription, arn: FAILED_ALERT_RUN.subscription,
                owner_id: protectedConfig("awsAccountId"), pending_confirmation: false });
        item.change.actions = ["no-op"];
        item.change.before = structuredClone(item.change.after);
    }
    const additions = {
        "aws_lambda_function.renderer": runtimeValue(false), "aws_lambda_function.failures": runtimeValue(true),
        "aws_lambda_function_event_invoke_config.renderer": { function_name: name, maximum_event_age_in_seconds: 60, maximum_retry_attempts: 0,
            destination_config: [{ on_failure: [{ destination: queue }], on_success: [] }] },
        "aws_lambda_event_source_mapping.failures": { function_name: arn("-failures"), event_source_arn: queue, enabled: true, batch_size: 1,
            maximum_batching_window_in_seconds: 0, function_response_types: ["ReportBatchItemFailures"], scaling_config: [{ maximum_concurrency: 2 }], tags: {}, tags_all: {} },
    };
    value.resource_changes.push(...Object.entries(additions).map(([address, after]) => ({ address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["create"], before: null, after, after_unknown: { arn: true, id: true, environment: [{ variables: {} }] } } })));
    return value;
}
test("runtime preparation creates only two bounded qualified functions and exact failure delivery", () => {
    assert.equal(inspectProductionRuntimePlan(plan(), "owner@example.com").existingResourcesUnchanged, 19);
    const item = (value, address = "aws_lambda_function.renderer") => value.resource_changes.find(item => item.address === address);
    for (const mutate of [
        value => { value.applyable = false; }, value => { value.complete = false; }, value => { value.resource_changes.pop(); },
        value => { value.resource_changes.push(value.resource_changes.at(-1)); },
        value => { item(value).change.actions = ["delete", "create"]; }, value => { item(value).change.before = {}; },
        value => { item(value).change.importing = {}; }, value => { item(value).change.after.role = "other"; },
        value => { item(value).change.after.image_uri = "other"; }, value => { item(value).change.after.memory_size = 8192; },
        value => { item(value).change.after.environment[0].variables.STORY_DEPLOYMENT_ENV = "development"; },
        value => { item(value).change.after.environment[0].variables.SECRET = "unexpected"; },
        value => { item(value).change.after_unknown.environment = [{ variables: { STORY_API_ORIGIN: true } }]; },
        value => { item(value).change.after.vpc_config = [{}]; }, value => { item(value).change.after.publish = true; },
        value => { item(value).change.after.image_config = [{ command: ["other"] }]; },
        value => { item(value, "aws_lambda_function_event_invoke_config.renderer").change.after.maximum_retry_attempts = 2; },
        value => { item(value, "aws_lambda_event_source_mapping.failures").change.after.tags_all = { Project: "unexpected" }; },
        value => { item(value, "aws_lambda_event_source_mapping.failures").change.after.event_source_arn = "other"; },
        value => { item(value, "aws_lambda_event_source_mapping.failures").change.after.filter_criteria = [{}]; },
        value => { value.resource_changes[0].change.actions = ["update"]; },
    ]) {
        const copy = plan();
        mutate(copy);
        assert.throws(() => inspectProductionRuntimePlan(copy, "owner@example.com"));
    }
});
test("live runtime verification checks environment, resolved digest, roles and resource limits", () => {
    for (const failure of [false, true]) {
        const configured = runtimeValue(failure), response = { Code: { ImageUri: PRODUCTION_IMAGE_URI, ResolvedImageUri: PRODUCTION_IMAGE_URI },
            Configuration: { FunctionName: configured.function_name, FunctionArn: arn(failure ? "-failures" : ""), PackageType: "Image", State: "Active", LastUpdateStatus: "Successful",
                Architectures: ["x86_64"], MemorySize: configured.memory_size, Timeout: configured.timeout, Role: configured.role,
                EphemeralStorage: { Size: configured.ephemeral_storage[0].size }, Environment: { Variables: configured.environment[0].variables },
                ...(failure ? { ImageConfigResponse: { ImageConfig: { Command: ["aws-lambda/failure-entry.handler"] } } } : {}) } };
        assert.equal(verifyProductionFunction(response, failure).functionArn, response.Configuration.FunctionArn);
        for (const mutate of [value => { value.Configuration.State = "Pending"; }, value => { value.Code.ResolvedImageUri = "different"; },
            value => { value.Configuration.Environment.Variables.STORY_DEPLOYMENT_ENV = "development"; }, value => { value.Configuration.Role = "other"; },
            value => { value.Configuration.MemorySize = 8192; }, value => { value.Configuration.Environment.Variables.EXTRA = "unexpected"; }]) {
            const copy = structuredClone(response);
            mutate(copy);
            assert.throws(() => verifyProductionFunction(copy, failure));
        }
    }
});
test("runtime collisions require exact absence, not access denial, and never take over a function or mapping", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ResourceNotFoundException" });
    await verifyNoProductionRuntime(async (args) => { if (args[1] === "get-function")
        throw missing; return { EventSourceMappings: [] }; });
    await assert.rejects(verifyNoProductionRuntime(async () => ({})), /exists/);
    await assert.rejects(verifyNoProductionRuntime(async () => { throw Object.assign(new Error("denied"), { code: "AccessDeniedException" }); }), /read failed/);
    await assert.rejects(verifyNoProductionRuntime(async (args) => { if (args[1] === "get-function")
        throw missing; return { EventSourceMappings: [{}] }; }), /mapping/);
});
