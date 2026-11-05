output "function_arn" { value = local.arn }
output "source_bucket" { value = aws_s3_bucket.source.bucket }
output "repository_url" { value = aws_ecr_repository.renderer.repository_url }
output "build_project" { value = aws_codebuild_project.renderer.name }
output "invoker_user" { value = aws_iam_user.invoker.name }
