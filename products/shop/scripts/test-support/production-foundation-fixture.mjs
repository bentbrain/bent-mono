import { FOUNDATION_RESOURCES, ALARMS, ALERT_ARN, releaseBucketPolicy, alertTopicPolicy } from "../native-production-foundation-contract.mjs";
import { PRODUCTION_NAME as NAME, PRODUCTION_BUCKET as BUCKET, productionArn as arn } from "../native-production-permissions.mjs";

export function fixture(alerts = false) {
  const values = {
    "aws_s3_bucket.releases": { bucket: BUCKET, force_destroy: false },
    "aws_s3_bucket_public_access_block.releases": { bucket: BUCKET, block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true },
    "aws_s3_bucket_versioning.releases": { bucket: BUCKET, versioning_configuration: [{ status: "Enabled" }] },
    "aws_s3_bucket_ownership_controls.releases": { bucket: BUCKET, rule: [{ object_ownership: "BucketOwnerEnforced" }] },
    "aws_s3_bucket_server_side_encryption_configuration.releases": { bucket: BUCKET, rule: [{ apply_server_side_encryption_by_default: [{ sse_algorithm: "AES256" }] }] },
    "aws_s3_bucket_policy.releases": { bucket: BUCKET, policy: JSON.stringify(releaseBucketPolicy()) },
    "aws_sqs_queue.failures": { name: `${NAME}-failures`, sqs_managed_sse_enabled: true, message_retention_seconds: 86400, visibility_timeout_seconds: 180,
      redrive_policy: JSON.stringify({ deadLetterTargetArn: arn("sqs", `${NAME}-failures-dead-letter`), maxReceiveCount: 5 }) },
    "aws_sqs_queue.failure_dead_letter": { name: `${NAME}-failures-dead-letter`, sqs_managed_sse_enabled: true, message_retention_seconds: 1209600 },
    "aws_cloudwatch_log_group.renderer": { name: `/aws/lambda/${NAME}`, retention_in_days: 14 },
    "aws_cloudwatch_log_group.failures": { name: `/aws/lambda/${NAME}-failures`, retention_in_days: 14 },
  };
  if (alerts) {
    values["aws_sns_topic.alerts[0]"] = { name: `${NAME}-alerts`, policy: JSON.stringify(alertTopicPolicy()) };
    values["aws_sns_topic_subscription.email[0]"] = { topic_arn: ALERT_ARN, protocol: "email", endpoint: "owner@example.com" };
    for (const [key, [namespace, metric_name, dimensions, statistic, threshold]] of Object.entries(ALARMS)) {
      values[`aws_cloudwatch_metric_alarm.runtime["${key}"]`] = { alarm_name: `${NAME}-${key}`, namespace, metric_name, dimensions, statistic, threshold,
        period: 60, evaluation_periods: 1, comparison_operator: "GreaterThanOrEqualToThreshold", treat_missing_data: "notBreaching", alarm_actions: [ALERT_ARN], ok_actions: [ALERT_ARN] };
    }
  }
  return { terraform_version: "1.12.2", complete: true, errored: false, output_changes: {}, resource_changes: Object.entries(values).map(([address, after]) => {
    const unchanged = alerts && FOUNDATION_RESOURCES.includes(address);
    return { address, mode: "managed", provider_name: "registry.terraform.io/hashicorp/aws", change: { actions: [unchanged ? "no-op" : "create"], before: unchanged ? structuredClone(after) : null, after } };
  }) };
}
