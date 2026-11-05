variable "image_digest" {
  type = string
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "Supply the independently verified immutable image digest."
  }
}
variable "source_digest" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.source_digest))
    error_message = "Supply the verified source-manifest digest."
  }
}
locals {
  image_uri  = "{{SHOP:awsAccountId}}.dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development@${var.image_digest}"
  api_origin = "https://forever-tee-api.socialqueue.workers.dev"
}

# Mapping creation is constrained by FunctionArn. Do not inherit default tags
# and consequently request permission to tag arbitrary mapping ARNs.
provider "aws" {
  alias                    = "failure_mapping"
  region                   = "ap-southeast-2"
  shared_config_files      = ["/dev/null"]
  shared_credentials_files = ["/dev/null"]
  allowed_account_ids      = ["{{SHOP:awsAccountId}}"]
}

resource "aws_lambda_function" "renderer" {
  function_name                  = local.name
  role                           = "arn:aws:iam::{{SHOP:awsAccountId}}:role/${local.name}-runtime"
  package_type                   = "Image"
  image_uri                      = local.image_uri
  architectures                  = ["x86_64"]
  memory_size                    = 3008
  timeout                        = 120
  reserved_concurrent_executions = 8
  ephemeral_storage { size = 1024 }
  environment {
    variables = { STORY_BUILD_ID = var.source_digest, STORY_API_ORIGIN = local.api_origin, STORY_DEPLOYMENT_ENV = "production" }
  }
  logging_config {
    log_format = "Text"
    log_group  = "/aws/lambda/${local.name}"
  }
  depends_on = [aws_cloudwatch_log_group.renderer]
  lifecycle { prevent_destroy = true }
}
resource "aws_lambda_function" "failures" {
  function_name                  = "${local.name}-failures"
  role                           = "arn:aws:iam::{{SHOP:awsAccountId}}:role/${local.name}-failures"
  package_type                   = "Image"
  image_uri                      = local.image_uri
  architectures                  = ["x86_64"]
  memory_size                    = 128
  timeout                        = 30
  reserved_concurrent_executions = 2
  ephemeral_storage { size = 512 }
  image_config { command = ["aws-lambda/failure-entry.handler"] }
  environment {
    variables = { STORY_API_ORIGIN = local.api_origin, STORY_DEPLOYMENT_ENV = "production" }
  }
  logging_config {
    log_format = "Text"
    log_group  = "/aws/lambda/${local.name}-failures"
  }
  depends_on = [aws_cloudwatch_log_group.failures]
  lifecycle { prevent_destroy = true }
}
resource "aws_lambda_function_event_invoke_config" "renderer" {
  function_name                = local.name
  maximum_event_age_in_seconds = 60
  maximum_retry_attempts       = 0
  destination_config {
    on_failure { destination = "${local.sqs_arn}:${local.name}-failures" }
  }
  depends_on = [aws_lambda_function.renderer, aws_sqs_queue.failures]
  lifecycle { prevent_destroy = true }
}
resource "aws_lambda_event_source_mapping" "failures" {
  provider                           = aws.failure_mapping
  event_source_arn                    = "${local.sqs_arn}:${local.name}-failures"
  function_name                       = "arn:aws:lambda:ap-southeast-2:{{SHOP:awsAccountId}}:function:${local.name}-failures"
  enabled                            = true
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
  depends_on = [aws_lambda_function.failures, aws_sqs_queue.failures]
  lifecycle { prevent_destroy = true }
}
