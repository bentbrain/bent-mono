# The existing personal account OIDC provider is read only, never managed/imported.
data "aws_iam_openid_connect_provider" "github" {
  arn = "arn:aws:iam::{{SHOP:awsAccountId}}:oidc-provider/token.actions.githubusercontent.com"
}

locals {
  release_permissions = jsondecode(file("${path.module}/development-release-policy.json"))
  ci_permissions = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ListExactDevelopmentStateAndLock", Effect = "Allow", Action = "s3:ListBucket",
        Resource  = "arn:aws:s3:::${local.bucket}",
        Condition = { StringEquals = { "s3:prefix" = [local.state_key, "${local.state_key}.tflock"] } }
      },
      {
        Sid      = "ReadStateBucketConfiguration", Effect = "Allow",
        Action   = ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration", "s3:GetBucketPublicAccessBlock"],
        Resource = "arn:aws:s3:::${local.bucket}"
      },
      {
        Sid      = "DevelopmentStateOnly", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"],
        Resource = local.state_arn
      },
      {
        Sid      = "DevelopmentLockOnly", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource = local.lock_arn
      },
      {
        Sid      = "StateEncryptionThroughSydneyS3Only", Effect = "Allow",
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
        Resource = "arn:aws:kms:${local.region}:${local.account}:key/*",
        Condition = {
          StringEquals = {
            "kms:ViaService"                   = "s3.${local.region}.amazonaws.com"
            "kms:CallerAccount"                = local.account
            "kms:EncryptionContext:aws:s3:arn" = [local.state_arn, local.lock_arn]
          }
          "ForAnyValue:StringEquals" = { "kms:ResourceAliases" = local.kms_alias }
        }
      },
      {
        Sid    = "InspectDevelopmentFunctions", Effect = "Allow",
        Action = ["lambda:GetFunctionConfiguration", "lambda:GetFunctionConcurrency", "lambda:GetFunctionEventInvokeConfig"],
        Resource = [
          "arn:aws:lambda:${local.region}:${local.account}:function:forever-tee-video-development",
          "arn:aws:lambda:${local.region}:${local.account}:function:forever-tee-video-development-failures"
        ]
      },
      {
        Sid      = "InspectDevelopmentImages", Effect = "Allow", Action = ["ecr:DescribeImages", "ecr:DescribeRepositories"],
        Resource = "arn:aws:ecr:${local.region}:${local.account}:repository/forever-tee-video-development"
      },
      {
        # BatchGetBuilds authorizes against its project, not individual build ARNs.
        Sid      = "InspectDevelopmentBuilds", Effect = "Allow", Action = "codebuild:BatchGetBuilds",
        Resource = "arn:aws:codebuild:${local.region}:${local.account}:project/forever-tee-video-development"
      }
    ]
  }
}

resource "aws_iam_policy" "ci_boundary" {
  name        = "${local.ci_name}-boundary"
  # IAM policy descriptions are immutable. Retain the original description to
  # update permissions in place without replacing the attached boundary.
  description = "Development state and inspection ceiling; no workload mutation or IAM permissions"
  policy      = jsonencode(local.release_permissions)
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role" "ci" {
  name                 = local.ci_name
  description          = "Protected Preview with verified personal repository OIDC; state and inspection only"
  max_session_duration = 3600
  permissions_boundary = aws_iam_policy.ci_boundary.arn
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [
    {
      Sid       = "ExactPersonalRepositoryPreview", Effect = "Allow", Action = "sts:AssumeRoleWithWebIdentity",
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn },
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub" = local.ci_subject
      } }
    }
  ] })
  lifecycle {
    prevent_destroy = true
    precondition {
      condition = (
        data.aws_iam_openid_connect_provider.github.url == "token.actions.githubusercontent.com" &&
        contains(data.aws_iam_openid_connect_provider.github.client_id_list, "sts.amazonaws.com")
      )
      error_message = "The existing personal GitHub provider must have the exact issuer and STS audience."
    }
  }
}

resource "aws_iam_role_policy" "ci" {
  name   = "development-state-and-inspection"
  role   = aws_iam_role.ci.id
  policy = jsonencode(local.release_permissions)
  lifecycle { prevent_destroy = true }
}

output "ci_role_arn" { value = aws_iam_role.ci.arn }
# Signed Preview token verified in Actions run {{SHOP:resource_5dafa3f50f08}}, source 3dfcf57d.
# Preview allows only main and perf/story-video-family-experiments branch refs.
output "ci_assumption_enabled" { value = true }
