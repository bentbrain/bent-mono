# Design sketch only. This is NOT a bootstrap module or usable backend config.
# versions.tf still uses local state; the personal runner forbids backend
# overrides. Do not replace it or migrate state before owner approval.
#
# Proposed backend fields after an approved bootstrap and verified migration:
# bucket              = "forever-tee-terraform-state-{{SHOP:awsAccountId}}-ap-southeast-2"
# key                 = "story-video/development/terraform.tfstate"
# region              = "ap-southeast-2"
# allowed_account_ids = ["{{SHOP:awsAccountId}}"]
# use_lockfile        = true
# encrypt             = true
# kms_key_id          = "<approved personal-account Sydney state-key ARN>"
#
# Bucket ownership, versioning, public-access blocking, TLS and KMS policies,
# state/lock permissions and lock contention must be verified separately.
# Development and Production need separate keys AND separately scoped roles.
# Keep all existing local state and backups; never restore state to roll back code.
# See docs/native-lambda-release-audit-2026-08-28.md for the remaining work.
