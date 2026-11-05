import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { inspectAlertRecoveryPlan } from "./native-production-alert-recovery.mjs";
import { PRODUCTION_NAME as NAME, productionArn as arn } from "./native-production-permissions.mjs";
const check = (value, reason) => { if (!value)
    throw new Error(`Production runtime stopped: ${reason}`); };
const PRODUCTION_RUNTIME_RESOURCES = ["aws_lambda_function.renderer", "aws_lambda_function.failures", "aws_lambda_function_event_invoke_config.renderer", "aws_lambda_event_source_mapping.failures"];
export const PREVIOUS_PRODUCTION_SOURCE_DIGEST = protectedConfig("resource_482283ec6ab3");
export const PREVIOUS_PRODUCTION_IMAGE_DIGEST = "sha256:" + protectedConfig("resource_dd027d663b05");
export const PRODUCTION_SOURCE_DIGEST = protectedConfig("resource_483d1baf8d67");
export const PRODUCTION_IMAGE_DIGEST = "sha256:" + protectedConfig("resource_aa4c5d08d8b6");
export const PRODUCTION_IMAGE_URI = protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@" + (PRODUCTION_IMAGE_DIGEST);
export const PRODUCTION_ORIGIN = "https://forever-tee-api.socialqueue.workers.dev";
export const productionImagePair = (imageDigest = PRODUCTION_IMAGE_DIGEST, sourceDigest = PRODUCTION_SOURCE_DIGEST) => ({
    imageDigest, sourceDigest,
    imageUri: protectedConfig("awsAccountId") + ".dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@" + (imageDigest),
});
const unknown = value => value === true || (value !== null && typeof value === "object" && Object.values(value).some(unknown));
export function inspectProductionRuntimePlan(plan, email) {
    check(plan.complete === true && plan.applyable === true && plan.errored === false && !plan.deferred_changes?.length, "complete applicable plan.");
    const existing = structuredClone(plan);
    const runtime = existing.resource_changes?.filter(item => PRODUCTION_RUNTIME_RESOURCES.includes(item.address));
    check(equal(runtime?.map(item => item.address).sort(), [...PRODUCTION_RUNTIME_RESOURCES].sort()), "exact four runtime additions.");
    existing.resource_changes = existing.resource_changes.filter(item => !PRODUCTION_RUNTIME_RESOURCES.includes(item.address));
    inspectAlertRecoveryPlan(existing, email);
    for (const item of runtime) {
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" && !item.previous_address && !item.change.importing &&
            equal(item.change.actions, ["create"]) && item.change.before === null, "creation only; existing or partial runtime requires separate recovery.");
        const value = item.change.after, unresolved = item.change.after_unknown ?? {};
        const exact = (key, expected) => check(!unknown(unresolved[key]) && equal(value[key], expected), `resolved runtime ${key}.`);
        if (item.address.startsWith("aws_lambda_function.")) {
            const failure = item.address.endsWith(".failures"), name = `${NAME}${failure ? "-failures" : ""}`;
            for (const [key, expected] of Object.entries({ function_name: name, role: "arn:aws:iam::" + protectedConfig("awsAccountId") + ":role/" + (NAME) + "-" + (failure ? "failures" : "runtime"),
                package_type: "Image", image_uri: PRODUCTION_IMAGE_URI, architectures: ["x86_64"], memory_size: failure ? 128 : 3008,
                timeout: failure ? 30 : 120, reserved_concurrent_executions: failure ? 2 : 8, ephemeral_storage: [{ size: failure ? 512 : 1024 }],
                environment: [{ variables: { STORY_API_ORIGIN: PRODUCTION_ORIGIN, STORY_DEPLOYMENT_ENV: "production", ...(failure ? {} : { STORY_BUILD_ID: PRODUCTION_SOURCE_DIGEST }) } }] }))
                exact(key, expected);
            check(!value.vpc_config?.length && !value.file_system_config?.length && !value.layers?.length && !value.dead_letter_config?.length &&
                !value.kms_key_arn && !value.code_signing_config_arn && value.publish === false, "no unreviewed network, data, signing or published-version configuration.");
            check(value.logging_config?.length === 1 && value.logging_config[0].log_format === "Text" && value.logging_config[0].log_group === `/aws/lambda/${name}`, "exact existing log group.");
            if (failure)
                check(value.image_config?.length === 1 && equal(value.image_config[0].command, ["aws-lambda/failure-entry.handler"]) &&
                    !value.image_config[0].entry_point?.length && !value.image_config[0].working_directory, "exact failure entrypoint.");
            else
                check(!value.image_config?.length, "unmodified renderer entrypoint.");
        }
        else if (item.address === "aws_lambda_function_event_invoke_config.renderer") {
            exact("function_name", NAME);
            exact("maximum_event_age_in_seconds", 60);
            exact("maximum_retry_attempts", 0);
            check(!value.qualifier && value.destination_config?.length === 1 && !value.destination_config[0].on_success?.length &&
                equal(value.destination_config[0].on_failure, [{ destination: arn("sqs", `${NAME}-failures`) }]), "only the exact failure destination.");
        }
        else {
            for (const [key, expected] of Object.entries({ function_name: arn("lambda", `function:${NAME}-failures`), event_source_arn: arn("sqs", `${NAME}-failures`),
                enabled: true, batch_size: 1, maximum_batching_window_in_seconds: 0, function_response_types: ["ReportBatchItemFailures"],
                scaling_config: [{ maximum_concurrency: 2 }] }))
                exact(key, expected);
            check(!value.filter_criteria?.length && !value.source_access_configuration?.length && !value.destination_config?.length &&
                !Object.keys(value.tags ?? {}).length && !Object.keys(value.tags_all ?? {}).length, "no filters, credentials, destinations or mapping tags.");
        }
    }
    return { environment: "production", creates: PRODUCTION_RUNTIME_RESOURCES, existingResourcesUnchanged: 19, deletes: 0,
        imageDigest: PRODUCTION_IMAGE_DIGEST, sourceDigest: PRODUCTION_SOURCE_DIGEST, rendererConcurrency: 8, failureConcurrency: 2, providerCutover: false };
}
export function verifyProductionFunction(response, failure = false, pair = productionImagePair()) {
    const name = `${NAME}${failure ? "-failures" : ""}`, config = response.Configuration;
    check(config?.FunctionName === name && config.FunctionArn === arn("lambda", `function:${name}`) && config.PackageType === "Image" &&
        config.State === "Active" && config.LastUpdateStatus === "Successful" && equal(config.Architectures, ["x86_64"]) &&
        config.MemorySize === (failure ? 128 : 3008) && config.Timeout === (failure ? 30 : 120) &&
        config.Role === "arn:aws:iam::" + protectedConfig("awsAccountId") + ":role/" + (NAME) + "-" + (failure ? "failures" : "runtime") &&
        config.EphemeralStorage?.Size === (failure ? 512 : 1024), "exact active function and runtime limits.");
    check(response.Code?.ResolvedImageUri === pair.imageUri && response.Code.ImageUri === pair.imageUri, "resolved qualified image digest.");
    check(equal(config.Environment?.Variables, { STORY_API_ORIGIN: PRODUCTION_ORIGIN, STORY_DEPLOYMENT_ENV: "production",
        ...(failure ? {} : { STORY_BUILD_ID: pair.sourceDigest }) }), "exact Production callback environment.");
    const imageConfig = config.ImageConfigResponse?.ImageConfig;
    if (failure)
        check(equal(imageConfig?.Command, ["aws-lambda/failure-entry.handler"]) && !imageConfig.EntryPoint?.length && !imageConfig.WorkingDirectory, "failure handler command.");
    else
        check(!imageConfig?.Command?.length && !imageConfig?.EntryPoint?.length && !imageConfig?.WorkingDirectory, "unmodified renderer entrypoint.");
    check(!config.VpcConfig?.SubnetIds?.length && !config.FileSystemConfigs?.length && !config.Layers?.length && !config.DeadLetterConfig?.TargetArn, "no unexpected runtime attachments.");
    return { functionArn: config.FunctionArn, revisionId: config.RevisionId, imageDigest: pair.imageDigest, sourceDigest: pair.sourceDigest };
}
export async function verifyProductionRuntime(call, pair = productionImagePair()) {
    const renderer = verifyProductionFunction(await call(["lambda", "get-function", "--function-name", NAME]), false, pair);
    const failure = verifyProductionFunction(await call(["lambda", "get-function", "--function-name", `${NAME}-failures`]), true, pair);
    for (const name of [NAME, `${NAME}-failures`]) {
        try {
            await call(["lambda", "get-policy", "--function-name", name]);
        }
        catch (error) {
            if (error.code === "ResourceNotFoundException")
                continue;
            throw new Error("Could not verify absence of a public/cross-account invocation policy.");
        }
        throw new Error("Unexpected function resource policy; admission remains blocked.");
    }
    for (const [name, expected] of [[NAME, 8], [`${NAME}-failures`, 2]])
        check((await call(["lambda", "get-function-concurrency", "--function-name", name])).ReservedConcurrentExecutions === expected, "exact reserved capacity.");
    const config = await call(["lambda", "get-function-event-invoke-config", "--function-name", NAME]);
    check(config.MaximumEventAgeInSeconds === 60 && config.MaximumRetryAttempts === 0 && config.DestinationConfig?.OnFailure?.Destination === arn("sqs", `${NAME}-failures`) &&
        !config.DestinationConfig?.OnSuccess?.Destination, "bounded failure delivery.");
    const mappings = await call(["lambda", "list-event-source-mappings", "--function-name", `${NAME}-failures`]);
    check(!mappings.NextMarker && mappings.EventSourceMappings?.length === 1 && /^[a-f0-9-]{36}$/.test(mappings.EventSourceMappings[0].UUID), "single failure mapping.");
    const mapping = await call(["lambda", "get-event-source-mapping", "--uuid", mappings.EventSourceMappings[0].UUID]);
    check(mapping.FunctionArn === failure.functionArn && mapping.EventSourceArn === arn("sqs", `${NAME}-failures`) && mapping.State === "Enabled" &&
        mapping.BatchSize === 1 && mapping.MaximumBatchingWindowInSeconds === 0 && mapping.ScalingConfig?.MaximumConcurrency === 2 &&
        equal(mapping.FunctionResponseTypes, ["ReportBatchItemFailures"]) && !mapping.FilterCriteria?.Filters?.length, "exact active failure mapping.");
    return { runtimeVerified: true, renderer, failure, mappingId: mapping.UUID, productionCapacityReserved: true, providerCutover: false };
}
