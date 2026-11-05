#!/usr/bin/env bash
set -euo pipefail
case "${CODEBUILD_BUILD_ARN:-}" in
  arn:aws:codebuild:ap-southeast-2:${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}:build/forever-tee-video-development:*) ;;
  *) echo 'Only the personal development CodeBuild project may run this script.' >&2; exit 1 ;;
esac
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ENDPOINT_URL AWS_ENDPOINT_URL_STS AWS_ENDPOINT_URL_ECR
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true AWS_EC2_METADATA_DISABLED=true AWS_PAGER=''
export AWS_DEFAULT_REGION=ap-southeast-2 AWS_REGION=ap-southeast-2
account=$(aws sts get-caller-identity --region ap-southeast-2 --query Account --output text)
caller=$(aws sts get-caller-identity --region ap-southeast-2 --query Arn --output text)
test "$account" = "${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}"
case "$caller" in
  arn:aws:sts::${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}:assumed-role/forever-tee-video-development-build/*) ;;
  *) echo 'Unexpected cloud build role.' >&2; exit 1 ;;
esac
export SHOP_PROTECTED_CONFIG_JSON="$(node -e 'process.stdout.write(JSON.stringify({awsAccountId:process.env.SHOP_AWS_ACCOUNT_ID}))')"
node aws-lambda/verify-bundle.mjs
repository="${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}.dkr.ecr.ap-southeast-2.amazonaws.com/forever-tee-video-development"
registry="${SHOP_AWS_ACCOUNT_ID:?Missing protected personal AWS account}.dkr.ecr.ap-southeast-2.amazonaws.com"
tag="source-${SOURCE_DIGEST}"
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin "$registry"
trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT
docker buildx build --platform linux/amd64 --provenance=false --load --build-arg "STORY_IMAGE_BUILD_ID=$SOURCE_DIGEST" --build-arg "SHOP_AWS_ACCOUNT_ID=$SHOP_AWS_ACCOUNT_ID" -f aws-lambda/Dockerfile.app -t "$repository:$tag" .
docker run --rm --user 65532:65532 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --network none --entrypoint node "$repository:$tag" --test --test-concurrency=1 aws-lambda/app-environment.test.mjs aws-lambda/app-handler.test.mjs aws-lambda/failure-entry.test.mjs aws-lambda/product-image-handler.test.mjs
docker run --rm --user 65532:65532 --read-only --network none --entrypoint node "$repository:$tag" --input-type=module -e 'await import("./src/renderer.mjs"); await import("./aws-lambda/app-entry.mjs"); await import("./src/product-image-renderer.mjs"); const {readFile} = await import("node:fs/promises"); const {VARIANTS} = await import("./aws-lambda/config.mjs"); for (const variant of Object.values(VARIANTS)) await readFile(`./product-assets/${variant.file}`); for (const file of ["lifestyle.json", "lifestyle-white.png", "lifestyle-black.png", "featured-mask-white.svg", "featured-mask-black.svg"]) await readFile(`./product-assets/${file}`); console.log("Non-root app imports and all template reads passed")'
docker run --rm --user 65532:65532 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --network none --entrypoint node "$repository:$tag" aws-lambda/runtime-smoke.mjs app
docker run --rm --user 65532:65532 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --network none --entrypoint node "$repository:$tag" aws-lambda/runtime-smoke.mjs failure
docker push "$repository:$tag"
aws ecr describe-images --region ap-southeast-2 --repository-name forever-tee-video-development --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text
