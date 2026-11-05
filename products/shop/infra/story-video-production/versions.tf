terraform {
  required_version = "= 1.12.2"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.62.0"
    }
  }
  backend "s3" {
    bucket              = "forever-tee-terraform-state-{{SHOP:awsAccountId}}-ap-southeast-2"
    key                 = "story-video/production/terraform.tfstate"
    region              = "ap-southeast-2"
    allowed_account_ids = ["{{SHOP:awsAccountId}}"]
    encrypt             = true
    use_lockfile        = true
    kms_key_id          = "arn:aws:kms:ap-southeast-2:{{SHOP:awsAccountId}}:key/{{SHOP:stateKmsKeyId}}"
  }
}

# CI-only module. There is no local authenticated Terraform route to this path.
provider "aws" {
  region                   = "ap-southeast-2"
  shared_config_files      = ["/dev/null"]
  shared_credentials_files = ["/dev/null"]
  allowed_account_ids      = ["{{SHOP:awsAccountId}}"]
  default_tags {
    tags = { Project = "forever-tee", Environment = "production", ManagedBy = "Terraform" }
  }
}
