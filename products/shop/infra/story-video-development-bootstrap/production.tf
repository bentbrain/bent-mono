# Separate Production identity. The verified Production environment allows main
# only. The pending reviewed release ceiling replaces foundation creation writes.
# It can pass only the two Production runtime roles and cannot write IAM.
locals {
  production_name        = "forever-tee-video-production"
  production_ci_arn      = "arn:aws:iam::{{SHOP:awsAccountId}}:role/forever-tee-video-production-ci"
  production_state_arn   = "arn:aws:s3:::${local.bucket}/story-video/production/terraform.tfstate"
  production_permissions = jsondecode(file("${path.module}/production-release-policy.json"))
}

resource "aws_iam_policy" "production_ci_boundary" {
  name        = "${local.production_name}-ci-boundary"
  description = "Production foundation ceiling; no IAM writes or application deployment"
  policy      = jsonencode(local.production_permissions)
  tags        = { Environment = "production" }
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role" "production_ci" {
  name                 = "${local.production_name}-ci"
  description          = "Verified personal repository Production environment; foundation only"
  max_session_duration = 3600
  tags                 = { Environment = "production" }
  permissions_boundary = "arn:aws:iam::{{SHOP:awsAccountId}}:policy/forever-tee-video-production-ci-boundary"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid = "ExactPersonalRepositoryProduction", Effect = "Allow", Action = "sts:AssumeRoleWithWebIdentity",
    Principal = { Federated = "arn:aws:iam::{{SHOP:awsAccountId}}:oidc-provider/token.actions.githubusercontent.com" },
    Condition = { StringEquals = {
      "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub" = "repo:bentbrain@{{SHOP:githubOwnerId}}/bent-mono@{{SHOP:githubRepositoryId}}:environment:Production"
    } }
  }] })
  depends_on = [aws_iam_policy.production_ci_boundary, aws_s3_bucket_policy.state]
  lifecycle { prevent_destroy = true }
}

resource "aws_iam_role_policy" "production_ci" {
  name   = "production-foundation"
  role   = "${local.production_name}-ci"
  policy = jsonencode(local.production_permissions)
  depends_on = [aws_iam_role.production_ci]
  lifecycle { prevent_destroy = true }
}
