resource "aws_sqs_queue" "failure_dead_letter" {
  name                      = "${local.name}-failures-dead-letter"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  lifecycle { prevent_destroy = true }
}
resource "aws_sqs_queue" "failures" {
  name                       = "${local.name}-failures"
  sqs_managed_sse_enabled    = true
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 180
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.failure_dead_letter.arn, maxReceiveCount = 5 })
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role_policy" "failure_destination" {
  role = aws_iam_role.runtime.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Action = "sqs:SendMessage", Resource = aws_sqs_queue.failures.arn }] })
}
resource "aws_lambda_function_event_invoke_config" "renderer" {
  count                        = var.image_digest == null ? 0 : 1
  function_name                = aws_lambda_function.renderer[0].function_name
  maximum_event_age_in_seconds = 60
  maximum_retry_attempts       = 0
  destination_config {
    on_failure { destination = aws_sqs_queue.failures.arn }
  }
  depends_on = [aws_iam_role_policy.failure_destination]
}
resource "aws_cloudwatch_log_group" "failure" {
  name              = "/aws/lambda/${local.name}-failures"
  retention_in_days = 14
}
resource "aws_iam_role" "failure" {
  name = "${local.name}-failures"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "failure" {
  role = aws_iam_role.failure.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.failure.arn}:*" },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.failures.arn }
  ] })
}
resource "aws_lambda_function" "failure" {
  count                          = var.image_digest == null ? 0 : 1
  function_name                  = "${local.name}-failures"
  role                           = aws_iam_role.failure.arn
  package_type                   = "Image"
  image_uri                      = "${aws_ecr_repository.renderer.repository_url}@${var.image_digest}"
  architectures                  = ["x86_64"]
  memory_size                    = 128
  timeout                        = 30
  reserved_concurrent_executions = 2
  image_config { command = ["aws-lambda/failure-entry.handler"] }
  environment { variables = { STORY_API_ORIGIN = var.api_origin } }
  depends_on = [aws_iam_role_policy.failure]
  lifecycle { prevent_destroy = true }
}
resource "aws_lambda_event_source_mapping" "failures" {
  count                   = var.image_digest == null ? 0 : 1
  event_source_arn        = aws_sqs_queue.failures.arn
  function_name           = aws_lambda_function.failure[0].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config { maximum_concurrency = 2 }
}
