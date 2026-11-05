import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { PRODUCTION_NAME as NAME, PRODUCTION_BUCKET as BUCKET, productionArn as arn } from "./native-production-permissions.mjs";
const check = (value, reason) => { if (!value)
    throw new Error(`Production foundation rejected: ${reason}`); };
export const FOUNDATION_RESOURCES = ["aws_s3_bucket.releases", "aws_s3_bucket_public_access_block.releases", "aws_s3_bucket_versioning.releases",
    "aws_s3_bucket_ownership_controls.releases", "aws_s3_bucket_server_side_encryption_configuration.releases", "aws_s3_bucket_policy.releases",
    "aws_sqs_queue.failures", "aws_sqs_queue.failure_dead_letter", "aws_cloudwatch_log_group.renderer", "aws_cloudwatch_log_group.failures"];
export const ALARMS = {
    renderer_errors: ["AWS/Lambda", "Errors", { FunctionName: NAME }, "Sum", 1],
    renderer_throttles: ["AWS/Lambda", "Throttles", { FunctionName: NAME }, "Sum", 1],
    async_age: ["AWS/Lambda", "AsyncEventAge", { FunctionName: NAME }, "Maximum", 30000],
    failure_errors: ["AWS/Lambda", "Errors", { FunctionName: `${NAME}-failures` }, "Sum", 1],
    failure_queue_age: ["AWS/SQS", "ApproximateAgeOfOldestMessage", { QueueName: `${NAME}-failures` }, "Maximum", 60],
    dead_letters: ["AWS/SQS", "ApproximateNumberOfMessagesVisible", { QueueName: `${NAME}-failures-dead-letter` }, "Maximum", 1],
    delivery_failures: ["AWS/SNS", "NumberOfNotificationsFailed", { TopicName: `${NAME}-alerts` }, "Sum", 1],
};
export const ALERT_RESOURCES = ["aws_sns_topic.alerts[0]", "aws_sns_topic_subscription.email[0]", ...Object.keys(ALARMS).map(name => `aws_cloudwatch_metric_alarm.runtime["${name}"]`)];
export const ALERT_ARN = arn("sns", `${NAME}-alerts`);
export const releaseBucketPolicy = () => ({ Version: "2012-10-17", Statement: [
        { Sid: "RequireTLS", Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`], Condition: { Bool: { "aws:SecureTransport": "false" } } },
        { Sid: "RetainReleaseEvidence", Effect: "Deny", Principal: "*", Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"], Resource: `arn:aws:s3:::${BUCKET}/source/*` },
    ] });
export const alertTopicPolicy = () => ({ Version: "2012-10-17", Statement: [{ Sid: "ProductionCloudWatchAlarmsOnly", Effect: "Allow",
            Principal: { Service: "cloudwatch.amazonaws.com" }, Action: "sns:Publish", Resource: ALERT_ARN,
            Condition: { StringEquals: { "aws:SourceAccount": protectedConfig("awsAccountId") }, ArnLike: { "aws:SourceArn": arn("cloudwatch", `alarm:${NAME}-*`) } } }] });
export function assertFoundationContext(env) {
    check(env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === "bentbrain/bent-mono" && env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") &&
        env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") && env.GITHUB_REF === "refs/heads/main" && env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
        env.GITHUB_RUN_ATTEMPT === "1" && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") && /^[1-9][0-9]+$/.test(env.GITHUB_RUN_ID ?? "") &&
        env.GITHUB_WORKFLOW_REF === "bentbrain/bent-mono/.github/workflows/native-production-foundation.yml@refs/heads/main", "exact personal main-only first-attempt Actions workflow.");
    check(["plan", "provision", "enable-alerts", "verify-alerts", "recover-alerts", "finish-alert-recovery"].includes(env.NATIVE_OPERATION), "explicit foundation operation.");
}
export function inspectFoundationPlan(plan, { operation, alertEmail }) {
    const alerts = operation === "enable-alerts";
    check(["plan", "provision", "enable-alerts"].includes(operation), "plan operation.");
    check(plan.terraform_version === "1.12.2" && plan.complete === true && plan.errored === false && !plan.deferred_changes?.length &&
        Object.keys(plan.output_changes ?? {}).length === 0, "complete plan, no outputs.");
    const observations = verifyFoundationObservations(plan, alerts);
    check(equal(plan.resource_changes?.map(item => item.address).sort(), [...FOUNDATION_RESOURCES, ...(alerts ? ALERT_RESOURCES : [])].sort()), "exact resource inventory, no Lambda/IAM/application resources.");
    const values = new Map();
    for (const item of plan.resource_changes) {
        check(item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" && !item.previous_address && !item.change.importing, "provider/move/import.");
        const expected = alerts && FOUNDATION_RESOURCES.includes(item.address) ? "no-op" : "create";
        check(equal(item.change.actions, [expected]) && (expected === "create" ? item.change.before === null : equal(item.change.before, item.change.after)), "creation-only selected stage; partial prior runs need recovery review.");
        values.set(item.address, item.change.after);
    }
    const value = address => values.get(address);
    for (const address of FOUNDATION_RESOURCES.filter(name => name.startsWith("aws_s3_")))
        check(value(address).bucket === BUCKET, "exact Production release bucket.");
    check(value("aws_s3_bucket.releases").force_destroy === false, "no destructive bucket teardown.");
    const access = value("aws_s3_bucket_public_access_block.releases");
    check(["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"].every(key => access[key] === true), "private bucket.");
    check(value("aws_s3_bucket_versioning.releases").versioning_configuration?.[0]?.status === "Enabled" &&
        value("aws_s3_bucket_ownership_controls.releases").rule?.[0]?.object_ownership === "BucketOwnerEnforced" &&
        value("aws_s3_bucket_server_side_encryption_configuration.releases").rule?.[0]?.apply_server_side_encryption_by_default?.[0]?.sse_algorithm === "AES256" &&
        equal(JSON.parse(value("aws_s3_bucket_policy.releases").policy), releaseBucketPolicy()), "encryption/versioning/owner/TLS/retention.");
    for (const [address, suffix, retention] of [["aws_sqs_queue.failures", "failures", 86400], ["aws_sqs_queue.failure_dead_letter", "failures-dead-letter", 1209600]]) {
        const queue = value(address);
        check(queue.name === `${NAME}-${suffix}` && queue.sqs_managed_sse_enabled === true && queue.message_retention_seconds === retention &&
            !queue.policy && !queue.kms_master_key_id && queue.fifo_queue !== true, "private encrypted failure queues.");
    }
    const queue = value("aws_sqs_queue.failures");
    check(queue.visibility_timeout_seconds === 180 && equal(JSON.parse(queue.redrive_policy), { deadLetterTargetArn: arn("sqs", `${NAME}-failures-dead-letter`), maxReceiveCount: 5 }), "bounded failure redrive.");
    for (const [address, suffix] of [["aws_cloudwatch_log_group.renderer", ""], ["aws_cloudwatch_log_group.failures", "-failures"]]) {
        check(value(address).name === `/aws/lambda/${NAME}${suffix}` && value(address).retention_in_days === 14, "bounded exact runtime logs.");
    }
    if (alerts) {
        check(typeof alertEmail === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail), "private owner email required.");
        const topic = value("aws_sns_topic.alerts[0]"), subscription = value("aws_sns_topic_subscription.email[0]");
        check(topic.name === `${NAME}-alerts` && equal(JSON.parse(topic.policy), alertTopicPolicy()), "only scoped Production alarms may publish.");
        check(subscription.topic_arn === ALERT_ARN && subscription.protocol === "email" && subscription.endpoint === alertEmail && !subscription.endpoint_auto_confirms, "owner email only, confirmation required.");
        for (const [key, [namespace, metric, dimensions, statistic, threshold]] of Object.entries(ALARMS)) {
            const alarm = value(`aws_cloudwatch_metric_alarm.runtime["${key}"]`);
            check(alarm.actions_enabled !== false && !alarm.insufficient_data_actions?.length && !alarm.metric_query?.length && !alarm.extended_statistic, "no disabled, redirected or alternate alarm evaluation.");
            for (const [field, expected] of Object.entries({ alarm_name: `${NAME}-${key}`, namespace, metric_name: metric, dimensions, statistic, threshold,
                period: 60, evaluation_periods: 1, comparison_operator: "GreaterThanOrEqualToThreshold", treat_missing_data: "notBreaching", alarm_actions: [ALERT_ARN], ok_actions: [ALERT_ARN] }))
                check(equal(alarm[field], expected), `alarm ${key}/${field}.`);
        }
    }
    return { environment: "production", stage: operation, creates: alerts ? ALERT_RESOURCES : FOUNDATION_RESOURCES, deletes: 0,
        observations, applicationDeployment: false, alertConfirmationRequired: alerts, firstAndAllReadyMonitoringComplete: false };
}
function verifyFoundationObservations(plan, alerts) {
    check(alerts || !plan.resource_drift?.length, "no drift allowed during initial creation.");
    const seen = new Set(), observations = [];
    const tagParents = ["aws_s3_bucket.releases", "aws_sqs_queue.failures", "aws_sqs_queue.failure_dead_letter", "aws_cloudwatch_log_group.renderer", "aws_cloudwatch_log_group.failures"];
    for (const item of plan.resource_drift ?? []) {
        check(!seen.has(item.address) && item.mode === "managed" && item.provider_name === "registry.terraform.io/hashicorp/aws" &&
            !item.previous_address && !item.change.importing && equal(item.change.actions, ["update"]), "unexpected/duplicate observation.");
        seen.add(item.address);
        const resource = plan.resource_changes.find(value => value.address === item.address);
        const { before, after } = item.change;
        check(resource && equal(resource.change.actions, ["no-op"]) && equal(resource.change.before, after), "observation must leave the existing resource unchanged.");
        const restored = structuredClone(after);
        const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !equal(before[key], after[key]));
        for (const field of fields) {
            if (field === "tags" && tagParents.includes(item.address))
                check(before.tags === null && equal(after.tags, {}), "only null-to-empty explicit tags.");
            else if (item.address === "aws_s3_bucket.releases" && field === "policy") {
                const child = plan.resource_changes.find(value => value.address === "aws_s3_bucket_policy.releases");
                check(before.policy === "" && equal(JSON.parse(after.policy), releaseBucketPolicy()) && equal(child?.change.actions, ["no-op"]) &&
                    equal(JSON.parse(child.change.after.policy), JSON.parse(after.policy)), "only the already-created exact bucket policy child.");
            }
            else if (item.address === "aws_s3_bucket.releases" && field === "versioning") {
                const child = plan.resource_changes.find(value => value.address === "aws_s3_bucket_versioning.releases");
                check(equal(before.versioning, [{ enabled: false, mfa_delete: false }]) && equal(after.versioning, [{ enabled: true, mfa_delete: false }]) &&
                    equal(child?.change.actions, ["no-op"]) && child.change.after.versioning_configuration?.[0]?.status === "Enabled", "only the already-enabled versioning child.");
            }
            else
                check(false, "unreviewed state observation.");
            restored[field] = before[field];
        }
        check(equal(restored, before), "observation changes other fields.");
        observations.push({ address: item.address, fields });
    }
    return observations;
}
