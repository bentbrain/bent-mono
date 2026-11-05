import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal, promisify } from "node:util";
import { productionAWS } from "./native-production-ci.mjs";
import { terraformFailureSummary } from "./native-ci-terraform.mjs";
import { assertReleasePaused } from "./native-release-pause.mjs";
import { verifyStartupProbe } from "./native-ci-health.mjs";
import { normalizeTerraformObservation } from "./native-ci-observations.mjs";
import { PREVIOUS_PRODUCTION_IMAGE_DIGEST, PREVIOUS_PRODUCTION_SOURCE_DIGEST, PRODUCTION_ORIGIN, productionImagePair, verifyProductionRuntime, } from "./native-production-runtime.mjs";
const execute = promisify(execFile);
const MODULE = fileURLToPath(new URL("../infra/story-video-production/", import.meta.url));
const NAME = "forever-tee-video-production";
const ZIP_HASH = protectedConfig("resource_9519c9b3fa59");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => {
    if (!value)
        throw new Error(`Production image update stopped: ${reason}`);
};
const targetPair = productionImagePair();
const previousPair = productionImagePair(PREVIOUS_PRODUCTION_IMAGE_DIGEST, PREVIOUS_PRODUCTION_SOURCE_DIGEST);
const pairs = [previousPair, targetPair];
const functionAddresses = new Map([
    ["aws_lambda_function.renderer", { name: NAME, failure: false }],
    ["aws_lambda_function.failures", { name: `${NAME}-failures`, failure: true }],
]);
const resources = [
    "aws_cloudwatch_log_group.failures", "aws_cloudwatch_log_group.renderer",
    ...["async_age", "dead_letters", "delivery_failures", "failure_errors", "failure_queue_age", "renderer_errors", "renderer_throttles"]
        .map(name => `aws_cloudwatch_metric_alarm.runtime[\"${name}\"]`),
    "aws_lambda_event_source_mapping.failures", "aws_lambda_function.failures", "aws_lambda_function.renderer",
    "aws_lambda_function_event_invoke_config.renderer", "aws_s3_bucket.releases", "aws_s3_bucket_ownership_controls.releases",
    "aws_s3_bucket_policy.releases", "aws_s3_bucket_public_access_block.releases",
    "aws_s3_bucket_server_side_encryption_configuration.releases", "aws_s3_bucket_versioning.releases",
    "aws_sns_topic.alerts[0]", "aws_sns_topic_subscription.email[0]", "aws_sqs_queue.failure_dead_letter", "aws_sqs_queue.failures",
].sort();
const unknown = value => value === true || (value !== null && typeof value === "object" && Object.values(value).some(unknown));
export function summarizeProductionImagePlan(plan) {
    const summarize = item => {
        const before = item?.change?.before ?? {}, after = item?.change?.after ?? {};
        const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .filter(key => !equal(before[key], after[key]))
            .filter(key => /^[A-Za-z0-9_]{1,64}$/.test(key)).sort().slice(0, 64);
        return {
            address: typeof item?.address === "string" && /^[A-Za-z0-9_.[\]"-]{1,160}$/.test(item.address) ? item.address : "invalid",
            actions: Array.isArray(item?.change?.actions) ? item.change.actions.filter(action => ["create", "delete", "no-op", "read", "update"].includes(action)).slice(0, 2) : [],
            changedKeys,
        };
    };
    return {
        drift: Array.isArray(plan?.resource_drift) ? plan.resource_drift.slice(0, 32).map(summarize) : [],
        changes: Array.isArray(plan?.resource_changes) ? plan.resource_changes.filter(item => !equal(item?.change?.actions, ["no-op"])).slice(0, 32).map(summarize) : [],
    };
}
function pairFor(value, failure) {
    const pair = pairs.find(item => item.imageUri === value.image_uri);
    check(pair && equal(value.environment, [{ variables: {
                STORY_API_ORIGIN: PRODUCTION_ORIGIN,
                STORY_DEPLOYMENT_ENV: "production",
                ...(failure ? {} : { STORY_BUILD_ID: pair.sourceDigest }),
            } }]), "recorded source and image pair.");
    return pair;
}
export function verifyProductionImageObservations(plan) {
    if (!plan.resource_drift?.length)
        return [];
    const expected = ["aws_lambda_event_source_mapping.failures", "aws_lambda_function.failures", "aws_lambda_function.renderer"];
    check(plan.resource_drift.length === expected.length && equal(plan.resource_drift.map(item => item.address).sort(), [...expected].sort()), "only exact first-refresh observations.");
    const reviewed = [];
    for (const drift of plan.resource_drift) {
        check(drift.mode === "managed" && drift.provider_name === "registry.terraform.io/hashicorp/aws" &&
            equal(drift.change.actions, ["update"]) && !drift.previous_address && !drift.change.importing, "exact observation shape.");
        const resource = plan.resource_changes.find(item => item.address === drift.address);
        check(resource && equal(resource.change.before, drift.change.after), "planned resource must use the observed state.");
        const normalized = normalizeTerraformObservation(drift.address, drift.change.before, drift.change.after);
        check(equal(normalized.restored, drift.change.before), "observation contains no other change.");
        reviewed.push({ address: drift.address, fields: normalized.fields });
    }
    return reviewed;
}
export function inspectProductionImagePlan(plan) {
    check(plan.terraform_version === "1.12.2" && plan.complete === true && typeof plan.applyable === "boolean" && plan.errored === false &&
        !plan.deferred_changes?.length, "complete applicable plan.");
    check(equal(plan.resource_changes?.map(item => item.address).sort(), resources), "exact Production resource inventory.");
    const observations = verifyProductionImageObservations(plan);
    check(Object.values(plan.output_changes ?? {}).every(item => equal(item.actions, ["no-op"]) && equal(item.before, item.after)), "no output changes.");
    const updated = [], observed = [];
    for (const item of plan.resource_changes) {
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" && !item.previous_address && !item.change.importing, "no provider, import or move changes.");
        const spec = functionAddresses.get(item.address), { actions, before, after, after_unknown: afterUnknown = {} } = item.change;
        if (!spec) {
            check(equal(actions, ["no-op"]) && equal(before, after), `unrelated resource changed (${item.address}).`);
            continue;
        }
        check(equal(actions, ["no-op"]) || equal(actions, ["update"]), "only in-place function image updates are permitted.");
        check(before.function_name === spec.name && after.function_name === spec.name && after.package_type === "Image" && after.image_uri === targetPair.imageUri, "exact function and target image.");
        const beforePair = pairFor(before, spec.failure), afterPair = pairFor(after, spec.failure);
        check(equal(afterPair, targetPair), "exact qualified target pair.");
        observed.push(beforePair.imageDigest);
        const mutable = new Set(["image_uri", "environment", "last_modified", "qualified_arn", "qualified_invoke_arn",
            "source_code_hash", "source_code_size", "version"]);
        for (const key of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(afterUnknown)])) {
            if (!mutable.has(key))
                check(!unknown(afterUnknown[key]) && equal(before[key], after[key]), `unexpected function change: ${key}.`);
        }
        if (equal(actions, ["update"]))
            updated.push(item.address);
    }
    check(new Set(observed).size === 1 && ((updated.length === 0 && plan.applyable === false) ||
        (updated.length === 2 && plan.applyable === true)), "both functions must move together from one recorded pair.");
    return { imagePlanVerified: true, updateCount: updated.length, updated, creates: 0, deletes: 0, observations,
        previousImageDigest: observed[0], imageDigest: targetPair.imageDigest, sourceDigest: targetPair.sourceDigest, applied: false };
}
export async function verifyCurrentProductionRuntime(call) {
    try {
        return await verifyProductionRuntime(call, targetPair);
    }
    catch (targetError) {
        try {
            return await verifyProductionRuntime(call, previousPair);
        }
        catch {
            throw new Error(`Production image update stopped: live runtime is not either recorded pair (${targetError.message}).`);
        }
    }
}
export async function prepareProductionImage(candidate, env, store) {
    check(candidate.imageDigest === targetPair.imageDigest && candidate.sourceDigest === targetPair.sourceDigest, "candidate is not the qualified target pair.");
    check(process.platform === "linux" && process.arch === "x64" && env.RUNNER_TEMP?.startsWith("/"), "cloud-only x86 Actions execution.");
    check(equal((await readdir(MODULE)).sort(), [".terraform.lock.hcl", "alerts.tf", "main.tf", "runtime.tf", "versions.tf"]), "exact Terraform module inventory.");
    const { call, child } = await productionAWS(env);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "production-image-"));
    const response = await fetch("https://releases.hashicorp.com/terraform/1.12.2/terraform_1.12.2_linux_amd64.zip", {
        redirect: "error", signal: AbortSignal.timeout(30000),
    });
    check(response.ok, "pinned Terraform download.");
    const archiveBytes = Buffer.from(await response.arrayBuffer());
    check(hash(archiveBytes) === ZIP_HASH, "Terraform checksum.");
    const archive = join(directory, "terraform.zip");
    await writeFile(archive, archiveBytes, { flag: "wx", mode: 0o600 });
    await execute("/usr/bin/unzip", ["-q", archive, "-d", directory]);
    const tfEnv = { ...child, HOME: directory, TF_DATA_DIR: join(directory, "providers"), TF_CLI_CONFIG_FILE: "/dev/null",
        TF_INPUT: "false", TF_IN_AUTOMATION: "true", TF_WORKSPACE: "default", CHECKPOINT_DISABLE: "1",
        TF_VAR_enable_alerts: "true", TF_VAR_alert_email: env.NATIVE_ALERT_EMAIL,
        TF_VAR_image_digest: targetPair.imageDigest, TF_VAR_source_digest: targetPair.sourceDigest };
    let diagnostic = 0;
    const run = async (args) => {
        try {
            return await execute(join(directory, "terraform"), args, { cwd: MODULE, env: tfEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300000 });
        }
        catch (error) {
            const summary = { operation: args[0], ...terraformFailureSummary(error) };
            const reference = await store.save(`runtime-update-error-${diagnostic++}.json`, Buffer.from(JSON.stringify({ summary, stdout: error.stdout, stderr: error.stderr })));
            console.error(JSON.stringify({ ...summary, privateDiagnostic: reference }));
            throw new Error("Production Terraform response failed or is uncertain; inspect saved evidence before recovery.");
        }
    };
    await run(["init", "-input=false", "-lockfile=readonly", "-no-color"]);
    const planPath = join(directory, "runtime-update.tfplan");
    await run(["plan", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", `-out=${planPath}`]);
    const raw = (await run(["show", "-json", planPath])).stdout;
    let review;
    try {
        review = inspectProductionImagePlan(JSON.parse(raw));
    }
    catch (error) {
        const reference = await store.save("runtime-update-rejected.json", Buffer.from(raw));
        console.error(JSON.stringify({ planRejected: true, ...summarizeProductionImagePlan(JSON.parse(raw)), privatePlan: reference }));
        throw error;
    }
    const planBytes = await readFile(planPath);
    const evidence = { ...review, planSha256: hash(planBytes), terraformVersion: "1.12.2", remoteStateLocked: true, sourceCommit: env.GITHUB_SHA };
    let attempted = false;
    return {
        review: evidence,
        preserve: () => store.save("runtime-update.tfplan", planBytes),
        verifyBefore: () => verifyCurrentProductionRuntime(call),
        apply: async (cf, releaseId) => {
            check(!attempted, "saved plan was already attempted; inspect state before recovery.");
            await assertReleasePaused(cf, releaseId);
            const rows = (await cf.query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status='rendering'"))[0].results;
            check(rows.length === 1 && rows[0].count === 0, "active render remains after the recorded drain.");
            check(hash(await readFile(planPath)) === evidence.planSha256, "saved plan bytes changed.");
            inspectProductionImagePlan(JSON.parse((await run(["show", "-json", planPath])).stdout));
            attempted = true;
            if (review.updateCount > 0)
                await run(["apply", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", planPath]);
            await assertReleasePaused(cf, releaseId);
            const runtime = await verifyProductionRuntime(call, targetPair), probes = await probeProductionImageStartup(call, env);
            return { ...evidence, applied: review.updateCount > 0, runtime, probes, startupVerified: true };
        },
    };
}
// Both lanes use these actual startup invocations.
export async function probeProductionImageStartup(call, env) {
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "release-startup-")), probes = [];
    for (const failure of [false, true]) {
        const path = join(directory, `startup-${failure ? "failure" : "renderer"}.json`);
        const result = await call(["lambda", "invoke", "--function-name", `${NAME}${failure ? "-failures" : ""}`, "--invocation-type", "RequestResponse",
            "--cli-binary-format", "raw-in-base64-out", "--payload", '{"nativeReleaseStartupProbe":true}', path]);
        probes.push(verifyStartupProbe(result, JSON.parse(resolveProtectedTemplate(await readFile(path))), failure));
    }
    return probes;
}
