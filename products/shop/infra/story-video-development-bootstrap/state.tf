locals {
  account   = "{{SHOP:awsAccountId}}"
  region    = "ap-southeast-2"
  bucket    = "forever-tee-terraform-state-{{SHOP:awsAccountId}}-ap-southeast-2"
  state_key = "story-video/development/terraform.tfstate"
  state_arn = "arn:aws:s3:::${local.bucket}/${local.state_key}"
  lock_arn  = "${local.state_arn}.tflock"
  kms_alias = "alias/forever-tee-video-development-state"
  ci_name   = "forever-tee-video-development-ci"
  ci_arn    = "arn:aws:iam::${local.account}:role/${local.ci_name}"
  # Read from the repository's OIDC customization API, not guessed from its name.
  ci_subject = "repo:bentbrain@{{SHOP:githubOwnerId}}/bent-mono@{{SHOP:githubRepositoryId}}:environment:Preview"
}

resource "aws_kms_key" "state" {
  description             = "Development story-video Terraform state and lock encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  multi_region            = false
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "PersonalAccountKeyAdministration"
    Effect    = "Allow"
    Principal = { AWS = "arn:aws:iam::${local.account}:root" }
    Action    = "kms:*"
    Resource  = "*"
  }] })
  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "state" {
  name          = local.kms_alias
  target_key_id = aws_kms_key.state.key_id
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket" "state" {
  bucket        = local.bucket
  force_destroy = false
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule { object_ownership = "BucketOwnerEnforced" }
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    # Keep the object ARN as the KMS encryption context for exact-key CI scope.
    bucket_key_enabled = false
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
  }
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    {
      Sid       = "RequireTLS", Effect = "Deny", Principal = "*", Action = "s3:*",
      Resource  = ["arn:aws:s3:::${local.bucket}", "arn:aws:s3:::${local.bucket}/*"],
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    },
    {
      Sid       = "RequireKMSOnWrites", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
      Resource  = "arn:aws:s3:::${local.bucket}/*",
      Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" } }
    },
    {
      Sid       = "RequireThisStateKey", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
      Resource  = "arn:aws:s3:::${local.bucket}/*",
      Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.state.arn } }
    },
    {
      Sid    = "RetainDevelopmentStateVersions", Effect = "Deny", Principal = "*",
      Action = ["s3:DeleteObject", "s3:DeleteObjectVersion"], Resource = local.state_arn
    },
    {
      Sid         = "CICannotReadOrWriteOtherObjects", Effect = "Deny", Principal = "*",
      Action      = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"],
      NotResource = [local.state_arn, local.lock_arn],
      Condition   = { ArnEquals = { "aws:PrincipalArn" = local.ci_arn } }
    },
    {
      Sid = "RetainProductionStateVersions", Effect = "Deny", Principal = "*",
      Action = ["s3:DeleteObject", "s3:DeleteObjectVersion"], Resource = local.production_state_arn
    },
    {
      Sid = "ProductionCICannotAccessOtherState", Effect = "Deny", Principal = "*",
      Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"],
      NotResource = [local.production_state_arn, "${local.production_state_arn}.tflock"],
      Condition = { ArnEquals = { "aws:PrincipalArn" = local.production_ci_arn } }
    }
  ] })
  depends_on = [aws_s3_bucket_public_access_block.state, aws_s3_bucket_versioning.state, aws_s3_bucket_server_side_encryption_configuration.state]
  lifecycle { prevent_destroy = true }
}

output "development_backend" {
  description = "Use only after reviewed state migration; does not switch the renderer backend."
  value = {
    bucket              = local.bucket, key = local.state_key, region = local.region,
    allowed_account_ids = [local.account], encrypt = true, use_lockfile = true,
    kms_key_id          = aws_kms_key.state.arn
  }
}
