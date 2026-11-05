terraform {
  required_version = ">= 1.12.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.62.0"
    }
  }
  # Separate from workload state; Development CI cannot access this key.
  # Initialization requires the guarded one-time bootstrap-state migration.
  backend "s3" {
    bucket              = "forever-tee-terraform-state-{{SHOP:awsAccountId}}-ap-southeast-2"
    key                 = "story-video/bootstrap/terraform.tfstate"
    region              = "ap-southeast-2"
    encrypt             = true
    use_lockfile        = true
    kms_key_id          = "arn:aws:kms:ap-southeast-2:{{SHOP:awsAccountId}}:key/{{SHOP:stateKmsKeyId}}"
    allowed_account_ids = ["{{SHOP:awsAccountId}}"]
  }
}

provider "aws" {
  region                   = "ap-southeast-2"
  profile                  = "personal-dev"
  shared_config_files      = [abspath("../../.data/aws-personal/config")]
  shared_credentials_files = ["/dev/null"]
  allowed_account_ids      = ["{{SHOP:awsAccountId}}"]
  default_tags {
    tags = { Project = "forever-tee", Environment = "development", ManagedBy = "Terraform", Purpose = "video-state-bootstrap" }
  }
}
