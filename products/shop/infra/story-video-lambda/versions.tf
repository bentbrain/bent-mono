terraform {
  required_version = ">= 1.12.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.62.0"
    }
  }
  # Initialized only after the guarded, conditional-copy migration. Credentials
  # come from the personal runner or a verified temporary Actions identity.
  backend "s3" {
    bucket              = "forever-tee-terraform-state-{{SHOP:awsAccountId}}-ap-southeast-2"
    key                 = "story-video/development/terraform.tfstate"
    region              = "ap-southeast-2"
    allowed_account_ids = ["{{SHOP:awsAccountId}}"]
    encrypt             = true
    use_lockfile        = true
    kms_key_id          = "arn:aws:kms:ap-southeast-2:{{SHOP:awsAccountId}}:key/{{SHOP:stateKmsKeyId}}"
  }
}
variable "ci_execution" {
  type    = bool
  default = false
}
provider "aws" {
  region                   = "ap-southeast-2"
  profile                  = var.ci_execution ? null : "personal-dev"
  shared_config_files      = var.ci_execution ? ["/dev/null"] : [abspath("../../.data/aws-personal/config")]
  shared_credentials_files = ["/dev/null"]
  allowed_account_ids      = ["{{SHOP:awsAccountId}}"]
  default_tags {
    tags = { Project = "forever-tee", Environment = "development", ManagedBy = "Terraform" }
  }
}
