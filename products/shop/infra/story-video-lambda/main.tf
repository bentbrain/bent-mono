locals {
  name    = "forever-tee-video-development"
  account = "{{SHOP:awsAccountId}}"
  region  = "ap-southeast-2"
  arn     = "arn:aws:lambda:${local.region}:${local.account}:function:${local.name}"
}
variable "image_digest" {
  type     = string
  default  = null
  nullable = true
  validation {
    condition     = var.image_digest == null ? true : can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "Use an immutable ECR image digest."
  }
}
variable "build_id" {
  type    = string
  default = ""
  validation {
    condition     = var.build_id == "" || can(regex("^[0-9a-f]{64}$", var.build_id))
    error_message = "The source manifest hash is required."
  }
}
variable "api_origin" {
  type    = string
  default = ""
  validation {
    condition     = var.api_origin == "" || can(regex("^https://forever-tee-api-development\\.[a-z0-9-]+\\.workers\\.dev$", var.api_origin))
    error_message = "Only the development API Worker origin is allowed."
  }
}
resource "aws_ecr_repository" "renderer" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket" "source" {
  bucket = "${local.name}-${local.account}-${local.region}"
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "source" {
  bucket                  = aws_s3_bucket.source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "source" {
  bucket = aws_s3_bucket.source.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_versioning" "source" {
  bucket = aws_s3_bucket.source.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_policy" "source_tls" {
  bucket = aws_s3_bucket.source.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*",
  Resource = [aws_s3_bucket.source.arn, "${aws_s3_bucket.source.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 14
}
resource "aws_cloudwatch_log_group" "build" {
  name              = "/aws/codebuild/${local.name}"
  retention_in_days = 7
}
resource "aws_iam_role" "runtime" {
  name = "${local.name}-runtime"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "runtime" {
  role = aws_iam_role.runtime.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
  Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.lambda.arn}:*" }] })
}
resource "aws_iam_role" "build" {
  name = "${local.name}-build"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
    Principal = { Service = "codebuild.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnEquals = {
  "aws:SourceArn" = "arn:aws:codebuild:${local.region}:${local.account}:project/${local.name}" } } }] })
}
resource "aws_iam_role_policy" "build" {
  role = aws_iam_role.build.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.build.arn}:*" },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = "${aws_s3_bucket.source.arn}/source/*" },
    { Effect = "Allow", Action = ["s3:GetBucketLocation", "s3:GetBucketAcl"], Resource = aws_s3_bucket.source.arn },
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
    "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:DescribeImages", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = aws_ecr_repository.renderer.arn }
  ] })
}
resource "aws_codebuild_project" "renderer" {
  name                   = local.name
  service_role           = aws_iam_role.build.arn
  build_timeout          = 20
  queued_timeout         = 10
  concurrent_build_limit = 1
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true
  }
  source {
    type      = "S3"
    location  = "${aws_s3_bucket.source.bucket}/source/awaiting-release.zip"
    buildspec = jsonencode({ version = "0.2", phases = { build = { commands = ["bash aws-lambda/cloud-build-app.sh"] } } })
  }
  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.build.name
      status     = "ENABLED"
    }
  }
}
resource "aws_lambda_function" "renderer" {
  count                          = var.image_digest == null ? 0 : 1
  function_name                  = local.name
  role                           = aws_iam_role.runtime.arn
  package_type                   = "Image"
  image_uri                      = "${aws_ecr_repository.renderer.repository_url}@${var.image_digest}"
  architectures                  = ["x86_64"]
  memory_size                    = 3008
  timeout                        = 120
  reserved_concurrent_executions = 8
  ephemeral_storage { size = 1024 }
  environment {
    variables = { STORY_BUILD_ID = var.build_id, STORY_API_ORIGIN = var.api_origin }
  }
  depends_on = [aws_iam_role_policy.runtime]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.build_id != "" && var.api_origin != ""
      error_message = "Set the verified build hash and development API origin before creating Lambda."
    }
  }
}
# This identity has no console login or storage access. Provision its key into
# Cloudflare secrets separately, never as aws_iam_access_key in Terraform state.
resource "aws_iam_user" "invoker" { name = "${local.name}-invoker" }
resource "aws_iam_user_policy" "invoke" {
  user   = aws_iam_user.invoker.name
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = local.arn }] })
}
