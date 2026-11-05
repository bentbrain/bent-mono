# Build only in CodeBuild. This preserves the production Debian/Canvas stack.
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
ARG STORY_IMAGE_BUILD_ID
ENV STORY_IMAGE_BUILD_ID=${STORY_IMAGE_BUILD_ID}
ENV NPM_CONFIG_CACHE=/tmp/.npm
ENTRYPOINT ["/bin/sh", "/function/aws-lambda/bootstrap.sh"]
CMD ["aws-lambda/entry.handler"]
