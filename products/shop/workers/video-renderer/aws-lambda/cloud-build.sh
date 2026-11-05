#!/usr/bin/env bash
set -euo pipefail

# Never run AWS commands from a developer shell or inherit local profiles here.
case "${CODEBUILD_BUILD_ARN:-}" in
  arn:aws:codebuild:ap-southeast-2:${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}:build/forever-tee-video-bench:*) ;;
  *) echo 'This script runs only in the isolated personal CodeBuild project.' >&2; exit 1 ;;
esac
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ENDPOINT_URL AWS_ENDPOINT_URL_STS AWS_ENDPOINT_URL_ECR
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true AWS_EC2_METADATA_DISABLED=true AWS_PAGER=''
export AWS_DEFAULT_REGION=ap-southeast-2 AWS_REGION=ap-southeast-2

account=$(aws sts get-caller-identity --region ap-southeast-2 --query Account --output text)
caller=$(aws sts get-caller-identity --region ap-southeast-2 --query Arn --output text)
test "$account" = "${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}"
case "$caller" in
  arn:aws:sts::${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}:assumed-role/forever-tee-video-bench-build/*) ;;
  *) echo 'Unexpected cloud build role.' >&2; exit 1 ;;
esac

export SHOP_PROTECTED_CONFIG_JSON="$(node -e 'process.stdout.write(JSON.stringify({awsAccountId:process.env.SHOP_AWS_ACCOUNT_ID}))')"
node aws-lambda/verify-bundle.mjs
repository="${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}.dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-bench"
registry="${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}.dkr.ecr.ap-southeast-2.amazonaws.com"
tag="source-${SOURCE_DIGEST}"
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin "$registry"
trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT
docker buildx build --platform linux/amd64 --provenance=false --load --build-arg "STORY_IMAGE_BUILD_ID=$SOURCE_DIGEST" -f aws-lambda/Dockerfile -t "$repository:$tag" .
# Compile/import checks and contract tests only. No customer data or encoding in this build.
docker run --rm --env SHOP_PROTECTED_CONFIG_JSON --entrypoint node "$repository:$tag" --test --test-concurrency=1 aws-lambda/handler.test.mjs aws-lambda/storage.test.mjs
docker run --rm --env SHOP_PROTECTED_CONFIG_JSON --entrypoint node "$repository:$tag" --input-type=module -e 'await import("./src/renderer.mjs"); await import("./aws-lambda/entry.mjs"); console.log("Renderer and Lambda entry loaded")'
docker run --rm --env SHOP_PROTECTED_CONFIG_JSON --network none --entrypoint node "$repository:$tag" aws-lambda/runtime-smoke.mjs
docker run --rm --env SHOP_PROTECTED_CONFIG_JSON --entrypoint ffmpeg "$repository:$tag" -version
docker push "$repository:$tag"
aws ecr describe-images --region ap-southeast-2 --repository-name forever-tee-video-bench --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text
