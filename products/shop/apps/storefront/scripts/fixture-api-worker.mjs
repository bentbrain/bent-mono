import business from "../../../workers/api/src/index.ts";
import { StoryVideoNotifications } from "../../../workers/api/src/story-video-notifications.ts";
import { PrintAssetExecution as PrintExecution } from "../../../workers/api/src/print-execution-object.ts";
import { Effect } from "effect";

export { StoryVideoNotifications };
export { StoryVideoService } from "../../../workers/video-renderer/src/worker.mjs";
export class PrintAssetExecution extends PrintExecution {
  constructor(state, env) {
    super(state, adapt(env));
  }
}

function bytes64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
async function stream64(stream) {
  return bytes64(new Uint8Array(await new Response(stream).arrayBuffer()));
}
class FixtureImage {
  constructor(source) {
    this.source = stream64(source);
    this.steps = [];
  }
  transform(options) {
    this.steps.push({ transform: options });
    return this;
  }
  draw(source, options) {
    this.steps.push({
      draw: source instanceof FixtureImage ? source : new FixtureImage(source),
      options,
    });
    return this;
  }
  async serialize() {
    return {
      source: await this.source,
      steps: await Promise.all(
        this.steps.map(async (step) =>
          step.draw
            ? { draw: await step.draw.serialize(), options: step.options }
            : step,
        ),
      ),
    };
  }
  async output(options) {
    const response = await fetch(
      "https://fixture-services.invalid/images/output",
      {
        method: "POST",
        body: JSON.stringify({ image: await this.serialize(), options }),
      },
    );
    return { response: () => response };
  }
}
function adapt(env) {
  return {
    ...env,
    DB: env.DB,
    IMAGES: {
      input: (stream) => new FixtureImage(stream),
      info: async (stream) =>
        (
          await fetch("https://fixture-services.invalid/images/info", {
            method: "POST",
            body: await new Response(stream).arrayBuffer(),
          })
        ).json(),
    },
    SAFETY_SCREENING: {
      screen: () =>
        Effect.succeed({
          decision: "allowed",
          model: "synthetic-boundary-fixture",
        }),
    },
    PRODUCT_COLOR_ANALYSIS: {
      analyze: () =>
        Effect.succeed({ color: "Black", model: "synthetic-boundary-fixture" }),
    },
    OWNER_MUTATION_RATE_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_PROCESS_RATE_LIMIT: { limit: async () => ({ success: true }) },
    LEGACY_IMAGE_PROCESS_RATE_LIMIT: { limit: async () => ({ success: true }) },
    LEGACY_MUTATION_RATE_LIMIT: { limit: async () => ({ success: true }) },
    PRINT_ASSET_JOBS: {
      send: async (message) => {
        const response = await fetch(
          "https://fixture-services.invalid/queue/print",
          { method: "POST", body: JSON.stringify(message) },
        );
        if (!response.ok) throw new Error("Local queue failed");
      },
    },
    STORY_VIDEO_JOBS: {
      send: async (message) => {
        const response = await fetch(
          "https://fixture-services.invalid/queue/video",
          { method: "POST", body: JSON.stringify(message) },
        );
        if (!response.ok) throw new Error("Local queue failed");
      },
    },
  };
}
export default {
  async fetch(request, env, context) {
    const response = await business.fetch(request, adapt(env), context);
    const path = new URL(request.url).pathname;
    if (
      path.startsWith("/v2/internal/product-image-jobs/") &&
      response.ok &&
      (response.headers.has("x-image-recipe") || path.endsWith("/artwork"))
    ) {
      const observed = await fetch(
        "https://fixture-services.invalid/observations/native-input",
        {
          method: "POST",
          headers: {
            "x-proof-source-path": path,
            "x-image-source-sha256":
              response.headers.get("x-image-source-sha256") ?? "",
            "x-image-recipe": response.headers.get("x-image-recipe") ?? "",
          },
          body: await response.clone().arrayBuffer(),
        },
      );
      if (!observed.ok) throw new Error("Native input observation failed");
    }
    return response;
  },
  queue(batch, env, context) {
    return business.queue(batch, adapt(env), context);
  },
  scheduled(event, env, context) {
    return business.scheduled(event, adapt(env), context);
  },
};
