# Reuse the deployed Node/FFmpeg/font versions to isolate Canvas and filter order.
FROM registry.cloudflare.com/86ff820ef99c8f2a035eb3ab03ce095a/forever-tee-story-video-storyvideocontainer-production@sha256:503001cb202bbc4ee7dc9611f1d209d898e0f88a5f6d75ab60f0ba7ff21d9d3e
ARG CANVAS_VERSION=0.1.80
RUN if [ "$CANVAS_VERSION" != "0.1.80" ]; then \
      mkdir /canvas-candidate && cd /canvas-candidate && \
      npm install --omit=dev --ignore-scripts --save-exact "@napi-rs/canvas@$CANVAS_VERSION" && \
      ln -sfn /canvas-candidate/node_modules/@napi-rs/canvas /app/node_modules/@napi-rs/canvas; \
    fi
COPY src /app/src
RUN node --test src/*.test.mjs
