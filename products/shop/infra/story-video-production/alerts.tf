variable "enable_alerts" {
  type    = bool
  default = false
}
variable "alert_email" {
  type      = string
  default   = ""
  sensitive = true
  validation {
    condition     = var.alert_email == "" || can(regex("^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$", var.alert_email))
    error_message = "Use the owner's confirmed alert destination from the Production secret."
  }
}
locals {
  alert_arn = "arn:aws:sns:ap-southeast-2:{{SHOP:awsAccountId}}:${local.name}-alerts"
  alarms = {
    renderer_errors    = { namespace = "AWS/Lambda", metric = "Errors", dimensions = { FunctionName = local.name }, statistic = "Sum", threshold = 1 }
    renderer_throttles = { namespace = "AWS/Lambda", metric = "Throttles", dimensions = { FunctionName = local.name }, statistic = "Sum", threshold = 1 }
    async_age          = { namespace = "AWS/Lambda", metric = "AsyncEventAge", dimensions = { FunctionName = local.name }, statistic = "Maximum", threshold = 30000 }
    failure_errors     = { namespace = "AWS/Lambda", metric = "Errors", dimensions = { FunctionName = "${local.name}-failures" }, statistic = "Sum", threshold = 1 }
    failure_queue_age  = { namespace = "AWS/SQS", metric = "ApproximateAgeOfOldestMessage", dimensions = { QueueName = "${local.name}-failures" }, statistic = "Maximum", threshold = 60 }
    dead_letters       = { namespace = "AWS/SQS", metric = "ApproximateNumberOfMessagesVisible", dimensions = { QueueName = "${local.name}-failures-dead-letter" }, statistic = "Maximum", threshold = 1 }
    delivery_failures  = { namespace = "AWS/SNS", metric = "NumberOfNotificationsFailed", dimensions = { TopicName = "${local.name}-alerts" }, statistic = "Sum", threshold = 1 }
  }
}
resource "aws_sns_topic" "alerts" {
  count = var.enable_alerts ? 1 : 0
  name  = "${local.name}-alerts"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid    = "ProductionCloudWatchAlarmsOnly", Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" },
    Action = "sns:Publish", Resource = local.alert_arn,
    Condition = { StringEquals = { "aws:SourceAccount" = "{{SHOP:awsAccountId}}" }, ArnLike = {
      "aws:SourceArn" = "arn:aws:cloudwatch:ap-southeast-2:{{SHOP:awsAccountId}}:alarm:${local.name}-*"
    } }
  }] })
  lifecycle { prevent_destroy = true }
}
resource "aws_sns_topic_subscription" "email" {
  count      = var.enable_alerts ? 1 : 0
  topic_arn  = local.alert_arn
  protocol   = "email"
  endpoint   = var.alert_email
  depends_on = [aws_sns_topic.alerts]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.alert_email != ""
      error_message = "An owner-supplied private email is required before alert provisioning."
    }
  }
}
resource "aws_cloudwatch_metric_alarm" "runtime" {
  for_each            = var.enable_alerts ? local.alarms : {}
  alarm_name          = "${local.name}-${each.key}"
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  threshold           = each.value.threshold
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.alert_arn]
  ok_actions          = [local.alert_arn]
  depends_on          = [aws_sns_topic.alerts]
  lifecycle { prevent_destroy = true }
}
