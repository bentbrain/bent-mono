# Build only in the Terraform-managed personal CodeBuild project.
FROM node:24.13.1-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ make cmake unzip xz-utils libcurl4-openssl-dev autoconf automake libtool python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /function
COPY aws-lambda/package.json aws-lambda/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.13.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libcurl4 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /function
COPY --from=dependencies /function/node_modules ./node_modules
COPY aws-lambda/package.json ./package.json
COPY src ./src
COPY aws-lambda ./aws-lambda
COPY product-assets ./product-assets
# Source archives are staged with a private umask. Lambda's default user is not
# root, so normalize only the allowlisted runtime payload inside the image.
# Keep the host archive/private directory permissions unchanged.
RUN chmod 0644 /function/package.json \
    && find /function/src /function/aws-lambda /function/product-assets -type d -exec chmod 0755 {} + \
    && find /function/src /function/aws-lambda /function/product-assets -type f -exec chmod 0644 {} +
ARG SHOP_AWS_ACCOUNT_ID
ENV SHOP_PROTECTED_CONFIG_JSON="{\"awsAccountId\":\"${SHOP_AWS_ACCOUNT_ID}\"}"
RUN node -e 'const value = JSON.parse(process.env.SHOP_PROTECTED_CONFIG_JSON); if (!/^[0-9]{12}$/.test(value.awsAccountId)) process.exit(1)'
ARG STORY_IMAGE_BUILD_ID
ENV STORY_IMAGE_BUILD_ID=${STORY_IMAGE_BUILD_ID}
ENV NPM_CONFIG_CACHE=/tmp/.npm
ENTRYPOINT ["/bin/sh", "/function/aws-lambda/bootstrap.sh"]
CMD ["aws-lambda/app-entry.handler"]
