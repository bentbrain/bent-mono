locals {
  name    = "forever-tee-video-production"
  bucket  = "forever-tee-video-production-{{SHOP:awsAccountId}}-ap-southeast-2"
  sqs_arn = "arn:aws:sqs:ap-southeast-2:{{SHOP:awsAccountId}}"
}

resource "aws_s3_bucket" "releases" {
  bucket        = local.bucket
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "releases" {
  bucket                  = local.bucket
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
  depends_on              = [aws_s3_bucket.releases]
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "releases" {
  bucket = local.bucket
  versioning_configuration { status = "Enabled" }
  depends_on = [aws_s3_bucket.releases]
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_ownership_controls" "releases" {
  bucket = local.bucket
  rule { object_ownership = "BucketOwnerEnforced" }
  depends_on = [aws_s3_bucket.releases]
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "releases" {
  bucket = local.bucket
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
  depends_on = [aws_s3_bucket.releases]
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_policy" "releases" {
  bucket = local.bucket
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid      = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
      Resource = ["arn:aws:s3:::${local.bucket}", "arn:aws:s3:::${local.bucket}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    { Sid = "RetainReleaseEvidence", Effect = "Deny", Principal = "*",
    Action = ["s3:DeleteObject", "s3:DeleteObjectVersion"], Resource = "arn:aws:s3:::${local.bucket}/source/*" }
  ] })
  depends_on = [aws_s3_bucket_public_access_block.releases, aws_s3_bucket_versioning.releases]
  lifecycle { prevent_destroy = true }
}
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
  redrive_policy             = jsonencode({ deadLetterTargetArn = "${local.sqs_arn}:${local.name}-failures-dead-letter", maxReceiveCount = 5 })
  depends_on                 = [aws_sqs_queue.failure_dead_letter]
  lifecycle { prevent_destroy = true }
}
resource "aws_cloudwatch_log_group" "renderer" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 14
  lifecycle { prevent_destroy = true }
}
resource "aws_cloudwatch_log_group" "failures" {
  name              = "/aws/lambda/${local.name}-failures"
  retention_in_days = 14
  lifecycle { prevent_destroy = true }
}
